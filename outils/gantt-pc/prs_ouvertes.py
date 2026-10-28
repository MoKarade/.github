#!/usr/bin/env python3
# prs_ouvertes.py (28/10/2026, tâche .github#679) : chaque PR ouverte de chaque dépôt du relevé, avec sa CI, son état Mergify et le dernier déploiement du dépôt
# -> prs-ouvertes.json, repris par build.py comme champ `prs_ouvertes` de donnees.json (demande de Marc : un onglet « En cours » qui montre tout).
# Règles : 0 $ (lectures GitHub avec ETag, un 304 ne compte pas) ; au plus PLAFOND_APPELS lectures comptées par tour, les PR restantes sont marquées « non lu » ;
# jamais de fake data : une lecture qui échoue s'écrit `erreur`, jamais un « vert » par défaut ; les PR de test que Mergify ouvre pour sa file sont comptées à part.
# Usage : python3 prs_ouvertes.py [sortie.json] [--depots=a,b] [--plafond=n]   (sans --depots : les dépôts du backlog.json du même tour ; sans --plafond : PLAFOND_APPELS)
import datetime, html, json, os, re, sys
from acteurs import BOTS

VERSION = 1
PLAFOND_APPELS = 80
D = os.path.dirname(os.path.abspath(__file__)) + os.sep
MERGIFY_FILE = re.compile(r'^mergify/merge-queue/')           # branche des PR brouillon de test de la file Mergify
NOM_MERGIFY = re.compile(r'^(@?mergify/)?Mergify ', re.I)     # ses contrôles ne sont pas la CI du projet
PAYLOAD = re.compile(r'-\*- Mergify Payload -\*-\s*(\{.*?\})\s*-\*- Mergify Payload End -\*-', re.S)
ROUGE = {'failure', 'timed_out', 'action_required', 'startup_failure'}
EN_FILE = {'queued', 'waiting', 'pending', 'requested'}
# Même lecture que fetch.py : « Tâche : #n » / « Tâche : MoKarade/<dépôt>#n » (§8), sinon « Closes #n » (transition)
REF = re.compile(r'(?:MoKarade/([\w.-]+))?#(\d+)\b')
TACHE_LIGNE = re.compile(r'^[\s>*_-]*T[âa]che[\s*_]*:(.*)$', re.I | re.M)
CLOSES = re.compile(r'(?i)\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:MoKarade/([\w.-]+))?#(\d+)\b')
PIED_JULES = re.compile(r'jules\.google\.com/task/\d')
CLAUDE = re.compile(r'Co-Authored-By:\s*Claude|claude\.ai/code/session', re.I)


def _court(s, n): return None if s is None else str(s)[:n]


def tache_de(corps, depot):
    """La tâche que cite la PR, 'dépôt#n' en minuscules (même clé que le backlog), ou None."""
    for m in TACHE_LIGNE.finditer(corps or ''):
        r = REF.search(m.group(1))
        if r: return f"{(r.group(1) or depot).lower()}#{r.group(2)}"
    m = CLOSES.search(corps or '')
    return f"{(m.group(1) or depot).lower()}#{m.group(2)}" if m else None


def agent_de(pr):
    """Qui a ouvert la PR : Copilot, Jules, Dependabot, Claude (branche claude/ ou attribution de session), un autre robot, sinon Marc (hypothèse : un compte
    humain sans attribution est Marc, comme acteurs.py)."""
    user = pr.get('user') or {}
    login = (user.get('login') or '').lower()
    corps = pr.get('body') or ''
    if login in BOTS: return BOTS[login]
    if PIED_JULES.search(corps) or any(l.get('name') == 'par-jules' for l in pr.get('labels') or []): return 'Jules'
    if login.startswith('dependabot'): return 'Dependabot'
    if ((pr.get('head') or {}).get('ref') or '').startswith('claude/') or CLAUDE.search(corps): return 'Claude'
    return (user.get('login') or 'inconnu').replace('[bot]', '') if user.get('type') == 'Bot' else 'Marc'


def etat_ci(runs):
    """Les contrôles du dernier commit -> {etat, ok, ko, en_cours, en_file, annules, noms_en_file, rouges}.
    etat : rouge (un contrôle a échoué, même si d'autres tournent) > en_cours (en cours ou en file) > annule > vert > aucun (aucun contrôle : jamais « vert »)."""
    runs = [r for r in runs if not NOM_MERGIFY.match(r.get('name') or '')]
    c = {'ok': 0, 'ko': 0, 'en_cours': 0, 'en_file': 0, 'annules': 0}
    file, rouges = [], []
    for r in runs:
        st, fin = r.get('status'), r.get('conclusion')
        nom = _court(r.get('name'), 80)
        if st in EN_FILE: c['en_file'] += 1; file.append(nom)
        elif st != 'completed': c['en_cours'] += 1
        elif fin in ROUGE: c['ko'] += 1; rouges.append(nom)
        elif fin == 'cancelled': c['annules'] += 1
        else: c['ok'] += 1
    etat = ('aucun' if not runs else 'rouge' if c['ko'] else 'en_cours' if c['en_cours'] + c['en_file'] else 'annule' if c['annules'] else 'vert')
    return {'etat': etat, **c, 'noms_en_file': file[:8], 'rouges': rouges[:8]}


def etat_mergify(commentaires, runs):
    """Mergify : le dernier commentaire à sa charge utile (état, position, étape, entrée, sortie) + le titre de son contrôle « Mergify Merge Queue »,
    tels quels. `file` = entrée dans la file sans sortie. Aucune raison de sortie devinée : le message de Mergify est recopié."""
    out = {'file': False}
    coms = [c for c in commentaires if (c.get('user') or {}).get('login') == 'mergify[bot]' and PAYLOAD.search(c.get('body') or '')]
    if coms:
        corps = coms[-1]['body']
        try: p = json.loads(html.unescape(PAYLOAD.search(corps).group(1)))
        except ValueError: p = {}
        titre = next((l[4:].strip() for l in corps.splitlines() if l.startswith('### ')), None)
        out.update(etat=p.get('state'), position=p.get('position'), etape=p.get('step'), entree_le=p.get('queued_at'), sortie_le=p.get('left_at'),
                   message=_court(titre, 160), file=bool(p.get('queued_at')) and not p.get('left_at'))
    chk = next((r for r in runs if r.get('name') == 'Mergify Merge Queue'), None)
    if chk: out['controle'] = _court((chk.get('output') or {}).get('title'), 160)
    return out


def deploiement(deploiements, statuts):
    """Le dernier déploiement GitHub d'un dépôt (Vercel en écrit un par déploiement), avec son dernier statut ; None si le dépôt n'en a aucun."""
    if not deploiements: return None
    d, s = deploiements[0], (statuts or [{}])[0]
    return {'environnement': d.get('environment'), 'etat': s.get('state'), 'sha': (d.get('sha') or '')[:7], 'ref': d.get('ref'), 'cree_le': d.get('created_at'),
            'maj_le': s.get('created_at') or d.get('updated_at'), 'url': s.get('environment_url') or s.get('target_url')}


def _liste(lire, chemin):
    # pagination à la main (page=N), même adresse que fetch.py : le cache ETag est partagé, un 304 ne coûte rien
    out = []
    for p in range(1, 30):
        d = lire(f'{chemin}&page={p}')
        if not isinstance(d, list): break
        out += d
        if len(d) < 100: break
    return out


def releve(depots, lire, maintenant, compter=lambda: 0, plafond=PLAFOND_APPELS):
    """`lire(chemin)` -> JSON (ghcache.lire) ; `compter()` -> lectures déjà comptées par GitHub. Rend le dict du fichier. Ne lève jamais pour une lecture."""
    base = compter()
    prs, erreurs, brouillons_mergify, deploiements = [], [], 0, {}
    for depot in depots:
        try:
            for p in _liste(lire, f'repos/MoKarade/{depot}/pulls?state=open&per_page=100'):
                if MERGIFY_FILE.match((p.get('head') or {}).get('ref') or ''): brouillons_mergify += 1
                else: prs.append((depot, p))
        except Exception as e: erreurs.append(f'{depot} : liste des PR : {str(e)[:160]}')
        try:
            deps = lire(f'repos/MoKarade/{depot}/deployments?per_page=1')
            sts = lire(f'repos/MoKarade/{depot}/deployments/{deps[0]["id"]}/statuses?per_page=1') if deps else []
            deploiements[depot] = deploiement(deps, sts)
        except Exception as e: deploiements[depot] = {'erreur': str(e)[:160]}
    incomplet, sortie = False, []
    for depot, p in sorted(prs, key=lambda x: x[1].get('updated_at') or '', reverse=True):     # sous le plafond, les PR les plus récemment modifiées d'abord
        sha, n = (p.get('head') or {}).get('sha'), p['number']
        ci, mg, runs = {'etat': 'non_lu'}, {'etat': 'non_lu'}, []
        if compter() - base >= plafond: incomplet = True
        else:
            try:
                d = lire(f'repos/MoKarade/{depot}/commits/{sha}/check-runs?per_page=100')
                runs = d.get('check_runs') or []
                ci = etat_ci(runs)
                if (d.get('total_count') or 0) > len(runs): ci['incomplet'] = True
            except Exception as e: ci = {'erreur': str(e)[:160]}
            try:
                # un brouillon ne peut pas être en file : pas de lecture des commentaires, seulement le contrôle de Mergify
                coms = [] if p.get('draft') else lire(f'repos/MoKarade/{depot}/issues/{n}/comments?per_page=100')
                mg = etat_mergify(coms, runs)
            except Exception as e: mg = {'erreur': str(e)[:160]}
        sortie.append({'repo': depot, 'n': n, 'titre': p.get('title'), 'url': p.get('html_url'), 'tache': tache_de(p.get('body'), depot), 'auteur': (p.get('user') or {}).get('login'),
                       'agent': agent_de(p), 'brouillon': bool(p.get('draft')), 'branche': (p.get('head') or {}).get('ref'), 'sha': (sha or '')[:7],
                       'cree_le': p.get('created_at'), 'maj_le': p.get('updated_at'), 'ci': ci, 'mergify': mg})
    sortie.sort(key=lambda x: (depots.index(x['repo']), x['n']))
    return {'v': VERSION, 'releve': maintenant, 'appels': compter() - base, 'incomplet': incomplet, 'brouillons_mergify': brouillons_mergify, 'erreurs': erreurs,
            'prs': sortie, 'deploiements': deploiements}


def plafond_de(opt):
    """--plafond=n -> n (entier > 0), sinon PLAFOND_APPELS ; une valeur illisible est refusée plutôt qu'ignorée."""
    if 'plafond' not in opt: return PLAFOND_APPELS
    n = int(opt['plafond'])
    if n <= 0: raise ValueError('--plafond doit être un entier positif')
    return n


def main(argv):
    import ghcache
    args = [a for a in argv if not a.startswith('--')]
    opt = dict(a[2:].split('=', 1) for a in argv if a.startswith('--') and '=' in a)
    sortie = args[0] if args else D + 'prs-ouvertes.json'
    depots = opt['depots'].split(',') if opt.get('depots') else [r['repo'] for r in json.load(open(D + 'backlog.json', encoding='utf-8'))['repos']]
    maintenant = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    res = releve(depots, ghcache.lire, maintenant, lambda: ghcache.compteurs()['comptees'], plafond_de(opt))
    with open(sortie + '.tmp', 'w', encoding='utf-8') as fh: json.dump(res, fh, ensure_ascii=False)
    os.replace(sortie + '.tmp', sortie)
    print(f"PR ouvertes : {len(res['prs'])} ({res['appels']} lectures comptées" + (', incomplet' if res['incomplet'] else '') + (f", {len(res['erreurs'])} erreur(s)" if res['erreurs'] else '') + ')')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
