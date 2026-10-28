# Lecture GitHub avec ETag (If-None-Match), partagée par fetch.py, quota.py et boucle.py.
# Mesuré le 16/10/2026 : une réponse 304 ne consomme rien sur la limite de 15 000 requêtes/h
# (40 requêtes conditionnelles : environ 5 comptées ; 40 requêtes simples : 40). Les autres sessions du projet en
# consomment déjà ~2 par seconde, d'où cette économie : un relevé qui ne trouve rien de nouveau ne coûte presque rien.
# Le cache vit en local (le dossier partagé est un montage réseau) ; perdu ou désactivé (GANTT_CACHE_HTTP=off), on relit tout.
import subprocess, json, os, re, hashlib, threading, time

_ENV = os.environ.get('GANTT_CACHE_HTTP', '')
ACTIF = _ENV != 'off'
DOSSIER = (_ENV if _ENV not in ('', 'off') else '/tmp/gantt-cache-http') .rstrip('/') + '/'
STATS = {'req': 0, 'n304': 0, 'n200': 0, 'erreurs': 0, 'limite': 0, 'relectures_vide': 0}
PAR_CHEMIN = {}               # requêtes COMPTÉES (200 et erreurs, pas les 304) par forme de chemin : .github#741 (qui pèse dans un relevé « léger » de 187 appels ?)
ATTENTES_VIDE = (1, 2, 3)     # secondes avant chaque relecture d'une liste vide (les tests les mettent à zéro)
_V = threading.Lock()
TRANSITOIRE = re.compile(r'HTTP (429|50[234])|timed? ?out|EOF|connection (reset|refused)|temporar|TLS|handshake', re.I)
if ACTIF: os.makedirs(DOSSIER, exist_ok=True)

def forme(path):
    """Forme d'un chemin pour le décompte : sans requête, le dépôt devient R, les nombres N, les SHA S. 'repos/MoKarade/x/issues/12/comments?page=2' -> 'repos/R/issues/N/comments'."""
    p = re.sub(r'^/', '', path.split('?')[0])
    p = re.sub(r'^repos/[^/]+/[^/]+', 'repos/R', p)
    p = re.sub(r'/[0-9a-f]{7,40}(?=/|$)', '/S', p)
    return re.sub(r'/\d+(?=/|$)', '/N', p)

def _compter(path):
    with _V: PAR_CHEMIN[forme(path)] = PAR_CHEMIN.get(forme(path), 0) + 1

def detail_comptees(n=8):
    """Les n formes de chemin les plus coûteuses : [(forme, appels comptés)], triées par coût décroissant puis par nom."""
    with _V: return sorted(PAR_CHEMIN.items(), key=lambda kv: (-kv[1], kv[0]))[:n]

def _fichier(cle): return DOSSIER + hashlib.sha1(cle.encode()).hexdigest() + '.json'

def _analyser(sortie):
    """Sortie de `gh api -i` -> (statut, en-têtes en minuscules, corps)."""
    m = re.match(r'\s*HTTP/[\d.]+\s+(\d+)', sortie)
    if not m: return None, {}, sortie
    morceaux = re.split(r'\r?\n\r?\n', sortie, maxsplit=1)
    tete = morceaux[0]; corps = morceaux[1] if len(morceaux) > 1 else ''
    en = {}
    for ligne in tete.splitlines()[1:]:
        if ':' in ligne:
            k, v = ligne.split(':', 1); en[k.strip().lower()] = v.strip()
    return int(m.group(1)), en, corps

def _vide(x):
    """Liste vide, ou listage de GitHub dont toutes les listes sont vides (`{"total_count": 12, "workflow_runs": []}`)."""
    if isinstance(x, dict):
        listes = [v for v in x.values() if isinstance(v, list)]
        return bool(listes) and not any(listes)
    return x == []

def lire(path, *args, verifier_vide=False):
    """GET `path` -> JSON. 304 : le corps vient du cache local. Panne passagère : 2 essais de plus (2 s, 4 s). Sinon RuntimeError.
    GitHub rend par moments une liste VIDE pour une page pleine, première page comprise (mesuré le 22/10/2026 : la même requête, 2 fois sur 6 ; le relevé
    de 14:31Z a perdu 75 tâches et rougi toute la fiabilité). Une liste vide reçue en 200 est donc relue, jusqu'à 3 fois (1, 2, 3 s) ; une vraie liste vide
    le reste après 3 lectures, puis son cache la confirme en 304 sans rien coûter. `verifier_vide` relit aussi une vide confirmée par le cache
    (page suivante d'une liste dont la page précédente était pleine : une telle page ne peut pas être vide)."""
    res, confirmee = _lire(path, *args)
    if _vide(res) and (verifier_vide or not confirmee):
        for i, attente in enumerate(ATTENTES_VIDE):
            time.sleep(attente)
            with _V: STATS['relectures_vide'] += 1
            res2, _ = _lire(path, *args, ecrire_vide=i == len(ATTENTES_VIDE) - 1)     # une vide n'entre au cache qu'une fois confirmée par toutes les relectures
            if not _vide(res2): return res2
    return res

def _lire(path, *args, ecrire_vide=False):
    """Une lecture -> (JSON, vrai si c'est une liste vide que le serveur confirme en 304 sur une liste vide déjà en cache).
    Une réponse vide n'est écrite au cache (avec son ETag) que si `ecrire_vide` : sinon une vide passagère remplacerait la bonne liste du cache,
    et la même vide, revenue avec le même ETag, serait « confirmée » en 304 sans relecture."""
    cle = path + '|' + ' '.join(args)
    f = _fichier(cle)
    etag = corps_cache = None
    if ACTIF:
        try:
            with open(f, encoding='utf-8') as fh: c = json.load(fh)
            etag, corps_cache = c['etag'], c['corps']
        except Exception: pass
    try: cache_vide = corps_cache is not None and bool(corps_cache.strip()) and _vide(json.loads(corps_cache))
    except ValueError: cache_vide = False
    cmd = ['gh', 'api', '-i', path, *args] + (['-H', 'If-None-Match: ' + etag] if etag and corps_cache is not None else [])
    dernier = ''
    for essai in (1, 2, 3):
        r = subprocess.run(cmd, capture_output=True, text=True)
        with _V: STATS['req'] += 1
        statut, en, corps = _analyser(r.stdout)
        if statut == 304 and corps_cache is not None:
            with _V: STATS['n304'] += 1
            return (json.loads(corps_cache) if corps_cache.strip() else None), cache_vide
        if statut is not None and 200 <= statut < 300:
            with _V: STATS['n200'] += 1
            _compter(path)
            res = json.loads(corps) if corps.strip() else None
            if ACTIF and en.get('etag') and (ecrire_vide or not _vide(res)):
                try:
                    with open(f + '.tmp', 'w', encoding='utf-8') as fh: json.dump({'etag': en['etag'], 'corps': corps}, fh)
                    os.replace(f + '.tmp', f)
                except OSError: pass
            return res, False
        with _V: STATS['erreurs'] += 1
        _compter(path)
        dernier = f"{path.split('?')[0]} : HTTP {statut} " + (corps or r.stderr or r.stdout)[:200].replace('\n', ' ')
        # limite secondaire (403/429 « rate limit ») : on attend ce que GitHub demande, sans insister
        if statut in (403, 429) and re.search(r'rate limit|abuse', corps or '', re.I):
            with _V: STATS['limite'] += 1
            if essai < 3:
                time.sleep(min(int(en.get('retry-after', '20') or 20), 60)); continue
        if essai < 3 and (statut in (429, 502, 503, 504) or (statut is None and TRANSITOIRE.search(r.stderr or ''))):
            time.sleep(2 * essai); continue
        break
    raise RuntimeError(dernier)

def compteurs():
    """Requêtes réellement comptées par GitHub : tout sauf les 304."""
    with _V: return {**STATS, 'comptees': STATS['n200'] + STATS['erreurs']}

def limite():
    """(utilisées, restantes, plafond, instant de remise à zéro) — la lecture de rate_limit ne coûte rien."""
    r = subprocess.run(['gh', 'api', 'rate_limit'], capture_output=True, text=True)
    c = json.loads(r.stdout)['resources']['core']
    return c['used'], c['remaining'], c['limit'], c['reset']
