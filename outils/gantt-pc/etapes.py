#!/usr/bin/env python3
# etapes.py (28/10/2026, tâche .github#689) : deux heures que `prlog` n'a pas, pour la durée moyenne de chaque étape de la page Chantier.
#   prets    : quand la PR est sortie du brouillon (dernier `ready_for_review` avant la fusion) ; None = lue, jamais brouillon
#   en_ligne : le déploiement dont le commit est le commit de fusion (`ms` de prlog), avec l'heure de son statut `success` (= en ligne)
# -> etapes.json, repris par build.py comme champ `etapes` de donnees.json.
# Règles : 0 $ ; un événement ou un déploiement terminé ne change plus, donc chaque résultat est mémorisé à vie (etapes-cache.json) et seules les nouvelles
# fusions coûtent une lecture ; au plus PLAFOND_APPELS lectures comptées par tour (le passé se rattrape par paquets, fusions les plus récentes d'abord) ;
# jamais de fake data : une lecture qui échoue n'écrit rien (la clé reste absente, le tour suivant réessaie), une PR sans déploiement n'a pas d'`en_ligne`.
# Usage : python3 etapes.py [sortie.json] [--plafond=n]   (lit backlog.json : `prlog` et `repos`)
import datetime, json, os, sys
from concurrent.futures import ThreadPoolExecutor

VERSION = 1
PLAFOND_APPELS = 60
PAGES_DEPLOIEMENTS = 5        # 100 déploiements par page : Hubperso en fait ~20 par jour
PAGES_EVENEMENTS = 3
PARALLELES = 5            # lectures simultanées (comme fetch.py)
D = os.path.dirname(os.path.abspath(__file__)) + os.sep
TERMINES = {'success', 'failure', 'error', 'inactive'}      # un déploiement dans un autre état (pending, in_progress, queued) se relit au tour suivant


def pret_de(evenements, fusionnee_le):
    """Le dernier `ready_for_review` au plus tard à la fusion (les dates GitHub sont toutes en UTC, 'Z' : l'ordre des chaînes est l'ordre du temps) ; None sinon."""
    heures = [e['created_at'] for e in evenements if e.get('event') == 'ready_for_review' and e.get('created_at') and e['created_at'] <= fusionnee_le]
    return max(heures) if heures else None


def etat_deploiement(statuts):
    """Les statuts d'un déploiement -> (pret_le, termine). pret_le = le plus ancien `success` ; termine = plus rien ne changera (succès, échec, erreur)."""
    succes = [s['created_at'] for s in statuts if s.get('state') == 'success' and s.get('created_at')]
    return (min(succes) if succes else None), any(s.get('state') in TERMINES for s in statuts)


def associer(prs, deploiements):
    """prs : [{r, n, ms}] ; deploiements : {depot: {id: {sha, env, cree_le, pret_le}}}, `depot` donné par `r`. -> {'r#n': {sha, env, cree_le, pret_le}} pour chaque fusion
    dont le commit a un déploiement réussi. Plusieurs déploiements du même commit (« Redeploy ») : le premier qui est passé en ligne."""
    out = {}
    for x in prs:
        if not x.get('ms'): continue
        candidats = [d for d in deploiements.get(x['r'], {}).values() if d.get('pret_le') and d['sha'] == x['ms']]
        if candidats: out[f"{x['r']}#{x['n']}"] = min(candidats, key=lambda d: d['pret_le'])
    return out


def _pages(lire, chemin, maximum, jusqu_a=None):
    """Pagination à la main (page=N). `jusqu_a` : on s'arrête dès qu'une page descend sous cette date (listes triées de la plus récente à la plus ancienne)."""
    out = []
    for p in range(1, maximum + 1):
        d = lire(f'{chemin}&page={p}')
        if not isinstance(d, list): break
        out += d
        if len(d) < 100 or (jusqu_a and min(x['created_at'] for x in d) < jusqu_a): break
    return out


def releve(prlog, depots, cache, lire, maintenant, compter=lambda: 0, plafond=PLAFOND_APPELS, paralleles=PARALLELES):
    """prlog : liste de {r, n, m, ms?} ; depots : {clé: nom du dépôt} ; cache : {'prets': {...}, 'dep': {...}} (modifié en place) ; lire(chemin) -> JSON.
    Rend le dict du fichier. Ne lève jamais pour une lecture. Les lectures se font `paralleles` à la fois (un `gh` par lecture, ~2 s chacun sous Windows) ;
    le plafond est réparti d'avance (une lecture neuve = une lecture comptée) : statuts de déploiements d'abord, puis événements de PR."""
    base = compter()
    erreurs = []
    prets, dep = cache.setdefault('prets', {}), cache.setdefault('dep', {})
    def par(f, items):
        with ThreadPoolExecutor(max(1, paralleles)) as ex: return list(ex.map(f, items))
    def reste(): return max(0, plafond - (compter() - base))
    prs = sorted((x for x in prlog if x.get('m') and x.get('r') in depots), key=lambda x: x['m'], reverse=True)
    cles = {f"{x['r']}#{x['n']}" for x in prs}
    for k in [k for k in prets if k not in cles]: del prets[k]
    # 1. déploiements : seulement ceux dont le commit est une fusion de prlog, et seulement jusqu'à la plus ancienne fusion du dépôt
    parcles = {}
    for x in prs: parcles.setdefault(x['r'], []).append(x)
    def lister(cle):
        try: return _pages(lire, f'repos/MoKarade/{depots[cle]}/deployments?per_page=100', PAGES_DEPLOIEMENTS, min(x['m'] for x in parcles[cle])), None
        except Exception as e: return None, f'{depots[cle]} : déploiements : {str(e)[:160]}'
    couvert, a_lire = {}, []
    for cle, (liste, erreur) in zip(parcles, par(lister, list(parcles))):
        if erreur: erreurs.append(erreur); continue
        connus = dep.setdefault(cle, {})
        shas = {x['ms'] for x in parcles[cle] if x.get('ms')}
        if liste: couvert[cle] = min(d['created_at'] for d in liste)
        for d in liste:
            if (d.get('sha') or '')[:7] in shas and not (str(d['id']) in connus and connus[str(d['id'])].get('termine')): a_lire.append((cle, d))
        for id_ in [i for i, v in connus.items() if v['sha'] not in shas]: del connus[id_]
    a_lire.sort(key=lambda t: t[1]['created_at'], reverse=True)
    def statuts(t):
        cle, d = t
        try: return lire(f'repos/MoKarade/{depots[cle]}/deployments/{d["id"]}/statuses?per_page=100'), None
        except Exception as e: return None, f'{depots[cle]} : statuts du déploiement : {str(e)[:160]}'
    for (cle, d), (st, erreur) in zip(a_lire[:reste()], par(statuts, a_lire[:reste()])):
        if erreur: erreurs.append(erreur); continue
        pret, termine = etat_deploiement(st if isinstance(st, list) else [])
        dep[cle][str(d['id'])] = {'sha': (d.get('sha') or '')[:7], 'env': d.get('environment'), 'cree_le': d['created_at'], 'pret_le': pret, 'termine': termine}
    # 2. sortie du brouillon : un événement de la PR, lu une seule fois
    def evenements(x):
        try: return pret_de(_pages(lire, f"repos/MoKarade/{depots[x['r']]}/issues/{x['n']}/events?per_page=100", PAGES_EVENEMENTS), x['m']), None
        except Exception as e: return None, f"{x['r']}#{x['n']} : événements : {str(e)[:160]}"
    a_lire = [x for x in prs if f"{x['r']}#{x['n']}" not in prets][:reste()]
    for x, (pret, erreur) in zip(a_lire, par(evenements, a_lire)):
        if erreur: erreurs.append(erreur)
        else: prets[f"{x['r']}#{x['n']}"] = pret
    return {'v': VERSION, 'releve': maintenant, 'appels': compter() - base, 'restant': len([x for x in prs if f"{x['r']}#{x['n']}" not in prets]),
            'erreurs': erreurs, 'prets': dict(sorted(prets.items())), 'en_ligne': dict(sorted(associer(prs, dep).items())),
            'couvert_depuis': dict(sorted(couvert.items()))}


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
    sortie = args[0] if args else D + 'etapes.json'
    fichier_cache = D + 'etapes-cache.json'
    backlog = json.load(open(D + 'backlog.json', encoding='utf-8'))
    prlog = backlog.get('prlog')
    if prlog is None:
        print('Étapes : relevé sans prlog, rien à faire')
        return 0
    depots = {r['key']: r['repo'] for r in backlog['repos']}
    try: cache = json.load(open(fichier_cache, encoding='utf-8'))
    except (OSError, ValueError): cache = {}      # perdu : le passé se relit par paquets, rien n'est inventé
    maintenant = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    res = releve(prlog, depots, cache, ghcache.lire, maintenant, lambda: ghcache.compteurs()['comptees'], plafond_de(opt))
    for chemin, contenu in ((fichier_cache, cache), (sortie, res)):
        with open(chemin + '.tmp', 'w', encoding='utf-8') as fh: json.dump(contenu, fh, ensure_ascii=False)
        os.replace(chemin + '.tmp', chemin)
    print(f"Étapes : {len(res['prets'])} PR lues, {len(res['en_ligne'])} en ligne ({res['appels']} lectures comptées, {res['restant']} à lire"
          + (f", {len(res['erreurs'])} erreur(s)" if res['erreurs'] else '') + ')')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
