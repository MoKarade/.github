# Relevé des quotas (lecture seule) -> quota.json, lu par l'onglet « Quota » de la page de suivi.
# Règle : une jauge n'affiche que ce qui est MESURÉ ici ; ce qui ne se lit pas est dit « non lisible », jamais estimé.
# v9 (16/10/2026) : relevés plus précis ET plus fréquents.
#   - lecture GitHub avec ETag (ghcache.py) : un relevé qui ne trouve rien de nouveau ne coûte presque rien, donc il peut passer souvent ;
#   - chaque jauge porte l'instant de sa mesure (`releve`, et `source_asof` quand la source date d'avant) et une série HORAIRE (`par_heure`, 48 h) ;
#   - Vercel : statuts de commit « Vercel » de TOUS les dépôts (public ou privé), prévisualisations de la file de fusion comprises. Recoupé avec
#     la liste des déploiements de Vercel lui-même le 16/10/2026 (15:00-17:57 UTC) : 36 contre 36, projet par projet ;
#   - Jules : l'instant exact où l'étiquette `jules` est posée (lu dans le relevé du backlog), pas la date de dernière modification ;
#   - Gemini : l'instant où l'étiquette `gemini:fait` ou `gemini:echec` est posée, et `libere_a` (quand une place se libère).
# Usage : python3 quota.py [--rapide] [--seulement=a,b] [--sortie=fichier]
#   (sans option : tout, Actions sur le mois entier ; --rapide : Actions sur 36 h seulement, tout le reste identique)
import re, json, sys, os, datetime, math, urllib.request
from concurrent.futures import ThreadPoolExecutor
from zoneinfo import ZoneInfo
import ghcache

OPT = {a.split('=', 1)[0]: (a.split('=', 1) + [''])[1] for a in sys.argv[1:] if a.startswith('--')}
D = os.path.dirname(os.path.abspath(__file__)) + '/'
TZ = ZoneInfo('America/Toronto')
UTC = datetime.timezone.utc
NOW = datetime.datetime.now(UTC)
REPOS = ['.github', 'FinanceAI', 'JobAI', 'batchchef-', 'driveai', 'Hubperso', 'carai', 'memoryai', 'app-template', 'hub-contract']
TOUTES = ['actions', 'vercel', 'jules', 'gemini', 'claude', 'api']
CHOISIES = [g for g in OPT['--seulement'].split(',') if g in TOUTES] if OPT.get('--seulement') else TOUTES
RAPIDE = '--rapide' in OPT
SORTIE = OPT.get('--sortie') or D + 'quota.json'

def gh(path): return ghcache.lire(path)
def pages(path, key=None, stop=None, maxp=30):
    """Pages successives d'une liste ; stop(item) -> True arrête (les listes sont triées du plus récent au plus ancien)."""
    out = []
    for p in range(1, maxp + 1):
        d = gh(path + ('&' if '?' in path else '?') + f'per_page=100&page={p}')
        items = d[key] if key else d
        if not items: break
        for it in items:
            if stop and stop(it): return out
            out.append(it)
        if len(items) < 100: break
    return out
def t(s): return datetime.datetime.fromisoformat(s.replace('Z', '+00:00')) if s else None
def iso(d): return d.astimezone(UTC).strftime('%Y-%m-%dT%H:%M:%SZ')
H = datetime.timedelta(hours=1)

# ---- périodes (heure du Québec) ----
loc = NOW.astimezone(TZ)
sem0 = (loc - datetime.timedelta(days=loc.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)   # lundi 00:00
sem1 = sem0 + datetime.timedelta(days=7)
mois0 = loc.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
mois1 = (mois0 + datetime.timedelta(days=32)).replace(day=1)
# ZoneInfo : l'addition de timedelta garde l'heure murale ; on la recale sur minuit
sem1 = datetime.datetime(sem1.year, sem1.month, sem1.day, tzinfo=TZ)
mois1 = datetime.datetime(mois1.year, mois1.month, mois1.day, tzinfo=TZ)
jours7 = [(datetime.datetime(loc.year, loc.month, loc.day, tzinfo=TZ) - datetime.timedelta(days=i)) for i in range(6, -1, -1)]
def jour_de(d): return d.astimezone(TZ).strftime('%Y-%m-%d')
H0 = NOW.replace(minute=0, second=0, microsecond=0) - 47 * H          # 48 heures pleines, la dernière en cours
def serie_heures(evts, parts=()):
    """evts : liste de (instant, classe). -> {'debut', 'total': [48], 'parts': {classe: [48]}}"""
    tot, p = [0] * 48, {k: [0] * 48 for k in parts}
    for d, cls in evts:
        i = int((d - H0).total_seconds() // 3600)
        if 0 <= i < 48:
            tot[i] += 1
            if cls in p: p[cls][i] += 1
    return {'debut': iso(H0), 'total': tot, **({'parts': p} if parts else {})}
def par_jour(evts, jours):
    j = {d: 0 for d in jours}
    for d, _ in evts: j[jour_de(d)] = j.get(jour_de(d), 0) + 1
    return {d: j.get(d, 0) for d in jours}
def fenetre24(evts, duree=24):
    """Événements des 24 dernières heures, et les instants où chacun sortira de la fenêtre (une place se libère)."""
    vifs = sorted(d for d, _ in evts if NOW - d <= duree * H)
    return len(vifs), [iso(d + duree * H) for d in vifs]

cache_f = D + 'quota_cache.json'
try: cache = json.load(open(cache_f))
except Exception: cache = {}
cache.setdefault('runs', {})
cache_avant = json.dumps(cache, sort_keys=True, ensure_ascii=False)

out = {'v': 9, 'asof': iso(NOW), 'tz': 'America/Toronto',
       'semaine': {'debut': iso(sem0), 'fin': iso(sem1)}, 'mois': {'debut': iso(mois0), 'fin': iso(mois1)},
       'jours': [jour_de(j) for j in jours7], 'jauges': {}}

def prive(r):
    """Dépôt privé ? (relu une fois par jour)"""
    c = cache.setdefault('prive', {})
    if r in c and NOW - t(c[r]['t']) < 24 * H: return c[r]['p']
    p = bool(gh(f'repos/MoKarade/{r}').get('private'))
    c[r] = {'p': p, 't': iso(NOW)}
    return p

# ---- 1. Minutes GitHub Actions (dépôts PRIVÉS seulement ; les dépôts publics sont gratuits) ----
def actions():
    privees = [r for r in REPOS if prive(r)]
    since = iso(mois0)
    # relevé rapide : seulement les exécutions des 36 dernières heures (les plus anciennes sont déjà en cache) ; le relevé complet relit le mois
    depuis = iso(max(mois0, NOW - 36 * H)) if RAPIDE else since
    todo, en_cours = [], []
    for r in privees:
        for run in pages(f'repos/MoKarade/{r}/actions/runs?created=%3E%3D{depuis}', 'workflow_runs'):
            key = f"{r}/{run['id']}/{run.get('run_attempt', 1)}"
            if run['status'] != 'completed': en_cours.append((r, run))
            if key in cache['runs'] and run['status'] == 'completed': continue
            todo.append((r, run, key))
    def mesure(x):
        r, run, key = x
        mins, par_j = 0, {}
        for j in gh(f"repos/MoKarade/{r}/actions/runs/{run['id']}/attempts/{run.get('run_attempt', 1)}/jobs?per_page=100")['jobs']:
            if not j.get('started_at') or not j.get('completed_at'): continue
            if not j.get('runner_id') and not j.get('runner_name'): continue      # jamais attribué à une machine : rien de facturé (ex. job Dependabot annulé au bout de 24 h)
            lab = [l.lower() for l in j.get('labels', [])]
            if 'self-hosted' in lab or j.get('runner_group_name') not in (None, 'GitHub Actions', 'Default') and 'self-hosted' in str(j.get('runner_name', '')).lower(): continue
            sec = (t(j['completed_at']) - t(j['started_at'])).total_seconds()
            if sec <= 0: continue
            mult = 10 if any('macos' in l for l in lab) else 2 if any('windows' in l for l in lab) else 1
            m = math.ceil(sec / 60) * mult
            mins += m; d = jour_de(t(j['started_at'])); par_j[d] = par_j.get(d, 0) + m
        return key, run['status'], {'r': r, 'm': mins, 'j': par_j, 'c': run['created_at']}
    with ThreadPoolExecutor(8) as ex:
        for key, st, v in ex.map(mesure, todo):
            if st == 'completed': cache['runs'][key] = v          # une exécution en cours est recomptée au relevé suivant, une fois finie
    # anciens noms de dépôts (renommés en minuscules) : entrées périmées du cache, sinon comptées en double
    for k in [k for k, v in cache['runs'].items() if v['r'] not in REPOS]: del cache['runs'][k]
    tot, par_j, par_depot = 0, {}, {}
    for k, v in cache['runs'].items():
        if v['c'] < since: continue
        tot += v['m']; par_depot[v['r']] = par_depot.get(v['r'], 0) + v['m']
        for d, m in v['j'].items(): par_j[d] = par_j.get(d, 0) + m
    # exécutions en cours : minutes déjà écoulées des jobs qui tournent (non comptées dans `utilise`, qui ne prend que le terminé)
    ec_min = 0
    for r, run in en_cours:
        try:
            for j in gh(f"repos/MoKarade/{r}/actions/runs/{run['id']}/attempts/{run.get('run_attempt', 1)}/jobs?per_page=100")['jobs']:
                if j.get('started_at') and not j.get('completed_at') and (j.get('runner_id') or j.get('runner_name')) \
                   and 'self-hosted' not in [l.lower() for l in j.get('labels', [])]:
                    ec_min += math.ceil((NOW - t(j['started_at'])).total_seconds() / 60)
        except RuntimeError: pass
    return {'nom': 'Minutes GitHub Actions', 'unite': 'min', 'periode': 'mois', 'limite': 2000, 'utilise': tot,
            'en_cours': {'runs': len(en_cours), 'min': ec_min},
            'par_jour': {d: par_j.get(d, 0) for d in out['jours']}, 'par_depot': par_depot, 'depots': privees,
            # tout le mois, jour par jour : la courbe cumulée de la page s'appuie dessus (un jour sans trace = 0 mesuré)
            'par_jour_mois': {jour_de(mois0 + datetime.timedelta(days=i, hours=12)): par_j.get(jour_de(mois0 + datetime.timedelta(days=i, hours=12)), 0)
                              for i in range(0, (min(NOW, mois1) - mois0).days + 1)},
            'mesure': 'mesuré', 'note': 'Dépôts privés seulement (' + ', '.join(privees) + '), jobs sur machines GitHub ; le robot du PC et les dépôts publics ne comptent pas. Chaque job arrondi à la minute. Une exécution en cours n\'entre dans le total qu\'une fois finie ; ses minutes écoulées sont indiquées à part.',
            'source': 'Plan GitHub Free : 2 000 min/mois (docs/couts.md de CarAI)'}

# ---- 2. Déploiements Vercel (6 000 par jour et 450 par heure pour tout le compte, plan Pro ; Hobby = 100 par jour) ----
# Le plafond de 100 par jour était celui du plan gratuit : le compte est en Pro (HANDOVER CarAI et DriveAI, 13/08/2026) et Vercel a construit
# ~468 déploiements en 24 h le 16/10 sans un seul refus, ce que Hobby interdit. Limites lues sur vercel.com/docs/limits (page du 16/09/2026).
# Méthode : chaque déploiement Vercel laisse un statut de commit « Vercel » (en cours, puis « Deployment has completed » ou
# « Canceled by Ignored Build Step »). Commits examinés : la branche par défaut (production), la tête de chaque PR hors `claude/*`
# (celles de la file de fusion `mergify/merge-queue/*` donnent les prévisualisations), et tous les commits des PR hors file de fusion.
# Les branches `claude/*` ne déploient pas (deploymentEnabled:false) : on ne les examine pas.
LIMITE_VERCEL_JOUR, LIMITE_VERCEL_HEURE = 6000, 450
REPOS_VERCEL = ['FinanceAI', 'JobAI', 'batchchef-', 'Hubperso', 'driveai', 'carai', 'memoryai']      # un projet Vercel chacun
def vercel():
    cv = cache.setdefault('vercel', {'derniers': {}, 'commits': {}})
    debut = NOW - 48 * H
    def candidats(r):
        der = t(cv['derniers'].get(r)) if cv['derniers'].get(r) else None
        # première lecture : 48 h ; ensuite on ne regarde que ce qui a bougé depuis le relevé précédent, avec 2 h de marge
        seuil = max(debut, der - 2 * H) if der else debut
        shas = {}
        dflt = gh(f'repos/MoKarade/{r}')['default_branch']
        for c in pages(f'repos/MoKarade/{r}/commits?sha={dflt}&since={iso(seuil)}', None, maxp=5): shas[c['sha']] = 1
        for pr in pages(f'repos/MoKarade/{r}/pulls?state=all&sort=updated&direction=desc', None, stop=lambda x: x['updated_at'] < iso(seuil), maxp=6):
            ref = pr['head']['ref']
            if ref.startswith('claude/'): continue
            shas[pr['head']['sha']] = 1
            if not ref.startswith('mergify/'):
                for c in gh(f"repos/MoKarade/{r}/pulls/{pr['number']}/commits?per_page=100"): shas[c['sha']] = 1
        return r, shas
    def statuts(x):
        r, sha = x
        ss = [s for s in gh(f'repos/MoKarade/{r}/commits/{sha}/statuses?per_page=100') if str(s.get('context', '')).lower().startswith('vercel')]
        if not ss: return r, sha, None
        ss.sort(key=lambda s: s['created_at'])
        fin = ss[-1]; desc = fin.get('description') or ''
        if fin['state'] == 'pending': return r, sha, ['pending', ss[0]['created_at']]
        cls = 'ignore' if re.search(r'ignored build|skipp', desc, re.I) else 'annule' if re.search(r'cancel', desc, re.I) else 'construit' if fin['state'] == 'success' else 'echec'
        return r, sha, [cls, ss[0]['created_at']]
    lus, nonlus = [], []
    with ThreadPoolExecutor(7) as ex: cands = list(ex.map(lambda r: _essai(candidats, r), REPOS_VERCEL))
    todo = []
    for r, res in zip(REPOS_VERCEL, cands):
        if isinstance(res, Exception): nonlus.append(r); continue
        lus.append(r)
        for sha in res[1]:
            if cv['commits'].get(r, {}).get(sha, ['pending'])[0] == 'pending': todo.append((r, sha))
    with ThreadPoolExecutor(8) as ex: lectures = list(ex.map(lambda x: _essai(statuts, x), todo))
    for x, res in zip(todo, lectures):
        if isinstance(res, Exception): continue
        r, sha, v = res
        if v: cv['commits'].setdefault(r, {})[sha] = v
    for r in lus: cv['derniers'][r] = iso(NOW)
    # oublie ce qui a plus de 8 jours
    garde = iso(NOW - datetime.timedelta(days=8))
    for r in list(cv['commits']):
        cv['commits'][r] = {s: v for s, v in cv['commits'][r].items() if v[1] >= garde}
    evts = [(t(v[1]), v[0]) for r in REPOS_VERCEL for v in cv['commits'].get(r, {}).values() if t(v[1]) >= debut and v[0] != 'pending' or (v[0] == 'pending' and t(v[1]) >= debut)]
    evts = [(t(v[1]), 'construit' if v[0] == 'pending' else v[0]) for r in REPOS_VERCEL for v in cv['commits'].get(r, {}).values() if t(v[1]) >= debut]
    n24, _ = fenetre24(evts)
    n1h = sum(1 for d, _ in evts if NOW - d <= H)
    par_classe = {}
    for d, c in evts:
        if NOW - d <= 24 * H: par_classe[c] = par_classe.get(c, 0) + 1
    par_depot = {}
    for r in REPOS_VERCEL:
        par_depot[r] = sum(1 for v in cv['commits'].get(r, {}).values() if t(v[1]) >= NOW - 24 * H)
    return {'nom': 'Déploiements Vercel', 'unite': 'déploiements', 'periode': 'jour', 'limite': LIMITE_VERCEL_JOUR, 'limite_heure': LIMITE_VERCEL_HEURE,
            'utilise': n24, 'utilise_heure': n1h, 'par_classe': par_classe, 'par_depot': par_depot,
            'par_jour': par_jour(evts, out['jours']), 'par_heure': serie_heures(evts, ('construit', 'ignore', 'annule', 'echec')),
            'mesure': 'mesuré' if not nonlus else 'partiel', 'depots': lus, 'non_lus': nonlus,
            'alerte': f'Au-dessus de {LIMITE_VERCEL_JOUR // 1000} 000 par jour (plafond du plan Pro) alors que Vercel déploie toujours : le plan est peut-être autre. À vérifier dans Vercel > Settings > Billing.' if n24 > LIMITE_VERCEL_JOUR else None,
            'note': 'Chaque déploiement laisse un statut « Vercel » sur son commit : on les lit tous, dépôts publics et privés, file de fusion comprise. « Construit » = build lancé ; « ignoré » = build sauté par l\'étape d\'ignorance (docs, tests). Les branches claude/* ne déploient pas. Recoupé avec la liste de Vercel le 16/10 : 36 déploiements des deux côtés, projet par projet.' + (' Non lus : ' + ', '.join(nonlus) + '.' if nonlus else ''),
            'source': 'Statuts de commit GitHub, recoupés avec la liste des déploiements de Vercel (16/10/2026). Plan Pro : 6 000/jour et 450/heure (vercel.com/docs/limits, page du 16/09/2026), déduit de ~468 déploiements en 24 h le 16/10 que Hobby (100/jour) refuserait ; HANDOVER de CarAI et de DriveAI : « Marc a pris Vercel Pro » (13/08/2026).'}

def _essai(f, x):
    """Un échec isolé ne doit pas faire tomber la jauge : on le rend, l'appelant décide."""
    try: return f(x)
    except Exception as e: return e

# ---- 3. Jules (Google AI Pro : 100 tâches par jour glissant, 15 en parallèle) ----
# Une tâche Jules démarre quand l'étiquette `jules` est posée sur une issue ; elle est retirée à la fin (la PR est au nom de Marc).
# L'instant de pose vient du relevé du backlog (fetch.py : champ `jules_at`, lu dans les événements de l'issue).
def jules():
    f = D + 'backlog.json'
    b = json.load(open(f))
    age = (NOW - t(b['asof'])).total_seconds()
    evts = []
    for r in b['repos']:
        for n in r['nodes'].values():
            for a in n.get('jules_at') or ([n['start']] if n.get('jules') and n.get('start') else []):
                if a and t(a) >= NOW - 8 * 24 * H: evts.append((t(a), r['repo'] + '#' + str(n['n'])))
    n24, libere = fenetre24(evts)
    g = {'nom': 'Jules', 'unite': 'tâches', 'periode': 'jour', 'limite': 100, 'utilise': n24, 'par_jour': par_jour(evts, out['jours']),
         'par_heure': serie_heures(evts), 'libere_a': libere[:20], 'concurrence': 15, 'source_asof': b['asof'],
         'mesure': 'mesuré',
         'note': 'Heure exacte où l\'étiquette `jules` est posée sur une issue, 24 h glissantes. Une tâche lancée depuis l\'interface de Jules ne laisse aucune trace dans GitHub et n\'est pas comptée : le vrai compteur est dans l\'interface de Jules.',
         'source': 'Google AI Pro : 100 tâches/jour, 15 en parallèle (jules.google/docs/usage-limits)'}
    if age > 30 * 60: g['perime'] = b['asof']
    return g

# ---- 4. Gemini (plafond maison de 15 demandes par 24 h ; plafond Google : 1 500 par jour) ----
# Le script du PC pose `gemini:fait` ou `gemini:echec` quand il a répondu : c'est l'instant de la demande consommée (plans/2026-10-15_integration-gemini.md).
PUBLICS_GEMINI = None
def gemini():
    cg = cache.setdefault('gemini', {})
    debut = NOW - 8 * 24 * H
    publics = [r for r in REPOS if not prive(r)]        # « rien de privé » : Gemini ne lit que les dépôts publics
    def lister(rl):
        r, lab = rl
        return pages(f'repos/MoKarade/{r}/issues?state=all&labels={lab}&since={iso(debut)}', None, maxp=3)
    couples = [(r, lab) for r in publics for lab in ('gemini:fait', 'gemini:echec', 'gemini')]
    with ThreadPoolExecutor(8) as ex: listes = list(ex.map(lambda x: _essai(lister, x), couples))
    termines, attente, nonlus = {}, {}, []
    for (r, lab), its in zip(couples, listes):
        if isinstance(its, Exception): nonlus.append(f'{r} ({lab})'); continue
        for i in its:
            k = f"{r}#{i['number']}"
            if lab == 'gemini': attente[k] = i
            else: termines[k] = i
    for k in list(attente):
        if k in termines: del attente[k]
    def evenements(k):
        i = termines[k]; r, n = k.split('#')
        c = cache_g = cache['gemini'].get(k)
        if c and c['u'] == i['updated_at']: return k, c
        ev = gh(f'repos/MoKarade/{r}/issues/{n}/events?per_page=100')
        poses = sorted(e['created_at'] for e in ev if e['event'] == 'labeled' and (e.get('label') or {}).get('name') in ('gemini:fait', 'gemini:echec'))
        return k, {'u': i['updated_at'], 't': poses[-1] if poses else None, 'pr': 'pull_request' in i}
    with ThreadPoolExecutor(8) as ex: evs = list(ex.map(lambda k: _essai(evenements, k), list(termines)))
    evts, nb_pr = [], 0
    for k, res in zip(termines, evs):
        if isinstance(res, Exception): nonlus.append(k); continue
        k, c = res
        cache['gemini'][k] = c
        if c['t'] and t(c['t']) >= debut: evts.append((t(c['t']), 'pr' if c['pr'] else 'demande'))
    for k in list(cache['gemini']):
        if k not in termines: del cache['gemini'][k]
    n24, libere = fenetre24(evts)
    for d, c in evts:
        if NOW - d <= 24 * H and c == 'pr': nb_pr += 1
    return {'nom': 'Gemini', 'unite': 'demandes', 'periode': 'jour', 'limite': 15, 'utilise': n24, 'par_jour': par_jour(evts, out['jours']),
            'par_heure': serie_heures(evts), 'libere_a': libere[:20], 'dont_pr': nb_pr, 'dont_demandes': n24 - nb_pr, 'en_attente': len(attente),
            'reserve_demandes': 5, 'plafond_auto': 10, 'limite_google': 1500, 'non_lus': nonlus,
            'mesure': 'mesuré' if not nonlus else 'partiel',
            'note': 'Heure exacte où le script du PC pose `gemini:fait` ou `gemini:echec`, 24 h glissantes, dépôts publics. Plafond maison 15 par 24 h dont 5 gardées aux demandes étiquetées (10 au plus en relecture automatique) ; Google en permet 1 500 par jour à un abonné AI Pro. « En attente » = étiquette `gemini` posée, pas encore traitée. Les jetons consommés ne se lisent pas ici.',
            'source': 'Plafond maison (plans/2026-10-15_integration-gemini.md) ; Google : 1 500/jour, 120/min (developers.google.com/gemini-code-assist/resources/quotas)'}

def claude():
    # le PC (tâche « Quota-Claude », chaque heure) écrit /usage dans le corps de MoKarade/.github#45 ; ici on le relit
    body = gh('repos/MoKarade/.github/issues/45')['body'] or ''
    m = re.search(r'```json\s*(\{.*?\})\s*```', body, re.S)
    if not m: raise RuntimeError('bloc json absent de .github#45')
    d = json.loads(m.group(1))
    if d.get('pct') is None or not d.get('reset_utc'): raise RuntimeError('pct ou reset_utc absent de .github#45')
    age = (NOW - t(d['mesure_utc'])).total_seconds() / 3600 if d.get('mesure_utc') else None
    g = {'nom': 'Claude (abonnement, semaine)', 'unite': '%', 'periode': 'semaine', 'limite': 100, 'utilise': d['pct'], 'reset_utc': d['reset_utc'],
         'mesure_utc': d.get('mesure_utc'), 'source_asof': d.get('mesure_utc'), 'session': d.get('session'), 'par_modele': d.get('par_modele'),
         'mesure': 'mesuré par le PC (' + str(d.get('source', 'claude /usage')) + ')' + (f', il y a {age:.1f} h' if age is not None else ''),
         'note': 'Lu sur le PC par la tâche « Quota-Claude », aucune saisie. La remise à zéro est celle de ta semaine Claude, pas le lundi. La précision de la courbe est celle de cette tâche : un point par passage.',
         'source': 'claude /usage sur le PC, relayé par MoKarade/.github#45'}
    if age is None or age > 3: g['perime'] = d.get('mesure_utc') or 'inconnue'
    # historique des mesures : la source ne garde que la dernière, la courbe de la semaine se construit ici, relevé après relevé
    f = D + 'quota_hist.json'
    try: h = json.load(open(f))
    except Exception: h = {}
    pts = h.get('claude', [])
    if d.get('mesure_utc') and not any(p['t'] == d['mesure_utc'] for p in pts):
        pts.append({'t': d['mesure_utc'], 'pct': d['pct'], 'session': (d.get('session') or {}).get('pct')})
    garde = (NOW - datetime.timedelta(days=21)).strftime('%Y-%m-%dT%H:%MZ')
    h['claude'] = sorted([p for p in pts if p['t'] >= garde], key=lambda p: p['t'])
    json.dump(h, open(f + '.tmp', 'w'), ensure_ascii=False); os.replace(f + '.tmp', f)
    fin = t(d['reset_utc'])
    g['historique'] = [p for p in h['claude'] if fin - datetime.timedelta(days=7) < t(p['t']) <= fin]
    return g

def api():
    # coût API des apps, publié par Hubperso (sans jeton) : https://www.hubperso.com/api/cout
    # Hubperso#191 : le chiffre comparé au repère de 20 $/mois est le total DU MOIS (`mois.totalCad`, mesuré à `mois.dernierReleve`), pas le cumul.
    # Marc, 16/10 : « surveiller », pas de plafond dur : la jauge dit « au-dessus du repère », elle n'alarme pas. Une app illisible est nommée, jamais comptée 0.
    for essai in (1, 2):      # une coupure TLS passagère (vue le 16/10 : « UNEXPECTED_EOF ») : un second essai, pas plus
        try:
            with urllib.request.urlopen('https://www.hubperso.com/api/cout', timeout=30) as r: d = json.loads(r.read()); break
        except OSError:
            if essai == 2: raise
    if not d.get('ok') or d.get('cumulCad') is None or not d.get('dataAsOf'): raise RuntimeError('réponse /api/cout sans cumulCad ou dataAsOf')
    m = d.get('mois') or {}
    base = {'unite': d.get('devise', 'CAD'), 'taux_usd_cad': d.get('tauxUsdCad'), 'apps_lues': (d.get('apps') or {}).get('lues'),
            'cumul_cad': d['cumulCad'], 'cumul_as_of': d['dataAsOf'], 'source': 'coût : hubperso.com/api/cout ; repère de 20 $ par mois : Marc', 'mesure': 'publié par Hubperso (somme des usage.cost des apps)'}
    if m.get('totalCad') is None or not m.get('dernierReleve'):
        return {**base, 'nom': 'API Anthropic des apps (coût cumulé)', 'periode': 'total', 'utilise': d['cumulCad'], 'data_as_of': d['dataAsOf'], 'source_asof': d['dataAsOf'],
                'non_lisibles': (d.get('apps') or {}).get('nonLisibles') or [],
                'note': 'Hubperso ne publie pas encore le total du mois : seul le cumul est lisible, et il ne se compare pas au repère de 20 $/mois.'}
    return {**base, 'nom': 'API Anthropic des apps (coût du mois)', 'periode': 'mois', 'utilise': m['totalCad'], 'repere': 20,
            'mois_debut': m.get('debut'), 'partiel': bool(m.get('partiel')), 'data_as_of': m['dernierReleve'], 'source_asof': m['dernierReleve'],
            'non_lisibles': m.get('nonLisibles') or [],
            'note': 'Total du mois en cours, comparé au repère de 20 $ par mois que Marc surveille (pas de plafond dur, décision du 16/10). Les apps dont le coût est illisible sont nommées et ne sont pas comptées : ce n\'est pas un zéro.'}

FONCTIONS = {'actions': actions, 'vercel': vercel, 'jules': jules, 'gemini': gemini, 'claude': claude, 'api': api}
def lancer(k):
    try:
        g = FONCTIONS[k]()
        g['releve'] = iso(NOW)
        return k, g
    except Exception as e:
        return k, {'nom': k, 'erreur': str(e)[:200]}
with ThreadPoolExecutor(6) as ex: resultats = dict(ex.map(lancer, CHOISIES))
for k in TOUTES:
    if k in resultats:
        out['jauges'][k] = resultats[k]
        print(k, {a: b for a, b in resultats[k].items() if a in ('utilise', 'erreur', 'mesure')}, file=sys.stderr)

# jauges non relevées cette fois, ou en échec : on garde l'ancienne mesure, en le disant
try:
    old = json.load(open(SORTIE))
    for k in TOUTES:
        o = (old.get('jauges') or {}).get(k)
        if k not in out['jauges'] and o: out['jauges'][k] = o
        elif 'erreur' in out['jauges'].get(k, {}) and o and 'erreur' not in o:
            e = out['jauges'][k]['erreur']; o['perime'] = old['asof']; o['erreur'] = e; out['jauges'][k] = o
except Exception: pass
c = ghcache.compteurs()
out['appels'] = {'comptes': c['comptees'], 'gratuits_304': c['n304']}

if json.dumps(cache, sort_keys=True, ensure_ascii=False) != cache_avant:
    json.dump(cache, open(cache_f + '.tmp', 'w'), ensure_ascii=False); os.replace(cache_f + '.tmp', cache_f)
json.dump(out, open(SORTIE + '.tmp', 'w'), ensure_ascii=False); os.replace(SORTIE + '.tmp', SORTIE)
print(f"quota : {c['comptees']} appels comptés, {c['n304']} en 304 gratuits", file=sys.stderr)
