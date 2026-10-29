import json, os, re, sys, datetime, subprocess, shutil
import defauts_preuve      # preuves en retard pour le filet du PC (tâche .github#513)
import couts_manuels      # registre des dépenses lu dans un fichier privé du PC (.github#636)
# v5 gardée dans fetch_v5.py / build_v5.py + page5.html
# v6 (15/10/2026) : cahier des charges du §13 de MoKarade/.github docs/archive/cycle-de-vie-tache-2026-10-29.md.
# v7 (16/10/2026) : la file « tâche suivante » n'est plus calculée par la page : build.py fait tourner le script de MoKarade/.github
#   (scripts/prochaine-tache.mjs, copié par fetch.py dans scripts-github/), écrit prochaines.json et l'embarque dans donnees.json.
#   RETIRÉE le 29/10/2026 (chaîne de lancement, voie courte : une étiquette `go` lance claude-code-action dans la CI de l'app) : plus de prochaines.json ; `donnees.json` garde la clé
#   `prochaines` sous la forme {'erreur': …}, forme déjà produite quand le calcul de la file échouait.
#   Corrections du rapport des défauts du backlog : « Preuve attendue » lue dans la zone qu'elle nomme (heure du Québec par défaut),
#   une étiquette `en-cours` héritée d'une tâche en `preuve-attendue` ne compte plus comme un fil, le nombre de la pastille est écrit une fois (sante.n).
# backlog.json (relevé de fetch.py) -> donnees.json (relu par la page publiée) + chantier-apps.html
# Toute la mise en page est dans page7.html + p7/ ; ce script ne fait que compacter les données et calculer la santé.
# Usage : python3 build.py [backlog.json] [suffixe]   (suffixe : sorties donnees<suffixe>.json etc., pour les essais)
D = os.path.dirname(os.path.abspath(__file__)) + '/'
SRC = sys.argv[1] if len(sys.argv) > 1 else 'backlog.json'
OUT = sys.argv[2] if len(sys.argv) > 2 else ''
gh = json.load(open(D + SRC))
UTC = datetime.timezone.utc
def iso(d): return d.astimezone(UTC).strftime('%Y-%m-%dT%H:%M:%SZ')
def pr_c(p):
    if not p: return None
    return {k: p.get(k) for k in ('n', 'repo', 'url', 'state', 'draft', 'merged', 'closed', 'upd', 'created', 'kind', 'lignes', 'c0', 'c1', 'nc', 'cs', 'au', 'jf', 'dg') if p.get(k) is not None}

# --- « Preuve attendue : AAAA-MM-JJ HH:MM (heure du Québec) — événement » -> instant UTC -------------------------------------------------
# La zone est celle que le texte nomme : UTC/GMT/Z si c'est écrit, sinon l'heure du Québec (gabarit du cycle de vie, §10). Lue en UTC par erreur,
# une échéance « 08:00 (heure du Québec) » arrivait 4 h trop tôt et déclenchait une fausse alerte (rapport des défauts, anomalie n°1).
try:
    from zoneinfo import ZoneInfo
    QC = ZoneInfo('America/Toronto')        # le Québec suit l'heure de l'Est : même règle d'heure d'été que Toronto
except Exception:
    QC = None
def _ete(naif):
    # repli sans base de fuseaux : heure d'été d'Amérique du Nord (2e dimanche de mars -> 1er dimanche de novembre, à 2 h locale)
    def dimanche(annee, mois, rang):
        j = datetime.date(annee, mois, 1); j += datetime.timedelta(days=(6 - j.weekday()) % 7 + 7 * (rang - 1)); return j
    debut = datetime.datetime.combine(dimanche(naif.year, 3, 2), datetime.time(2)); fin = datetime.datetime.combine(dimanche(naif.year, 11, 1), datetime.time(2))
    return debut <= naif < fin
def preuve_attendue(txt):
    m = re.match(r'\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})', txt or '')
    if not m: return None
    naif = datetime.datetime(*map(int, m.groups()))
    zone = (txt or '')[m.end():m.end() + 60].split('—')[0]        # la zone s'écrit juste après l'heure, avant l'événement
    if re.search(r'^(?::\d{2})?\s*Z\b|\b(?:UTC|GMT)\b', zone, re.I): return naif.replace(tzinfo=UTC)
    if QC is not None: return naif.replace(tzinfo=QC).astimezone(UTC)
    return (naif + datetime.timedelta(hours=4 if _ete(naif) else 5)).replace(tzinfo=UTC)

comp = {'asof': gh['asof'], 'built': iso(datetime.datetime.now(UTC)), 'v': 7, 'repos': []}
# Durée d'une mission ou d'un chantier = celle de ses tâches (missions.py, .github#591) : `deb` première tâche commencée, `fin` dernière fermeture
# (seulement si tout est fermé), `nt` / `nf` tâches et tâches fermées, `inc` enfants absents du relevé. Un échec ne bloque pas : la page garde les dates de l'issue.
try:
    import missions
    DERIVE = missions.deriver(gh['repos'])
except Exception as _e:
    DERIVE = {}
    print('missions.deriver a échoué :', _e, file=sys.stderr)
for r in gh['repos']:
    nodes = []
    for n in r['nodes'].values():
        c = {'n': n['n'], 't': n['title'], 'l': n['lvl'], 'lb': [x for x in n['labels'] if not x.startswith('niveau:')], 'st': n['state'],
             'c': n['created'], 'x': n['closed'], 's': n['start'], 'k': n['kids'], 'pr': pr_c(n['pr']), 'd': n.get('deps', [])}
        for src, dst in (('reason', 'r'), ('av', 'av'), ('ap', 'ap'), ('fq', 'fq'), ('res', 'res'), ('pa', 'pa'), ('pa_u', 'pu'), ('geste', 'g'), ('preuve', 'pv'), ('bloque_depuis', 'bs'), ('upd', 'u'), ('et', 'et'), ('fp', 'fp'), ('rp', 'rp')):
            if n.get(src): c[dst] = n[src]
        d = DERIVE.get(f"{r['repo'].lower()}#{n['n']}")
        if d: c.update({k: v for k, v in d.items() if v is not None})
        if (n.get('pr') or {}).get('acteurs'): c['acteurs'] = n['pr']['acteurs']      # qui a travaillé : [{qui, debut, fin, commits}], lu dans les commits de la PR (acteurs.py)
        if n.get('jules'): c['j'] = 1
        if n.get('jules_at'): c['ja'] = n['jules_at']
        pa = preuve_attendue(n.get('pa'))
        if pa: c['pt'] = iso(pa)        # l'instant de l'échéance, calculé ici une fois : la page ne réinterprète pas le texte
        nodes.append(c)
    comp['repos'].append({'k': r['key'], 'name': r['name'], 'repo': r['repo'], 'nodes': nodes})
# vitesse de sortie des PR (onglet « Vitesse ») : None si le relevé est antérieur à cette mesure, la page le dit
comp['prlog'] = gh.get('prlog')
comp['prlog_j'] = gh.get('prlog_j')     # 1 : chaque PR dit elle-même si Jules l'a faite (champ j) ; absent : relevé d'avant ce critère, la page se rabat sur la tâche
comp['graphes'] = gh.get('graphes')     # impact de Graphify par artefact (graphes.py) ; None : relevé d'avant cette mesure, la page le dit
comp['releve'] = {k: gh.get(k) for k in ('v', 'mode', 'appels', 'reqs', 'n304', 'duree_s', 'reutilises', 'relectures_vide') if gh.get(k) is not None}

# Contrôles de la pastille (§13) : calculés ici, jamais corrigés ici (seulement signalés).
# Chaque contrôle est toujours listé, même à zéro, pour qu'on voie qu'il tourne.
CTRL = ['niveau:plan à retirer', 'tâche orpheline', 'corps hors gabarit', 'dépendance inconnue', 'cycle de dépendances',
        'PR sans « Tâche : #n »', 'fermée sans preuve', 'fusionnée sans preuve depuis 2 h', 'preuve programmée dépassée depuis plus d\'1 h', 'en cours sans PR depuis 24 h',
        'jules sans PR depuis 24 h', 'bloquée depuis plus de 7 jours', 'PR de plus de 400 lignes', 'incident ouvert',
        'ménage en retard', 'fichiers illisibles', 'workflow en file sans robot']

# Le contrôle « plus d'un fil en cours sur un dépôt » est supprimé (29/10/2026, nettoyage « go reco » de Marc) : il n'y a plus de limite de places par dépôt.

def chemin_illisible(c):
    # Un « fichier » déclaré qui n'en est pas un : une ligne en gras prise pour une puce (« *Attend** », .github#374 et #375, 21/10/2026), un libellé avec deux-points ou une espace.
    # Un motif (`docs/claude/*.md`) reste permis ; c'est le fetch.py qui lit les puces, ce contrôle voit ce qui en sort.
    return not c or c.startswith('*') or '**' in c or ':' in c or any(x.isspace() for x in c)

def sante(gh):
    REF = {f"{r['repo'].lower()}#{n['n']}": n for r in gh['repos'] for n in r['nodes'].values()}
    pb = []
    KIDS = {k.lower() if isinstance(k, str) else f"{r['repo'].lower()}#{k}" for r in gh['repos'] for n in r['nodes'].values() if n['lvl'] != 'tâche' for k in n['kids']}
    asof = datetime.datetime.fromisoformat(gh['asof'].replace('Z', '+00:00'))
    age_t = lambda d: (asof - d).total_seconds()
    age = lambda t: (asof - datetime.datetime.fromisoformat(t.replace('Z', '+00:00'))).total_seconds() if t else 0
    def add(kind, r, n, msg=''):
        assert kind in CTRL, kind
        pb.append({'k': kind, 'ref': f"{r['repo']}#{n['n']}", 't': n['title'], 'u': n['url'], 'm': msg})
    for r in gh['repos']:
        for i in r.get('incidents', []):
            pb.append({'k': 'incident ouvert', 'ref': f"{r['repo']}#{i['n']}", 't': i['t'], 'u': i['url'], 'm': ''})
        for n in r['nodes'].values():
            if n['lvl'] == 'plan':
                add('niveau:plan à retirer', r, n, 'le niveau plan n’existe plus')
            if n['lvl'] in ('tâche', 'mission') and f"{r['repo'].lower()}#{n['n']}" not in KIDS:
                add('tâche orpheline', r, n, 'sans parent' if n['lvl'] == 'tâche' else 'mission sans chantier')
            if n['state'] == 'open' and n.get('gab'):
                add('corps hors gabarit', r, n, f"{n['lvl']} : manque " + ', '.join(n['gab']))
            if n['lvl'] != 'tâche':
                continue
            p = n['pr']
            if n['state'] == 'closed':
                if n.get('reason') == 'completed' and not n.get('preuve'):
                    add('fermée sans preuve', r, n, 'aucun commentaire « **Acceptée** »')
                continue
            labels = n['labels']
            if p and p['state'] == 'open' and p.get('kind') == 'corps':
                add('PR sans « Tâche : #n »', r, n, f"PR #{p['n']}")
            if p and p.get('merged'):
                # §7/§13 : preuve due dans les 2 h ; une « Preuve attendue » (heure écrite dans l'issue ou dans un commentaire) repousse l'échéance d'1 h après l'heure dite
                pa = preuve_attendue(n.get('pa'))
                if pa is None and age(p['merged']) > 7200:
                    add('fusionnée sans preuve depuis 2 h', r, n, f"PR #{p['n']} fusionnée")
                elif pa is not None and age_t(pa) > 3600:
                    add("preuve programmée dépassée depuis plus d'1 h", r, n, f"preuve attendue {n.get('pa')}")
            if 'en-cours' in labels:
                if not p and age(n.get('start') or n['created']) > 86400:
                    add('en cours sans PR depuis 24 h', r, n)
            if 'jules' in labels and not p and age(n.get('start') or n['created']) > 86400:
                add('jules sans PR depuis 24 h', r, n)
            if 'bloqué' in labels and age(n.get('bloque_depuis') or n['created']) > 7 * 86400:
                add('bloquée depuis plus de 7 jours', r, n)
            if p and p['state'] == 'open' and (p.get('lignes') or 0) > 400 and not p.get('dg'):
                add('PR de plus de 400 lignes', r, n, f"PR #{p['n']} : {p['lignes']} lignes hors tests")
            if ({'en-cours', 'jules'} & set(labels)) and p and p['state'] == 'closed' and not p.get('merged'):
                add('ménage en retard', r, n, f"PR #{p['n']} fermée sans fusion")
            for d in n.get('deps', []):
                if d not in REF:
                    add('dépendance inconnue', r, n, d)
            mauvais = [c for c in (n.get('fpl') or []) if chemin_illisible(c)]
            if mauvais:
                add('fichiers illisibles', r, n, 'pas des chemins : ' + ', '.join(mauvais[:3]))
    # workflows qui attendent un robot (workflows_en_file.py, tâche #532) : lus par fetch.py, signalés ici, jamais corrigés ici
    import workflows_en_file
    en_file, exceptions = workflows_en_file.separer(gh.get('en_file'))
    for w in en_file:
        pb.append({'k': 'workflow en file sans robot', 'ref': f"{w['repo']}#{w['run']}", 't': f"{w['wf']} en file depuis {w['h']} h",
                   'u': w['u'], 'm': f"lancement {w['event'] or '?'} dans {w['repo']}"})
    # exceptions nommées (workflows_en_file.EXCEPTIONS) : affichées avec leur raison, hors du compte des défauts
    exceptions = [{'ref': f"{w['repo']}#{w['run']}", 't': f"{w['wf']} en file depuis {w['h']} h", 'u': w['u'], 'm': w['raison']} for w in exceptions]
    G = {k: [d for d in n.get('deps', []) if d in REF and REF[d]['state'] == 'open'] for k, n in REF.items() if n['state'] == 'open'}
    color, seen_cyc = {}, set()
    def dfs(u, path):
        color[u] = 1; path.append(u)
        for v in G.get(u, []):
            if color.get(v) == 1:
                cyc = tuple(sorted(path[path.index(v):]))
                if cyc not in seen_cyc:
                    seen_cyc.add(cyc); n = REF[v]
                    pb.append({'k': 'cycle de dépendances', 'ref': v, 't': n['title'], 'u': n['url'], 'm': ' → '.join(path[path.index(v):] + [v])})
            elif not color.get(v):
                dfs(v, path)
        path.pop(); color[u] = 2
    sys.setrecursionlimit(10000)
    for u in G:
        if not color.get(u): dfs(u, [])
    hors = [{'repo': r['name'], **h} for r in gh['repos'] for h in r.get('hors', [])]
    # le nombre de la pastille, écrit une fois : défauts du relevé + tâches rouvertes par le garde-fou (« preuve-manquante ») qui n'y figurent pas déjà
    vu = {p['ref'].lower() for p in pb}
    pm = [1 for r in gh['repos'] for n in r['nodes'].values() if n['lvl'] == 'tâche' and n['state'] == 'open' and 'preuve-manquante' in n['labels'] and f"{r['repo'].lower()}#{n['n']}" not in vu]
    return {'ctrl': CTRL, 'pb': pb, 'hors': hors, 'exceptions': exceptions, 'n': len(pb) + len(pm)}
comp['sante'] = sante(gh)

# Gestes de Marc à jour (gestes.py, tâche .github#478) : signalements pour l'onglet « À toi » et etat.json, plus les deux listes générées.
# Un échec ne bloque jamais la construction : la page dit « erreur » au lieu de montrer des gestes inventés.
try:
    import gestes
    _maintenant = datetime.datetime.now(UTC)
    _g = gestes.controler(gh['repos'], _maintenant)
    comp['gestes'] = _g
    for _nom, _texte in zip(('gestes-de-marc', 'a-faire-maintenant'), gestes.listes_md(_g, _maintenant)):
        _f = D + _nom + OUT + '.md'
        open(_f + '.tmp', 'w', encoding='utf-8').write(_texte)
        os.replace(_f + '.tmp', _f)
except Exception as _e:
    comp['gestes'] = {'erreur': f'{type(_e).__name__} : {str(_e)[:160]}'}
    print('gestes a échoué :', _e, file=sys.stderr)

# Missions finies à fermer (missions.py) : tour.py les ferme avec le jeton du PC, comme il retire `qui:marc` pour gestes.py. Un échec se dit, il ne bloque pas.
try:
    import missions
    comp['missions'] = {'a_fermer': missions.a_fermer(gh['repos'], datetime.datetime.now(UTC))}
except Exception as _e:
    comp['missions'] = {'erreur': f'{type(_e).__name__} : {str(_e)[:160]}'}
    print('missions.a_fermer a échoué :', _e, file=sys.stderr)

# Preuves en retard, pour le filet du PC (scripts/preuves-retard.mjs, tâche .github#513) : il les redit au Coordinateur toutes les 4 h.
_dp = D + 'defauts-preuve' + OUT + '.json'
json.dump(defauts_preuve.calculer(gh, comp['sante'], datetime.datetime.now(datetime.timezone.utc)), open(_dp + '.tmp', 'w', encoding='utf-8'), ensure_ascii=False)
os.replace(_dp + '.tmp', _dp)
# réponses de Marc depuis la page (reponses.py) : la page y lit si un clic a été appliqué ou refusé
try: comp['reponses'] = json.load(open(D + 'reponses-journal.json', encoding='utf-8'))[-50:]
except (OSError, ValueError): comp['reponses'] = []
# quotas : mesure faite par quota.py ; absente = l'onglet le dit
try: comp['quota'] = json.load(open(D + 'quota.json'))
except Exception: comp['quota'] = None
# registre des dépenses : fichier PRIVÉ du PC (couts_manuels.py), jamais dans le dépôt ni dans la page HTML publiée ; absent = clé omise
_cm, _cm_raison = couts_manuels.lire()
if _cm is not None: comp['couts_manuels'] = _cm
else: print('couts_manuels omis :', _cm_raison, file=sys.stderr)
# PR ouvertes (prs_ouvertes.py, .github#679) : fichier écrit par le tour juste avant ; absent ou illisible = clé omise, la page dit « non lu » au lieu d'une liste inventée
try:
    with open(D + 'prs-ouvertes.json', encoding='utf-8') as _f: comp['prs_ouvertes'] = json.load(_f)
except (OSError, ValueError) as _e: print('prs_ouvertes omis :', type(_e).__name__, file=sys.stderr)
# Étapes (etapes.py, .github#689) : heure « PR prête » et heure « en ligne » des PR fusionnées ; absent ou illisible : la page le dit
try:
    with open(D + 'etapes.json', encoding='utf-8') as _f: comp['etapes'] = json.load(_f)
except (OSError, ValueError) as _e: print('etapes omis :', type(_e).__name__, file=sys.stderr)

# La file calculée n'existe plus (chaîne de lancement retirée, 29/10/2026) : la clé reste, avec une raison, pour que la page ne casse pas sur une clé absente (même forme que l'ancien échec du calcul).
comp['prochaines'] = {'erreur': 'file calculée retirée (voie courte : étiquette go)'}
# fidélité (T5) : mesurée par refresh.sh après le relevé, puis la page est reconstruite avec ; absente = la pastille dit « non mesurée »
try:
    fid = json.load(open(D + 'fiabilite.json'))
    fid.pop('snapshots', None); fid['historique'] = (fid.get('historique') or [])[-40:]
    comp['fiabilite'] = fid
except Exception: comp['fiabilite'] = None

tmp = D + 'donnees' + OUT + '.json.tmp'
json.dump(comp, open(tmp, 'w'), ensure_ascii=False)
os.replace(tmp, D + 'donnees' + OUT + '.json')

# La page HTML n'est construite que là où sa source existe : le PC de Marc (tour.py) ne produit que les données.
if os.path.exists(D + 'page7.html'):
    page = open(D + 'page7.html', encoding='utf-8').read()
    # modules de la page : /*@INCLUDE fichier*/ -> contenu de p7/fichier (un seul fichier HTML est publié)
    page = re.sub(r'/\*@INCLUDE ([\w.-]+)\*/', lambda m: open(D + 'p7/' + m.group(1), encoding='utf-8').read(), page)
    assert page.count('/*DONNEES*/null') == 1
    # « </ » échappé : un titre d'issue ne peut pas fermer la balise <script>
    page = page.replace('/*DONNEES*/null', json.dumps({k: v for k, v in comp.items() if k != 'couts_manuels'}, ensure_ascii=False).replace('</', '<\\/'))
    tmp = D + 'chantier-apps' + OUT + '.html.tmp'
    open(tmp, 'w', encoding='utf-8').write(page)
    os.replace(tmp, D + 'chantier-apps' + OUT + '.html')
print(len(page) if os.path.exists(D + 'page7.html') else 'page non construite :', 'octets,', comp['sante']['n'], 'défaut(s) à la pastille')
