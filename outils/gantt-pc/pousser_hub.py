#!/usr/bin/env python3
# pousser_hub.py (22/10/2026, tâche .github#544) : envoie le relevé du Gantt au hub (POST https://www.hubperso.com/api/gantt), en plus du dépôt Drive.
# Pourquoi : le hub ne peut pas lire le Drive de Marc (privé, et FinanceAI / DriveAI ont des titres privés) ; c'est donc le PC qui pousse, le hub
# qui range le DERNIER envoi seulement, et l'onglet « Chantier Apps » qui le lit derrière la connexion du hub (Hubperso#330, lib/gantt.ts).
# Règles :
#   - jamais bloquant : tout échec (secret absent, 401, 503, réseau, corps trop gros) se DIT en une phrase pour la ligne du tour, jamais une exception ;
#   - le secret (GANTT_SECRET) vient d'un fichier local du PC, jamais de l'environnement du dépôt ; il ne sort NI dans le résultat, NI dans un journal,
#     NI dans le corps envoyé ;
#   - le corps garde le relevé TEL QUEL : `donnees_gz_b64` est le JSON du Gantt gzippé puis en base64, rien n'est recalculé ni reformaté ;
#   - pas de fake data : un fichier de sortie absent donne un objet vide (le hub exige des objets), jamais une valeur inventée.
# Tests : python3 -m unittest test_pousser_hub
import base64, datetime, gzip, json, os, re, urllib.error, urllib.request

URL = 'https://www.hubperso.com/api/gantt'   # pas hubperso.com : l'apex répond 308 vers www, et urllib ne rejoue pas un POST sur une redirection
SECRET_PAR_DEFAUT = r'C:\dev\_pc-local\gantt-secret.txt'
VERSION_ENVOI = 1                   # celle de lib/gantt.ts côté hub : un autre numéro y est refusé
TAILLE_MAX = 4_000_000              # TAILLE_MAX_OCTETS du hub ; au-delà il répond 413, autant ne pas envoyer
DELAI_S = 30
# Un jeton passe dans un en-tête HTTP : pas d'espace ni de saut de ligne (injection d'en-tête), seulement du ASCII imprimable.
JETON = re.compile(r'^[\x21-\x7e]{16,512}$')


def lire_secret(chemin):
    """Rend (secret, '') ou (None, raison). Fichier absent = hub pas encore configuré, pas une panne."""
    try:
        with open(chemin, encoding='utf-8') as fh: brut = fh.read().strip()
    except FileNotFoundError: return None, 'secret absent (' + os.path.basename(chemin) + ')'
    except (OSError, UnicodeDecodeError) as e: return None, f'secret illisible ({type(e).__name__})'
    if not JETON.match(brut): return None, 'secret invalide (16 à 512 caractères ASCII visibles, sans espace)'
    return brut, ''


def _objet(dossier, nom):
    try:
        with open(os.path.join(dossier, nom), encoding='utf-8') as fh: d = json.load(fh)
    except (OSError, ValueError): return {}
    return d if isinstance(d, dict) else {}


def construire_corps(dossier, maintenant):
    """Le corps de l'envoi, ou lève OSError si donnees.json manque (rien à envoyer sans le relevé lui-même).
    `maintenant` : date ISO 8601 de l'envoi (heure du PC)."""
    with open(os.path.join(dossier, 'donnees.json'), 'rb') as fh: donnees = fh.read()
    return {
        'v': VERSION_ENVOI,
        'envoye': maintenant,
        'donnees_gz_b64': base64.b64encode(gzip.compress(donnees, 9, mtime=0)).decode('ascii'),
        'etat': _objet(dossier, 'boucle-etat.json'),
        'fiabilite': _objet(dossier, 'fiabilite.json'),
        'prochaines': _objet(dossier, 'prochaines.json'),
        'quota': _objet(dossier, 'quota.json'),
    }


def _poster(url, secret, octets):
    """Rend (code HTTP, corps texte) ; lève OSError (réseau, délai) ou urllib.error.URLError."""
    req = urllib.request.Request(url, data=octets, method='POST', headers={
        'Authorization': 'Bearer ' + secret, 'Content-Type': 'application/json; charset=utf-8', 'User-Agent': 'gantt-pc/tour.py'})
    try:
        with urllib.request.urlopen(req, timeout=DELAI_S) as r: return r.status, r.read(4000).decode('utf-8', 'replace')
    except urllib.error.HTTPError as e: return e.code, e.read(4000).decode('utf-8', 'replace')


RAISONS = {301: 'adresse d\'envoi redirigée, URL à corriger', 302: 'adresse d\'envoi redirigée, URL à corriger', 307: 'adresse d\'envoi redirigée, URL à corriger',
           308: 'adresse d\'envoi redirigée, URL à corriger', 400: 'corps refusé par le hub', 401: 'secret refusé par le hub (GANTT_SECRET différent ?)',
           413: 'corps trop gros pour le hub', 429: 'trop d\'envois (limite du hub)',
           500: 'écriture en base échouée côté hub', 503: 'réception pas encore active côté hub (GANTT_SECRET ou base absents)'}


def pousser(dossier, chemin_secret=SECRET_PAR_DEFAUT, url=URL, poster=_poster, maintenant=None):
    """Envoie le relevé. Rend UNE phrase pour la ligne du tour, qui commence par « hub : ». Ne lève jamais.
    `poster` et `maintenant` sont injectables pour les tests."""
    secret, raison = lire_secret(chemin_secret)
    if secret is None: return 'hub : ' + raison
    try:
        corps = json.dumps(construire_corps(dossier, maintenant or datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')),
                           ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    except OSError as e: return f'hub : pas d\'envoi, relevé illisible ({type(e).__name__})'
    if len(corps) > TAILLE_MAX: return f'hub : pas d\'envoi, corps de {len(corps)} octets (limite {TAILLE_MAX})'
    try: code, texte = poster(url, secret, corps)
    except (OSError, ValueError) as e: return f'hub : envoi impossible ({type(e).__name__})'   # urllib.error.URLError est un OSError
    if code == 200:
        try: ok = bool(json.loads(texte).get('ok'))
        except (ValueError, AttributeError): ok = False
        return f'hub : envoyé ({len(corps) // 1024} Ko)' if ok else 'hub : réponse 200 sans ok:true, envoi non confirmé'
    return f'hub : {RAISONS.get(code, "réponse inattendue")} (HTTP {code})'
