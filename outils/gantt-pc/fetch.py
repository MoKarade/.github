# Relevé GitHub en lecture seule : backlog (issues niveau:*) de chaque dépôt -> backlog.json
# v6 (15/10/2026) : applique le cahier des charges du §13 de MoKarade/.github docs/cycle-de-vie-tache.md
# (PR reliée par « Tâche : #n » ou Closes, états du §7, preuve d'acceptation, geste de Marc, contrôles de la pastille).
# v7 (16/10/2026) : deux modes qui rendent les MÊMES données.
#   PLEIN (défaut)  : relit tout. Sert de référence.
#   LÉGER (--leger) : relit les listes (PR ouvertes, PR fermées, issues) et ne recalcule que les issues dont la SIGNATURE a changé
#                     (dernière modification, état, sous-issues, dépendances, PR reliée) ; les autres viennent du relevé précédent.
#                     Retard maximal du léger sur le plein : le délai entre deux plein. Équivalence vérifiée par test_leger.py.
# v8 (16/10/2026) : trois corrections du rapport des défauts du backlog (2026-10-16_defauts-backlog.md) et une donnée de plus.
#   « Preuve attendue » est aussi lue dans les commentaires (le dernier avec une date lisible l'emporte sur le corps) ;
#   « **Attend** : rien (PR #n) » n'attend rien ; `jules_at` = les instants où l'étiquette `jules` a été posée (mesure des lancements Jules) ;
#   les scripts de MoKarade/.github que la page fait tourner (`prochaine-tache.mjs`, `verif-fidelite.mjs`) sont relus à chaque relevé (build.py et refresh.sh les lancent).
# v9 (19/10/2026) : demande de Marc (la fiche montre les étapes d'une tâche et ce que Jules peut faire).
#   `et` = la suite des étapes d'une tâche lue dans ses événements (en cours, attend Marc, bloquée, preuve attendue, correction, faite) ;
#   `pr.au` = l'auteur de la PR ; `pr.jf` = sa portée (nombre de fichiers, lignes, premier chemin protégé) ; `fp` = nombre de « Fichiers permis » (gabarit Jules).
# Usage : python3 fetch.py [--leger] [--sans-quota] [--prev=fichier.json] [--depots=a,b] [sortie.json]
import json, subprocess, sys, datetime, re, os, time, threading, base64, hashlib, urllib.parse
from reponses import options as reponses_options     # réponses préfaites d'une question (section « Réponses » de l'issue)
from concurrent.futures import ThreadPoolExecutor
import deps as deps_mod     # dépendances vers une PR : ramenées à la tâche qu'elle cite, ou levées si elle est fusionnée
import completude
from acteurs import acteurs as acteurs_de    # qui a travaillé sur la tâche (Copilot, Jules, Claude, Marc), lu dans les commits de sa PR
from acceptation import est_preuve    # même règle que le garde-fou : une personne, ou l'acceptation automatique marquée du robot
import gestes     # contrôle des gestes de Marc à jour (.github#478) : fetch.py y garde les derniers commentaires de Marc (`marc_com`)
from ci import resume_ci     # fin de CI et CI rouge d'une PR fusionnée (onglet Rythme)
ARGS = [a for a in sys.argv[1:] if not a.startswith('--')]
OPT = {a.split('=', 1)[0]: (a.split('=', 1) + [''])[1] for a in sys.argv[1:] if a.startswith('--')}
LEGER = '--leger' in OPT
D = os.path.dirname(os.path.abspath(__file__)) + '/'
OUT = ARGS[0] if ARGS else 'backlog.json'
T0 = time.time()
REPOS = [('.github','eco','Écosystème'),('FinanceAI','fin','FinanceAI'),('JobAI','job','JobAI'),('batchchef-','batch','BatchChef'),('driveai','drive','DriveAI'),
         ('Hubperso','hub','Hubperso'),('carai','car','CarAI'),('memoryai','mem','MemoryAI'),('app-template','tpl','app-template'),('hub-contract','hc','hub-contract'),('lia-ui','lia','lia-ui')]
if OPT.get('--depots'):          # sous-ensemble de dépôts : pour les tests seulement (les liens entre dépôts seraient incomplets)
    REPOS = [r for r in REPOS if r[0] in OPT['--depots'].split(',')]

import ghcache      # lecture avec ETag : un 304 ne compte pas dans la limite de GitHub (mesuré le 16/10/2026)
def _un(path, *args, **kw): return ghcache.lire(path, *args, **kw)
def gh(path, *args):
    # pagination à la main (page=N) : le lien « suivant » de --paginate passe par repositories/{id}, refusé par le relais
    if 'per_page=' not in path: return _un(path, *args)
    out = []
    for p in range(1, 60):
        d = _un(path + ('&' if '?' in path else '?') + f'page={p}', *args, verifier_vide=p > 1)     # une page vide après une page pleine : GitHub se trompe, on relit (ghcache.lire)
        if not isinstance(d, list): return d
        out += d
        if len(d) < int(re.search(r'per_page=(\d+)', path).group(1)): break
    return out
def gh1(path):
    # une seule page (sans --paginate) : pour les listes longues dont seules les plus récentes servent
    return _un(path)
def flat(x): return [i for page in x for i in page] if x and isinstance(x[0], list) else x
asof = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

# Relevé précédent (mode léger) : sans lui, ou s'il est d'une ancienne version ou trop vieux, on relit tout.
PREV, PREV_PRLOG = {}, []
if LEGER:
    try:
        prev = json.load(open(OPT['--prev'] if OPT.get('--prev') else D + OUT))
        age = time.time() - datetime.datetime.fromisoformat(prev['asof'].replace('Z', '+00:00')).timestamp()
        if prev.get('v', 0) < 10: raise ValueError('relevé précédent d\'une ancienne version')
        if age > 45 * 60: raise ValueError(f'relevé précédent trop ancien ({age / 60:.0f} min)')
        for r in prev['repos']:
            for k, nd in r['nodes'].items(): PREV[(r['repo'], int(k))] = nd
        PREV_PRLOG = prev.get('prlog') or []
    except Exception as e:
        print('léger impossible, relevé plein :', e, file=sys.stderr); LEGER = False; PREV = {}
res = {'v': 10, 'asof': asof, 'mode': 'leger' if LEGER else 'plein', 'repos': []}

# Lien PR -> tâche : « Closes/Fixes/Resolves #n » (transition) et « Tâche : #n » / « Tâche : MoKarade/<dépôt>#n » (standard, §8)
CLOSES = r'(?i)\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:MoKarade/([\w.-]+))?#(\d+)\b'
TACHE_LIGNE = re.compile(r'^[\s>*_-]*T[âa]che[\s*_]*:(.*)$', re.I | re.M)
REF = r'(?:MoKarade/([\w.-]+))?#(\d+)\b'
def liens(body, repo):
    out = []
    for m in TACHE_LIGNE.finditer(body or ''):
        for r2, num in re.findall(REF, m.group(1)):
            out.append(((r2 or repo).lower(), int(num), 'tache'))
    for r2, num in re.findall(CLOSES, body or ''):
        out.append(((r2 or repo).lower(), int(num), 'closes'))
    return out

# Taille d'une PR hors tests et fichiers générés (§1 : environ 400 lignes au plus)
HORS_TAILLE = re.compile(r'(^|/)(tests?|__tests__|e2e|fixtures?|__snapshots__|dist|captures)/|\.(test|spec)\.[cm]?[jt]sx?$|(^|/)drizzle/meta/|\.snap$|(^|/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$|\.lock$', re.I)
def taille(files):
    return sum(f['additions'] + f['deletions'] for f in files if not HORS_TAILLE.search(f['filename']))
# Portée de Jules (cycle de vie §6 et docs/jules-gabarit-issue.md : deux fichiers au plus, environ 150 lignes, aucun chemin protégé).
# Le relevé donne les mesures ; la page applique les seuils et dit lequel manque.
PROTEGE = re.compile(r'(^|/)(\.github|\.claude|scripts/hooks|qualite|drizzle|migrations?)/|(^|/)(vercel\.json|\.mergify\.yml|CODEOWNERS|appsscript\.json'
                     r'|package(-lock)?\.json|AGENTS\.md|CLAUDE\.md)$|(^|/)\.env|\.gs$', re.I)
def portee_jules(files):
    p = next((f['filename'] for f in files if PROTEGE.search(f['filename'])), None)
    return {'f': len(files), 'l': sum(f['additions'] + f['deletions'] for f in files), 'p': p}
# Gabarit Jules : « **Fichiers permis** (aucun autre) : » suivi d'une liste ; le nombre d'éléments dit que la tâche a été préparée pour Jules
FP = re.compile(r'^\s*\*\*\s*Fichiers permis\s*\*\*[^\n]*\n((?:[ \t]*[-*][ \t][^\n]*(?:\n|$))+)', re.I | re.M)
def fichiers_permis(body):
    m = FP.search(body or '')
    return len([l for l in m.group(1).splitlines() if l.strip()]) if m else None

# Fichiers qu'une tâche déclare toucher (deux places par dépôt, 21/10/2026) : même grammaire que `fichiersDeclares` de scripts/capacite.mjs
# (« Fichiers permis » ou « Fichiers touchés », chemins entre backticks, journaux HANDOVER/CHANGELOG ignorés). None = rien de lisible : pas de parallèle.
# Un corps peut porter les deux (estimation automatique de scripts/fichiers-touches.mjs, puis « Fichiers permis » exact du gabarit Jules) : « permis » d'abord.
FD = re.compile(r'^\s*\*\*\s*Fichiers (permis|touchés)\s*\*\*[^\n]*\n((?:[ \t]*[-*][ \t][^\n]*(?:\n|$))+)', re.I | re.M)
# La ligne existe-t-elle (même « non déterminés ») ? prochaine-tache.mjs l'exige sur toute tâche (#360), comme `**Attend**`.
FT_LIGNE = re.compile(r'^\s*\*\*\s*Fichiers (?:permis|touchés)\s*\*\*', re.I | re.M)
JOURNAUX = re.compile(r'(^|/)(HANDOVER|CHANGELOG)\.md$|^docs/(INDEX|adr/README)\.md$', re.I)   # journaux et index que chaque tâche complète : voir capacite.mjs
def fichiers_declares(body):
    for m in sorted(FD.finditer(body or ''), key=lambda x: bool(re.match('touch', x.group(1), re.I))):
        chemins = []
        for ligne in m.group(2).split('\n'):
            if not re.match(r'^[ \t]*[-*][ \t]', ligne): continue
            texte = re.sub(r'^[ \t]*[-*]\s*', '', ligne)
            cites = re.findall(r'`([^`]+)`', texte)
            for c in (cites or texte.split()[:1]):
                c = re.sub(r'[`,;:.]+$', '', re.sub(r'^\./', '', c.strip())).replace('\\', '/')
                if c and not re.fullmatch(r'(aucun|rien|n/a)', c, re.I) and c not in chemins: chemins.append(c)
        utiles = [c for c in chemins if not JOURNAUX.search(c)]
        if utiles: return utiles
    return None

# Étapes d'une tâche (demande de Marc, 19/10) : à chaque événement, l'étape est celle de l'étiquette d'état la plus forte.
# Sortie : [[étape, début ISO], ...] ; une étape court jusqu'au début de la suivante, la dernière jusqu'au relevé (la page le calcule).
# « corr » = rouverte (garde-fou de preuve ou à la main) jusqu'à la fermeture suivante ; « pause » = commencée, puis plus aucune étiquette d'état.
ETAPE_LB = {'en-cours', 'jules', 'qui:marc', 'bloqué', 'preuve-attendue', 'preuve-manquante'}
def etape_de(lb, ferme, rouverte):
    if ferme: return 'faite'
    if 'preuve-attendue' in lb: return 'preuve'   # une preuve n'attend jamais Marc, même si qui:marc traîne (.github#247)
    if 'qui:marc' in lb: return 'marc'
    if 'bloqué' in lb: return 'blk'
    if rouverte or 'preuve-manquante' in lb: return 'corr'
    if 'en-cours' in lb or 'jules' in lb: return 'cours'
    return None
def etapes(ev):
    lb, ferme, rouverte, vu_cours, out = set(), False, False, False, []
    def t(iso): return datetime.datetime.fromisoformat(iso.replace('Z', '+00:00')).timestamp()
    for e in sorted(ev, key=lambda e: e['created_at']):
        k, nom = e['event'], (e.get('label') or {}).get('name')
        if k == 'labeled' and nom in ETAPE_LB: lb.add(nom)
        elif k == 'unlabeled' and nom in ETAPE_LB: lb.discard(nom)
        elif k == 'closed': ferme, rouverte = True, False
        elif k == 'reopened': ferme, rouverte = False, True
        else: continue
        et = etape_de(lb, ferme, rouverte) or ('pause' if vu_cours else 'file')
        vu_cours = vu_cours or et == 'cours'
        # un changement fait en plusieurs gestes à quelques secondes d'écart (retirer en-cours, poser qui:marc) est une seule transition
        quand = e['created_at']
        if out and t(quand) - t(out[-1][1]) < 30: quand = out.pop()[1]
        if not out or out[-1][0] != et: out.append([et, quand])
    while out and out[0][0] == 'file': out.pop(0)        # avant tout état, la tâche attendait simplement dans la file
    return out

# Gabarits des corps (§2) et extraction des champs affichés dans la fiche
GAB = {'chantier': ['Objectif', 'Pourquoi', 'Fini quand', 'Source'], 'mission': ['Résultat', 'Fini quand', 'Source'],
       'tâche': ['Avant', 'Après', 'Fini quand', 'Source']}
def champ(body, nom):
    # `**Après** (besoin validé par Marc le 19/10/2026) : …` : une précision entre parenthèses avant les deux-points reste le champ « Après » (carai#8, 21/10/2026)
    m = re.search(r'^\s*\*\*\s*' + re.escape(nom) + r'\s*(?:\*\*\s*(?:\([^)\n]{0,160}\)\s*)?:|:\s*\*\*)\s*(.*?)(?=^\s*\*\*[^*\n]{1,40}?(?:\*\*\s*:|:\s*\*\*)|\Z)', body or '', re.M | re.S | re.I)
    if not m: return None
    t = re.sub(r'\s+', ' ', m.group(1)).strip()
    return t[:280] + ('…' if len(t) > 280 else '')
GESTE = re.compile(r'^\s*\**\s*Geste\s*\**\s*:\s*\**\s*', re.I)
# « Preuve attendue : AAAA-MM-JJ HH:MM (heure du Québec) — événement », écrite dans l'issue ET commentée (§10 du cycle de vie)
PA_LIGNE = re.compile(r'^[\s>*_-]*Preuve attendue[\s*_]*:\s*\**\s*(.*)$', re.I | re.M)
PA_DATE = re.compile(r'\s*\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}')
def deps_attend(body, repo):
    """Dépendances écrites : « **Attend** : #12, MoKarade/x#3, Hubperso#311 — raison » (lecture dans deps.py, testée)."""
    return deps_mod.lire_attend(body, repo)
def pa_commentaires(com):
    """(texte, url) de la dernière ligne « Preuve attendue » d'un commentaire de personne, une date lisible avant un texte libre ; sinon (None, None)."""
    lus = []
    for c in sorted(com, key=lambda c: c['created_at']):
        if (c.get('user') or {}).get('type') != 'User': continue        # un robot qui rappelle le format n'est pas une échéance
        for m in PA_LIGNE.finditer(c.get('body') or ''):
            t = re.sub(r'\s+', ' ', m.group(1)).strip()
            if t: lus.append((bool(PA_DATE.match(t)), t[:280] + ('…' if len(t) > 280 else ''), c['html_url']))
    datees = [x for x in lus if x[0]]
    pick = datees[-1] if datees else lus[-1] if lus else None
    return (pick[1], pick[2]) if pick else (None, None)

# 1. Listes de chaque dépôt, lues en parallèle : PR ouvertes, 100 dernières PR fermées, issues, incidents.
# Vitesse de sortie (onglet « Rythme ») : toutes les PR fusionnées depuis 92 jours, liées à une tâche ou non. 92 et non 8 depuis le 21/10 :
# Marc choisit 24 h, 7 j, 1 mois ou 3 mois et chaque courbe ne montre que cette durée. Le relevé léger garde l'historique du précédent.
CUTOFF = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=92)).strftime('%Y-%m-%dT%H:%M:%SZ')
def fusionnees(repo, premiere):
    # la page de 100 déjà lue, puis les suivantes tant que la liste (triée par dernière modification) remonte encore dans la fenêtre
    out, last, page = list(premiere), premiere, 1
    while len(last) == 100 and out[-1]['updated_at'] >= CUTOFF and page < 20:
        page += 1
        last = gh1(f'repos/MoKarade/{repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page={page}')
        out += last
    return [p for p in out if p.get('merged_at') and p['merged_at'] >= CUTOFF]
def listes(rk):
    repo = rk[0]
    ouvertes = flat(gh(f'repos/MoKarade/{repo}/pulls?state=open&per_page=100'))
    fermees = gh1(f'repos/MoKarade/{repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100')
    # léger : la première page suffit (les plus récemment modifiées) ; les fusions plus anciennes viennent du relevé précédent
    fus = [p for p in fermees if p.get('merged_at') and p['merged_at'] >= CUTOFF] if LEGER else fusionnees(repo, fermees)
    issues = flat(gh(f'repos/MoKarade/{repo}/issues?state=all&per_page=100&since=2026-10-15T00:00:00Z'))
    incidents = flat(gh(f'repos/MoKarade/{repo}/issues?state=open&labels=incident&per_page=100'))
    return ouvertes, fermees, fus, issues, incidents
with ThreadPoolExecutor(5) as ex:
    LISTES = dict(zip([r[0] for r in REPOS], ex.map(listes, REPOS)))

# le pied de page de Jules porte un numéro de tâche : une PR qui cite seulement le critère (« jules.google.com/task/ ») n'est pas de Jules (#425, 21/10)
PIED_JULES = re.compile(r'jules\.google\.com/task/\d')
def par_jules(p): return bool(PIED_JULES.search(p.get('body') or '')) or any(l.get('name') == 'par-jules' for l in p.get('labels') or [])
LIEN = {}
PRLOG = []
for repo, key, name in REPOS:
    ouvertes, fermees, fus, _, _ = LISTES[repo]
    # au, b : auteur et branche de la PR. Jules ouvre ses PR au nom de Marc, et ni l'auteur, ni la branche, ni l'étiquette `jules` de la tâche ne le prouvent
    # (Hubperso#195 : branche claude/, PR de Jules). j = 1 : critère du fil Jules (21/10/2026, jules/2026-10-21_pr-de-jules-30-jours.md) : le corps cite
    # jules.google.com/task/, ou la PR porte l'étiquette `par-jules` (posée là où le pied de page a été effacé, CarAI#24). `b` dit seulement « fil Claude »
    nouveaux = [{'r': key, 'n': p['number'], 'c': p['created_at'], 'm': p['merged_at'], 'au': (p.get('user') or {}).get('login'), 'b': (p.get('head') or {}).get('ref'),
                 'k': 'tache' if liens(p.get('body'), repo) else 'robot' if (p.get('user') or {}).get('type') == 'Bot' else 'autre',
                 **({'j': 1} if par_jules(p) else {})} for p in fus]
    if LEGER:
        vus = {x['n'] for x in nouveaux}
        nouveaux += [x for x in PREV_PRLOG if x['r'] == key and x['n'] not in vus and x['m'] >= CUTOFF]
    PRLOG += nouveaux
    # fus couvre toutes les fusions de la fenêtre (plusieurs pages en plein) : sans elles, une PR fusionnée sortie de la 1re page
    # des fermées (100 plus récemment modifiées) perdait son lien et la tâche passait à « aucune PR » (écart I2, .github#31 et #60)
    vus_pr = {p['number'] for p in ouvertes + fermees}
    for p in ouvertes + fermees + [x for x in fus if x['number'] not in vus_pr]:
        for rl, num, kind in liens(p.get('body'), repo):
            d = {'n': p['number'], 'repo': repo, 'created': p['created_at'], 'url': p['html_url'], 'state': p['state'], 'draft': p.get('draft', False),
                 'merged': p.get('merged_at'), 'closed': p.get('closed_at'), 'upd': p.get('updated_at'), 'kind': kind, 'au': (p.get('user') or {}).get('login'),
                 # dérogation de taille (Garde-fou, scripts/taille-pr.mjs) : posée par Marc ou le Coordinateur, la PR n'est plus un défaut « plus de 400 lignes »
                 **({'dg': 1} if any(l.get('name') == 'derogation-taille' for l in p.get('labels') or []) else {})}
            L = LIEN.setdefault(f'{rl}#{num}', {})
            # une PR citée deux fois (Tâche et Closes) garde le lien « tache »
            if (repo, p['number']) not in L or kind == 'tache': L[(repo, p['number'])] = d
def pr_de(ref):
    # la PR qui compte : ouverte d'abord, sinon la dernière fusionnée, sinon la dernière fermée
    ps = list(LIEN.get(ref, {}).values())
    if not ps: return None
    ps.sort(key=lambda p: (p['state'] == 'open', bool(p['merged']), p['merged'] or p['created']), reverse=True)
    return ps[0]

# PR -> tâche qu'elle cite, et PR fusionnées : une dépendance écrite « #208 » vers une PR est réparée dans le relevé (deps.py), l'issue reste telle quelle
PR_VERS_TACHE = {f"{r.lower()}#{n}": tache for tache, prs in LIEN.items() for (r, n) in prs}
PRS_FUSIONNEES = {f"{repo.lower()}#{p['number']}" for repo in LISTES for p in LISTES[repo][1] + LISTES[repo][2] if p.get('merged_at')}

# Enfants de chaque issue d'après le champ « parent » des enfants (déjà dans les listes) : sans appel, ça dit si les sous-issues ont changé
ENFANTS = {}
for repo, key, name in REPOS:
    for i in LISTES[repo][3]:
        m = re.search(r'/repos/[^/]+/([^/]+)/issues/(\d+)$', i.get('parent_issue_url') or '')
        if m and 'pull_request' not in i: ENFANTS.setdefault(f'{m.group(1).lower()}#{m.group(2)}', set()).add(f'{repo.lower()}#{i["number"]}')
ECARTS_ENFANTS = []

VIEILLE = re.compile(r'PR déjà ouverte\*\* : #(\d+)')
def signature(i, pr, body):
    # tout ce qui, dans l'issue ou sa PR, peut changer ce que calcule calculer() ; None = toujours recalculer
    if VIEILLE.search(body) and not pr: return None          # PR nommée dans le corps : son état ne se voit pas dans les listes
    sub, dep = i.get('sub_issues_summary') or {}, i.get('issue_dependencies_summary') or {}
    return [i['updated_at'], i['state'], sub.get('total'), sub.get('completed'), dep.get('total_blocked_by'),
            None if not pr else [pr['n'], pr['repo'], pr['state'], pr['draft'], pr['merged'], pr['closed'], pr['upd']]]
def refs_enfants(rl, kids): return {f'{rl}#{k}' if isinstance(k, int) else str(k).lower() for k in kids}

def calculer(repo, rl, i, pr):
    labels = [l['name'] for l in i['labels']]
    lvl = next(l.split(':')[1] for l in labels if l.startswith('niveau:'))
    body = i.get('body') or ''
    n = {'n': i['number'], 'title': i['title'], 'lvl': lvl, 'labels': labels, 'state': i['state'], 'reason': i.get('state_reason'),
         'created': i['created_at'], 'closed': i['closed_at'], 'url': i['html_url'], 'kids': [], 'start': None, 'pr': None,
         'gab': [c for c in GAB.get(lvl, []) if champ(body, c) is None],
         'av': champ(body, 'Avant'), 'ap': champ(body, 'Après'), 'fq': champ(body, 'Fini quand'),
         'res': champ(body, 'Résultat') or champ(body, 'Objectif'),
         'pa': champ(body, 'Preuve attendue'), 'fp': fichiers_permis(body), 'fpl': fichiers_declares(body), 'ft_ligne': bool(FT_LIGNE.search(body)), 'rp': reponses_options(body)}
    m = VIEILLE.search(body)
    if not pr and m:
        # ancienne forme : la PR est nommée dans le corps de l'issue, sans lien depuis la PR
        p = gh(f'repos/MoKarade/{repo}/pulls/{m.group(1)}')
        pr = {'n': p['number'], 'repo': repo, 'created': p['created_at'], 'url': p['html_url'], 'state': p['state'], 'draft': p.get('draft', False),
              'merged': p.get('merged_at'), 'kind': 'corps'}
    if pr and lvl == 'tâche':
        fs = flat(gh(f"repos/MoKarade/{pr['repo']}/pulls/{pr['n']}/files?per_page=100"))
        if pr['state'] == 'open':
            pr['lignes'] = taille(fs)
            # fichiers RÉELS de la PR ouverte (deux places par dépôt) : prochaine-tache.mjs les ajoute aux fichiers déclarés de la tâche.
            # None = liste tronquée (la page des fichiers ne rend que 100 entrées) : elle ne prouve rien. Un renommage compte pour l'ancien chemin aussi.
            pr['ff'] = None if len(fs) >= 100 else sorted({c for f in fs for c in (f['filename'], f.get('previous_filename')) if c and not JOURNAUX.search(c)})
        pr['jf'] = portee_jules(fs)
    if pr and lvl == 'tâche' and ('c0' not in pr or 'acteurs' not in pr):
        # le travail réel : première et dernière modification (commits) de la PR
        cs = flat(gh(f"repos/MoKarade/{pr['repo']}/pulls/{pr['n']}/commits?per_page=100"))
        da = sorted(c['commit']['author']['date'] for c in cs if c.get('commit'))
        dc = sorted(c['commit']['committer']['date'] for c in cs if c.get('commit'))
        if da: pr['c0'], pr['c1'], pr['nc'] = da[0], max(dc[-1], da[-1]), len(cs)
        # heures exactes de chaque modification (auteur) : le Gantt en tire les plages de travail réel
        pr['cs'] = sorted(set(da + dc))[-60:]
        pr['acteurs'] = acteurs_de(cs)     # [{qui, debut, fin, commits}] ; la page l'affiche au survol
    n['pr'] = pr
    n['upd'] = i.get('updated_at')
    # dépendances : ligne « **Attend** : #12, MoKarade/x#3 — raison » + dépendances natives GitHub (« Blocked by »)
    deps = deps_attend(body, repo)
    natives = []
    if (i.get('issue_dependencies_summary') or {}).get('total_blocked_by'):
        for b in flat(gh(f'repos/MoKarade/{repo}/issues/{i["number"]}/dependencies/blocked_by?per_page=100')):
            natives.append(f"{b['repository_url'].rsplit('/', 1)[1].lower()}#{b['number']}")
    n['deps'] = deps_mod.normaliser(deps + natives, f"{rl}#{i['number']}", PR_VERS_TACHE, PRS_FUSIONNEES)
    n['attend_ligne'] = any(deps_mod.reste_attend(l) is not None for l in (body or '').splitlines())   # la ligne existe, même « aucune » : prochaine-tache.mjs exige qu'elle soit écrite (19/10)
    n['deps_natives'] = sorted(set(natives))      # ceux que GitHub affiche en « Bloquée par » : prochaine-tache.mjs liste les liens qui manquent
    if lvl != 'tâche':
        # enfant du même dépôt : son numéro ; d'un autre dépôt (mission commune dans .github) : « dépôt#n »
        n['kids'] = [s['number'] if s['repository_url'].rsplit('/', 1)[1].lower() == rl
                     else f"{s['repository_url'].rsplit('/', 1)[1].lower()}#{s['number']}"
                     for s in flat(gh(f'repos/MoKarade/{repo}/issues/{i["number"]}/sub_issues?per_page=100'))]
    if lvl == 'tâche' and (ETAPE_LB & set(labels) or i['state'] == 'closed' or i.get('state_reason') == 'reopened'):
        ev = flat(gh(f'repos/MoKarade/{repo}/issues/{i["number"]}/events?per_page=100'))
        lab = lambda nom: [e['created_at'] for e in ev if e['event'] == 'labeled' and e.get('label', {}).get('name') == nom]
        t = sorted(lab('en-cours') + lab('jules'))
        n['start'] = t[0] if t else None
        n['jules'] = bool(lab('jules'))
        n['jules_at'] = lab('jules')
        b = lab('bloqué')
        n['bloque_depuis'] = b[-1] if b and 'bloqué' in labels else None
        # depuis quand un geste de Marc est demandé (la dernière pose de `qui:marc`) : prochaine-tache.mjs en tire les gestes qui dorment (tâches oubliées)
        m = lab('qui:marc')
        n['marc_depuis'] = m[-1] if m and 'qui:marc' in labels else None
        n['et'] = etapes(ev)
    geste_ou_ferme = lvl == 'tâche' and (('qui:marc' in labels and i['state'] == 'open') or (i['state'] == 'closed' and i.get('state_reason') == 'completed'))
    # une échéance de preuve peut n'être écrite que dans un commentaire : on lit les commentaires des tâches ouvertes qui l'attendent
    pa_possible = lvl == 'tâche' and i['state'] == 'open' and ('preuve-attendue' in labels or bool(pr and pr.get('merged')) or 'preuve attendue' in body.lower())
    if geste_ou_ferme or pa_possible or (lvl == 'tâche' and n['pa']):
        com = flat(gh(f'repos/MoKarade/{repo}/issues/{i["number"]}/comments?per_page=100'))
        if geste_ou_ferme:
            g = [c for c in com if GESTE.match(c.get('body') or '')]
            if g:
                t = re.sub(r'\s+', ' ', GESTE.sub('', g[-1]['body'], count=1)).strip()
                n['geste'] = {'t': t[:400] + ('…' if len(t) > 400 else ''), 'u': g[-1]['html_url']}
            # derniers commentaires de Marc (gestes.py, .github#478) : un « fait » clair plus récent que la pose de `qui:marc` retire l'étiquette. Aucun appel de plus.
            if 'qui:marc' in labels and i['state'] == 'open': n['marc_com'] = gestes.commentaires_de_marc(com)
            # même règle que le garde-fou (scripts/preuve.mjs) : une personne ou Claude, ou l'acceptation automatique marquée ; jamais un autre robot ni Jules
            a = [c for c in com if est_preuve(c)]
            if a:
                n['preuve'] = {'u': a[-1]['html_url'], 'c': a[-1]['created_at']}
        pa, pa_u = pa_commentaires(com)
        if pa and (PA_DATE.match(pa) or not n['pa']):        # le commentaire l'emporte sur le corps seulement s'il porte une date lisible (ou si le corps n'a rien)
            n['pa'], n['pa_u'] = pa, pa_u
    return n

def pr_gardee(pr, ancien):
    # léger : une PR fusionnée ou fermée sortie de la 1re page des fermées garde son lien (relevé précédent). Sans cela, la tâche qui change (un commentaire
    # de preuve suffit) était recalculée « aucune PR » : trois écarts I2 le 21/10/2026 (.github#122, #174, #196), jusqu'au prochain relevé plein.
    if LEGER and pr is None and ancien and ancien.get('pr') and ancien['pr'].get('state') != 'open' and ancien['pr'].get('kind') != 'corps': return ancien['pr']
    return pr

def du_backlog(i):
    # Une issue entre dans le backlog si elle n'est pas une PR, porte un `niveau:*` et n'est PAS une issue d'essai (cycle de vie : le Gantt ignore `essai`, .github#576).
    return 'pull_request' not in i and any(l['name'].startswith('niveau:') for l in i['labels']) and not any(l['name'] == 'essai' for l in i['labels'])

ATTEND_MARC = re.compile(r'^Garde-fou : la PR #(\d+) attend un geste de Marc$')
def traiter(rk):
    repo, key, name = rk
    rl = repo.lower()
    ouvertes, fermees, _, issues_all, incidents_all = LISTES[repo]
    issues = [i for i in issues_all if du_backlog(i)]
    incidents = [{'n': i['number'], 't': i['title'], 'url': i['html_url']} for i in incidents_all if 'pull_request' not in i]
    # PR dont le seul obstacle est un geste de Marc : le Garde-fou (.github, scripts/garde-fou.mjs) ouvre alors « Garde-fou : la PR #n attend un geste
    # de Marc » en `qui:marc`. Lu dans la liste déjà chargée, sans appel de plus ; prochaine-tache.mjs ne compte plus ces PR comme occupant le dépôt (#197).
    pr_attend_marc = sorted(int(m.group(1)) for i in issues_all if 'pull_request' not in i and i['state'] == 'open'
                            and any(l['name'] == 'qui:marc' for l in i['labels']) for m in [ATTEND_MARC.match(i['title'] or '')] if m)
    nodes, reutilises = {}, 0
    for i in issues:
        pr = pr_de(f'{rl}#{i["number"]}')
        ancien = PREV.get((repo, i['number']))
        pr = pr_gardee(pr, ancien)
        sig = signature(i, pr, i.get('body') or '')
        pr_a = ancien.get('pr') if ancien else None
        if LEGER and ancien and sig is not None and ancien.get('sig') == sig and 'fpl' in ancien and 'ft_ligne' in ancien and not (pr_a and pr_a.get('state') == 'open' and 'ff' not in pr_a) and not ('qui:marc' in ancien['labels'] and ancien['lvl'] == 'tâche' and ancien['state'] == 'open' and 'marc_com' not in ancien) and not (ancien['lvl'] == 'tâche' and pr_a and pr_a.get('c0') and 'acteurs' not in pr_a):   # 'fpl', 'ft_ligne', 'ff' ou 'marc_com' absent = relevé d'avant les deux places ou d'avant #478 : recalculé
            # non-tâche : ses sous-issues ont-elles changé ? (les enfants disent qui est leur parent)
            if ancien['lvl'] == 'tâche' or refs_enfants(rl, ancien['kids']) == ENFANTS.get(f'{rl}#{i["number"]}', set()):
                nodes[i['number']] = ancien; reutilises += 1
                continue
        n = calculer(repo, rl, i, pr)
        n['sig'] = sig
        if not LEGER and n['lvl'] != 'tâche' and refs_enfants(rl, n['kids']) != ENFANTS.get(f'{rl}#{n["n"]}', set()):
            ECARTS_ENFANTS.append(f'{rl}#{n["n"]}')
        nodes[i['number']] = n
    # PR ouvertes qui ne relient aucune tâche : hors backlog (signalées, jamais corrigées ici)
    hors = [{'n': p['number'], 't': p['title'], 'url': p['html_url'], 'bot': p['user']['type'] == 'Bot', 'draft': p['draft'], 'c': p['created_at']}
            for p in ouvertes if not liens(p.get('body'), repo)]
    print(name, len(nodes), 'issues', f'({reutilises} reprises)' if LEGER else '', file=sys.stderr)
    return {'repo': repo, 'key': key, 'name': name, 'nodes': nodes, 'hors': hors, 'incidents': incidents, 'pr_attend_marc': pr_attend_marc}, reutilises
with ThreadPoolExecutor(5) as ex:
    sorties = list(ex.map(traiter, REPOS))
res['repos'] = [s[0] for s in sorties]
# CI de chaque PR fusionnée (Marc, 21/10/2026) : `ci` = fin de la CI sur le dernier commit, `cr` = 1 si un run a échoué avant la fusion.
# Une PR fusionnée ne change plus : mémorisée dans ci_cache.json, au plus CI_PAR_RELEVE nouvelles par relevé (les plus récentes d'abord).
# Les branches claude/project-thread-* servent à plusieurs PR : les runs sont bornés à la vie de la PR (created=c..m), jamais à la branche seule.
CI_PAR_RELEVE = 80
CI_CACHE = D + 'ci_cache.json'
try: CI = json.load(open(CI_CACHE, encoding='utf-8'))
except Exception: CI = {}
NOM = {key: repo for repo, key, _ in REPOS}
SHA = {(key, p['number']): (p.get('head') or {}).get('sha') for repo, key, _ in REPOS for p in LISTES[repo][2]}
def ci_de(x):
    runs = (_un(f"repos/MoKarade/{NOM[x['r']]}/actions/runs?branch={urllib.parse.quote(x['b'], safe='')}"
                f"&created={urllib.parse.quote(x['c'] + '..' + x['m'], safe='')}&per_page=100") or {}).get('workflow_runs') or []
    return f"{x['r']}#{x['n']}", resume_ci(runs, SHA.get((x['r'], x['n'])))
def ci_ou_rien(x):
    try: return ci_de(x)
    except RuntimeError as e:     # panne passagère : rien n'est mémorisé, le relevé suivant réessaie
        print('CI', x['r'], x['n'], e, file=sys.stderr); return None
a_lire = sorted((x for x in PRLOG if f"{x['r']}#{x['n']}" not in CI and x.get('b') and (x['r'], x['n']) in SHA), key=lambda x: x['m'], reverse=True)[:CI_PAR_RELEVE]
with ThreadPoolExecutor(5) as ex:
    for r in ex.map(ci_ou_rien, a_lire):
        if r: CI[r[0]] = r[1]
CI = {k: v for k, v in CI.items() if k in {f"{x['r']}#{x['n']}" for x in PRLOG}}
open(CI_CACHE + '.tmp', 'w', encoding='utf-8').write(json.dumps(CI)); os.replace(CI_CACHE + '.tmp', CI_CACHE)
for x in PRLOG:
    for k, v in (CI.get(f"{x['r']}#{x['n']}") or {}).items():
        if v is not None: x[k] = v
print(f'CI : {len(a_lire)} PR lues, {len(CI)} mémorisées', file=sys.stderr)
res['prlog'] = sorted(PRLOG, key=lambda x: x['m'])
res['prlog_j'] = 1     # chaque entrée porte j = 1 quand la PR est de Jules (par_jules) : sans ce repère, la page ne sait pas si l'absence de j est mesurée
# Impact de Graphify (tâche #466) : artefacts « graphe » des dix dépôts, mémorisés dans graphes_cache.json. Un échec ne bloque jamais le relevé.
GRAPHES_CACHE = D + 'graphes_cache.json'
try:
    import graphes
    try: GR = json.load(open(GRAPHES_CACHE, encoding='utf-8'))
    except Exception: GR = {}
    res['graphes'], lus, err = graphes.relever([(repo, key) for repo, key, _ in REPOS], _un, GR)
    open(GRAPHES_CACHE + '.tmp', 'w', encoding='utf-8').write(json.dumps(GR)); os.replace(GRAPHES_CACHE + '.tmp', GRAPHES_CACHE)
    for e in err: print('graphes', e, file=sys.stderr)
    print(f"graphes : {lus} artefacts lus, {len(res['graphes'])} mémorisés", file=sys.stderr)
except Exception as e:
    print('graphes a échoué :', e, file=sys.stderr)
# Workflows en file sans robot (tâche #532) : un échec ne bloque jamais le relevé ; `en_file` absent = relevé d'avant cette mesure ou lecture en échec.
try:
    import workflows_en_file
    res['en_file'], err_wf = workflows_en_file.relever([(repo, key) for repo, key, _ in REPOS], _un, datetime.datetime.now(datetime.timezone.utc))
    for e in err_wf: print('workflows en file', e, file=sys.stderr)
    print(f"workflows en file : {len(res['en_file'])} signalé(s), {len(err_wf)} dépôt(s) illisible(s)", file=sys.stderr)
except Exception as e:
    print('workflows en file a échoué :', e, file=sys.stderr)
CPT = ghcache.compteurs()
# appels = requêtes comptées par GitHub (hors 304) ; reqs = toutes les requêtes ; n304 = celles qui n'ont rien coûté
res['appels'], res['reqs'], res['n304'] = CPT['comptees'], CPT['req'], CPT['n304']
res['duree_s'], res['reutilises'] = round(time.time() - T0, 1), sum(s[1] for s in sorties)
if not LEGER: res['ecarts_enfants'] = ECARTS_ENFANTS     # plein : les enfants vus par « parent » diffèrent-ils de sub_issues ? (attendu : aucun)
print(f"{res['mode']} : {res['appels']} appels comptés ({res['n304']} en 304 gratuits sur {res['reqs']}), {res['duree_s']} s, {res['reutilises']} reprises" + (f", écarts enfants {len(ECARTS_ENFANTS)}" if not LEGER else ''), file=sys.stderr)
# Miroir local des scripts de MoKarade/.github que la page fait tourner : UN calcul de la file (prochaine-tache.mjs) et UNE mesure de fidélité
# (verif-fidelite.mjs), les mêmes pour la page et pour la routine. Relus à chaque relevé (un 304 ne coûte rien) ; leurs imports relatifs suivent.
SCRIPTS_ENTREES = ['prochaine-tache.mjs', 'verif-fidelite.mjs', 'filet-pc.mjs']
SCRIPTS_DIR = D + 'scripts-github/'
def git_sha(b): return hashlib.sha1(b'blob %d\0' % len(b) + b).hexdigest()
def miroir_scripts():
    os.makedirs(SCRIPTS_DIR, exist_ok=True)
    out, file = {}, list(SCRIPTS_ENTREES)
    while file:
        nom = file.pop(0)
        if nom in out: continue
        loc = SCRIPTS_DIR + nom
        local = open(loc, 'rb').read() if os.path.exists(loc) else None
        try:
            m = _un(f'repos/MoKarade/.github/contents/scripts/{nom}')
            texte = base64.b64decode(m['content'])
            if git_sha(texte) != m['sha']: raise RuntimeError('contenu reçu incohérent avec sa somme de contrôle')
            if local != texte:
                open(loc + '.tmp', 'wb').write(texte); os.replace(loc + '.tmp', loc)
            out[nom] = {'sha': m['sha']}
        except Exception as e:
            print('script', nom, 'non relu :', e, file=sys.stderr)
            texte = local
            out[nom] = {'sha': git_sha(local) if local else None, 'erreur': str(e)[:160]}
        if texte:
            file += re.findall(r"""from\s+['"]\./([\w.-]+\.mjs)['"]""", texte.decode('utf-8', 'replace'))
    return out
res['scripts'] = miroir_scripts()
OUT_F = D + OUT if not os.path.isabs(OUT) else OUT
# Perte brutale d'éléments depuis le relevé précédent = lecture incomplète de GitHub (page vide, 22/10/2026) : pas de publication, le tour garde le précédent
try: prec = json.load(open(OUT_F, encoding='utf-8'))
except Exception: prec = None
if prec:
    perdus = completude.pertes(prec, res, datetime.datetime.now(datetime.timezone.utc))
    if perdus:
        print('relevé INCOMPLET, non publié : ' + ', '.join(f'{d} {a} -> {b} éléments' for d, a, b in perdus), file=sys.stderr)
        sys.exit(3)
res['relectures_vide'] = ghcache.compteurs()['relectures_vide']
json.dump(res, open(OUT_F + '.tmp', 'w'), ensure_ascii=False)
os.replace(OUT_F + '.tmp', OUT_F)
# quotas (Actions, Vercel, Jules, Gemini) : mesure à part, un échec ne bloque pas le relevé. La boucle les lance elle-même (--sans-quota).
if not LEGER and '--sans-quota' not in OPT:
    try:
        subprocess.run([sys.executable, D + 'quota.py'], timeout=900, check=True)
    except Exception as e:
        print('quota.py a échoué :', e, file=sys.stderr)
