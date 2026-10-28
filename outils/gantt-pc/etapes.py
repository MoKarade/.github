#!/usr/bin/env python3
# etapes.py (28/10/2026, tâche .github#689) : deux heures que `prlog` n'a pas, pour la durée moyenne de chaque étape de la page Chantier.
#   prets    : quand la PR est sortie du brouillon (dernier `ready_for_review` avant la fusion) ; None = lue, jamais brouillon
#   en_ligne : le déploiement dont le commit est le commit de fusion (`ms` de prlog), avec l'heure de son statut `success` (= en ligne)
# -> etapes.json, repris par build.py comme champ `etapes` de donnees.json.
# Règles : 0 $ ; LECTURE PAR GRAPHQL, jamais par l'API REST : la limite GraphQL (5 000 points/h) est séparée de la limite REST « core » que les tours et les sessions du PC
# ont vidée le 28/10/2026 (tours sautés, 15 lectures par tour dont aucune n'allait aux PR). Une requête lit 20 PR (leurs sorties du brouillon) ou 100 déploiements (avec leurs
# statuts) pour environ 1 à 2 points. Un événement ou un déploiement terminé ne change plus : chaque résultat est mémorisé à vie (etapes-cache.json) et seules les nouvelles
# fusions coûtent une lecture ; au plus PLAFOND_REQUETES requêtes par tour (le passé se rattrape par paquets, fusions les plus récentes d'abord) ;
# jamais de fake data : une lecture qui échoue n'écrit rien (la clé reste absente, le tour suivant réessaie), une PR sans déploiement n'a pas d'`en_ligne`, une PR introuvable
# ou dont la date de fusion n'est pas celle de prlog (autre dépôt qui reprend les numéros) est comptée dans `absents` et jamais attribuée à une autre.
# Usage : python3 etapes.py [sortie.json] [--plafond=n]   (lit backlog.json : `prlog` et `repos` ; --plafond = requêtes GraphQL)
import datetime, json, os, subprocess, sys, threading
from concurrent.futures import ThreadPoolExecutor

VERSION = 2
PLAFOND_REQUETES = 16
PRS_PAR_REQUETE = 20
PAGES_DEPLOIEMENTS = 4        # 100 déploiements par page : Hubperso en fait ~20 par jour
SANS_DEPLOIEMENT_H = 6        # une fusion plus ancienne, dont le commit n'a aucun déploiement dans une liste qui la couvre, n'en aura pas (build sauté)
JOURS = 35                # fenêtre des moyennes de la page (30 jours + marge) : le passé plus ancien ne sert pas
PARALLELES = 3            # requêtes simultanées (un `gh` par requête, ~2 s chacun sous Windows)
PROPRIETAIRE = 'MoKarade'
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


class Plafond(Exception): pass


def _gq(valeur): return json.dumps(valeur)       # une chaîne GraphQL est une chaîne JSON


def requete_prets(cibles):
    """cibles : [(alias, dépôt, numéro)] -> UNE requête GraphQL qui lit, pour chacune, la date de fusion et ses sorties du brouillon (`READY_FOR_REVIEW_EVENT`)."""
    corps = ' '.join(f'{a}: repository(owner: {_gq(PROPRIETAIRE)}, name: {_gq(d)}) {{ pullRequest(number: {n}) {{ mergedAt '
                     f'timelineItems(last: 20, itemTypes: [READY_FOR_REVIEW_EVENT]) {{ nodes {{ ... on ReadyForReviewEvent {{ createdAt }} }} }} }} }}' for a, d, n in cibles)
    return 'query { ' + corps + ' }'


def requete_deploiements(depot, apres=None):
    """Une page de 100 déploiements d'un dépôt, les plus récents d'abord, avec le commit et les statuts (aucune lecture de plus par déploiement)."""
    suite = f', after: {_gq(apres)}' if apres else ''
    return (f'query {{ repository(owner: {_gq(PROPRIETAIRE)}, name: {_gq(depot)}) {{ deployments(first: 100, orderBy: {{field: CREATED_AT, direction: DESC}}{suite}) '
            '{ nodes { databaseId createdAt environment commitOid statuses(first: 20) { nodes { state createdAt } } } pageInfo { hasNextPage endCursor } } } }')


def graphql_gh(requete):
    """Lecture réelle par `gh api graphql` : la limite GraphQL (5 000 points/h) est SÉPARÉE de la limite REST « core » que les tours et les sessions du PC vident ;
    une requête de cent déploiements ou de vingt PR coûte environ 1 à 2 points. Rend le JSON ; lève si la réponse n'est pas lisible ou n'a pas de `data`."""
    r = subprocess.run(['gh', 'api', 'graphql', '-f', 'query=' + requete], capture_output=True, text=True, timeout=120)
    try: corps = json.loads(r.stdout)
    except ValueError: raise RuntimeError(f'gh code {r.returncode} : {(r.stderr or r.stdout).strip()[:160]}')
    if not isinstance(corps, dict) or corps.get('data') is None:
        raise RuntimeError('GraphQL sans data : ' + str((corps or {}).get('errors') or r.stderr)[:160])
    return corps


def releve(prlog, depots, cache, graphql, maintenant, plafond=PLAFOND_REQUETES, paralleles=PARALLELES):
    """prlog : liste de {r, n, m, ms?} (déjà limitée à la fenêtre) ; depots : {clé: nom du dépôt} ; cache : {'prets', 'dep', 'sans', 'absents'} (modifié en place) ;
    graphql(requête) -> dict. Rend le dict du fichier. Ne lève jamais pour une lecture : une lecture qui échoue n'écrit rien et se dit dans `erreurs`.
    Au plus `plafond` requêtes GraphQL (moitié pour les PR, le reste pour les déploiements), les fusions les plus récentes d'abord."""
    erreurs, compte, verrou = [], [0], threading.Lock()
    prets, dep = cache.setdefault('prets', {}), cache.setdefault('dep', {})
    sans, absents = cache.setdefault('sans', {}), cache.setdefault('absents', {})
    def lire(requete):
        with verrou:
            if compte[0] >= plafond: raise Plafond()          # le plafond vaut pour TOUT le tour, tous dépôts confondus
            compte[0] += 1
        return graphql(requete)
    def par(f, items):
        with ThreadPoolExecutor(max(1, paralleles)) as ex: return list(ex.map(f, items))
    cle_de = lambda x: f"{x['r']}#{x['n']}"
    prs = sorted((x for x in prlog if x.get('m') and x.get('r') in depots), key=lambda x: x['m'], reverse=True)
    cles = {cle_de(x) for x in prs}
    for registre in (prets, sans, absents):
        for k in [k for k in registre if k not in cles]: del registre[k]
    # 1. sortie du brouillon : la chronologie de la PR, lue une seule fois. Une PR introuvable, ou dont la date de fusion n'est pas celle de prlog (autre dépôt qui reprend
    # les numéros : bascule de FinanceAI vers son archive, 28/10/2026), est mise à part : jamais attribuée à une autre PR, jamais relue.
    a_lire = [x for x in prs if cle_de(x) not in prets and cle_de(x) not in absents][:max(1, plafond // 2) * PRS_PAR_REQUETE]
    lots = [a_lire[i:i + PRS_PAR_REQUETE] for i in range(0, len(a_lire), PRS_PAR_REQUETE)]
    def lire_lot(lot):
        try: return lire(requete_prets([(f'p{i}', depots[x['r']], x['n']) for i, x in enumerate(lot)])), None
        except Exception as e: return None, f'PR : chronologie : {str(e)[:160]}'
    for lot, (rep, erreur) in zip(lots, par(lire_lot, lots)):
        if erreur: erreurs.append(erreur); continue
        for i, x in enumerate(lot):
            depot = (rep.get('data') or {}).get(f'p{i}')
            if depot is None: erreurs.append(f'{cle_de(x)} : dépôt illisible'); continue         # erreur de lecture (droits, limite) : rien d'écrit, nouvel essai
            pr = depot.get('pullRequest')
            if pr is None or pr.get('mergedAt') != x['m']: absents[cle_de(x)] = True; continue
            evenements = [{'event': 'ready_for_review', 'created_at': n['createdAt']} for n in (pr.get('timelineItems') or {}).get('nodes') or [] if n and n.get('createdAt')]
            prets[cle_de(x)] = pret_de(evenements, x['m'])
    # 2. déploiements : seulement les dépôts qui ont encore une fusion sans déploiement lu, et seulement jusqu'à la plus ancienne de ces fusions
    def resolue(x):
        if cle_de(x) in sans or cle_de(x) in absents: return True
        return any(d.get('termine') and d['sha'] == x.get('ms') for d in dep.get(x['r'], {}).values())
    parcles = {}
    for x in prs:
        if x.get('ms') and not resolue(x): parcles.setdefault(x['r'], []).append(x)
    couvert = {}
    def lister(cle):
        nodes, apres, pages = [], None, 0
        try:
            while pages < PAGES_DEPLOIEMENTS:
                depot = (lire(requete_deploiements(depots[cle], apres)).get('data') or {}).get('repository')
                if depot is None: return None, f'{depots[cle]} : déploiements : dépôt illisible'
                page = depot['deployments']; pages += 1
                nodes += page['nodes']
                if not page['pageInfo']['hasNextPage'] or min(n['createdAt'] for n in page['nodes']) < min(x['m'] for x in parcles[cle]): break
                apres = page['pageInfo']['endCursor']
            return nodes, None
        except Plafond: return nodes, None          # plafond atteint : ce qui est lu sert (couvert_depuis dit jusqu'où), le reste au tour suivant
        except Exception as e: return None, f'{depots[cle]} : déploiements : {str(e)[:160]}'
    for cle, (nodes, erreur) in zip(parcles, par(lister, list(parcles))):
        if erreur: erreurs.append(erreur); continue
        connus = dep.setdefault(cle, {})
        if nodes: couvert[cle] = min(n['createdAt'] for n in nodes)
        shas = {x['ms'] for x in parcles[cle]}
        for n in nodes:
            if (n.get('commitOid') or '')[:7] not in shas: continue
            pret, termine = etat_deploiement([{'state': (s.get('state') or '').lower(), 'created_at': s.get('createdAt')} for s in (n.get('statuses') or {}).get('nodes') or []])
            connus[str(n['databaseId'])] = {'sha': n['commitOid'][:7], 'env': n.get('environment'), 'cree_le': n['createdAt'], 'pret_le': pret, 'termine': termine}
        # une fusion de plus de 6 h que la liste couvre sans qu'aucun déploiement porte son commit n'en aura pas (build sauté : docs, .github) : plus relue
        limite = (datetime.datetime.fromisoformat(maintenant.replace('Z', '+00:00')) - datetime.timedelta(hours=SANS_DEPLOIEMENT_H)).strftime('%Y-%m-%dT%H:%M:%SZ')
        for x in parcles[cle]:
            if cle in couvert and couvert[cle] <= x['m'] <= limite and not any(d['sha'] == x['ms'] for d in connus.values()): sans[cle_de(x)] = True
    for cle in list(dep):
        shas = {x['ms'] for x in prs if x['r'] == cle and x.get('ms')}
        for id_ in [i for i, v in dep[cle].items() if v['sha'] not in shas]: del dep[cle][id_]
    return {'v': VERSION, 'releve': maintenant, 'appels': compte[0], 'restant': len([x for x in prs if cle_de(x) not in prets and cle_de(x) not in absents]),
            'absents': len([x for x in prs if cle_de(x) in absents]),
            'erreurs': erreurs, 'prets': dict(sorted(prets.items())), 'en_ligne': dict(sorted(associer(prs, dep).items())),
            'couvert_depuis': dict(sorted(couvert.items()))}


def recentes(prlog, maintenant, jours=JOURS):
    """Les fusions des `jours` derniers jours (dates UTC 'Z' : l'ordre des chaînes est l'ordre du temps)."""
    coupure = (datetime.datetime.fromisoformat(maintenant.replace('Z', '+00:00')) - datetime.timedelta(days=jours)).strftime('%Y-%m-%dT%H:%M:%SZ')
    return [x for x in prlog if x.get('m') and x['m'] >= coupure]


def plafond_de(opt):
    """--plafond=n -> n (entier > 0), sinon PLAFOND_REQUETES ; une valeur illisible est refusée plutôt qu'ignorée."""
    if 'plafond' not in opt: return PLAFOND_REQUETES
    n = int(opt['plafond'])
    if n <= 0: raise ValueError('--plafond doit être un entier positif')
    return n


def main(argv):
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
    res = releve(recentes(prlog, maintenant), depots, cache, graphql_gh, maintenant, plafond_de(opt))
    for chemin, contenu in ((fichier_cache, cache), (sortie, res)):
        with open(chemin + '.tmp', 'w', encoding='utf-8') as fh: json.dump(contenu, fh, ensure_ascii=False)
        os.replace(chemin + '.tmp', chemin)
    print(f"Étapes : {len(res['prets'])} PR lues, {len(res['en_ligne'])} en ligne ({res['appels']} requêtes GraphQL, {res['restant']} à lire, {res['absents']} absentes"
          + (f", {len(res['erreurs'])} erreur(s)" if res['erreurs'] else '') + ')')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
