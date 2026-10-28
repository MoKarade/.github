#!/usr/bin/env python3
"""Accès Gmail en LECTURE SEULE pour le PC (28/10/2026, choix « A » de Marc : lire ses reçus une fois par semaine).

Un seul droit demandé : `gmail.readonly`. Flux « application de bureau » de Google : navigateur, adresse de retour 127.0.0.1, PKCE (S256).
Rien de secret n'est dans le dépôt :
  - le client Google (id, et secret de bureau) vit dans un fichier du PC : `C:\\dev\\_pc-local\\gmail-client.json` (variable GMAIL_CLIENT_FILE) ;
  - le jeton de renouvellement vit dans `C:\\dev\\_pc-local\\gmail-jeton.bin` (variable GMAIL_TOKEN_FILE), CHIFFRÉ par Windows (DPAPI : seul
    le compte Windows de Marc le relit), jamais en clair, jamais dans un journal, jamais dans le résultat d'une fonction ;
  - le jeton d'accès, lui, ne vit qu'en mémoire (une heure).
Fonctions pures d'un côté (`pkce`, `url_autorisation`, `lire_client`), I/O de l'autre (`http`, `autoriser`, `jeton_d_acces`), tout injectable pour les tests.
Aucune dépendance : bibliothèque standard seulement (le DPAPI passe par ctypes, Windows seulement).
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import urllib.error
import urllib.parse
import urllib.request

SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'
URL_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth'
URL_JETON = 'https://oauth2.googleapis.com/token'
CLIENT_PAR_DEFAUT = r'C:\dev\_pc-local\gmail-client.json'
JETON_PAR_DEFAUT = r'C:\dev\_pc-local\gmail-jeton.bin'
DELAI_S = 30


class ErreurGmail(Exception):
    """`code` : client_absent, client_illisible, jeton_absent, reautoriser, reseau, reponse, refuse."""

    def __init__(self, code: str, detail: str = ''):
        super().__init__(f'{code}: {detail}' if detail else code)
        self.code = code


def chemin_client(env=None) -> str:
    return (os.environ if env is None else env).get('GMAIL_CLIENT_FILE') or CLIENT_PAR_DEFAUT


def chemin_jeton(env=None) -> str:
    return (os.environ if env is None else env).get('GMAIL_TOKEN_FILE') or JETON_PAR_DEFAUT


def _b64url(octets: bytes) -> str:
    return base64.urlsafe_b64encode(octets).rstrip(b'=').decode('ascii')


def pkce() -> tuple[str, str]:
    """(code_verifier, code_challenge S256) : 43 à 128 caractères non réservés, défi = SHA-256 en base64url sans bourrage."""
    verifier = _b64url(secrets.token_bytes(64))      # 86 caractères
    return verifier, _b64url(hashlib.sha256(verifier.encode('ascii')).digest())


def url_autorisation(client_id: str, redirect: str, challenge: str, etat: str) -> str:
    q = {'client_id': client_id, 'redirect_uri': redirect, 'response_type': 'code', 'scope': SCOPE, 'code_challenge': challenge,
         'code_challenge_method': 'S256', 'state': etat, 'access_type': 'offline', 'prompt': 'consent'}
    return URL_AUTH + '?' + urllib.parse.urlencode(q)


def lire_client(chemin: str | None = None) -> tuple[str, str | None]:
    """(client_id, client_secret ou None) depuis le JSON téléchargé de la console Google (clé `installed`, ou `web`)."""
    p = chemin or chemin_client()
    try:
        with open(p, encoding='utf-8') as f:
            brut = json.load(f)
    except FileNotFoundError as e:
        raise ErreurGmail('client_absent', os.path.basename(p)) from e
    except (OSError, ValueError) as e:
        raise ErreurGmail('client_illisible', type(e).__name__) from e
    bloc = (brut.get('installed') or brut.get('web')) if isinstance(brut, dict) else None
    if not isinstance(bloc, dict) or not isinstance(bloc.get('client_id'), str) or not bloc['client_id']:
        raise ErreurGmail('client_illisible', 'pas de client_id')
    secret = bloc.get('client_secret')
    return bloc['client_id'], secret if isinstance(secret, str) and secret else None


# ---- chiffrement du jeton de renouvellement (DPAPI, Windows) ----
def _dpapi(octets: bytes, proteger: bool) -> bytes:
    import ctypes
    from ctypes import wintypes

    class Blob(ctypes.Structure):
        _fields_ = [('cbData', wintypes.DWORD), ('pbData', ctypes.POINTER(ctypes.c_char))]

    entree = Blob(len(octets), ctypes.cast(ctypes.create_string_buffer(octets, len(octets)), ctypes.POINTER(ctypes.c_char)))
    sortie = Blob()
    # 0x1 = CRYPTPROTECT_UI_FORBIDDEN : aucune fenêtre, jamais
    if proteger:
        ok = ctypes.windll.crypt32.CryptProtectData(ctypes.byref(entree), 'gantt-gmail', None, None, None, 0x1, ctypes.byref(sortie))
    else:
        ok = ctypes.windll.crypt32.CryptUnprotectData(ctypes.byref(entree), None, None, None, None, 0x1, ctypes.byref(sortie))
    if not ok:
        raise ErreurGmail('refuse' if proteger else 'reautoriser', 'chiffrement Windows impossible' if proteger else 'jeton illisible pour ce compte Windows')
    try:
        return ctypes.string_at(sortie.pbData, sortie.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(sortie.pbData)


def dpapi_proteger(octets: bytes) -> bytes:
    return _dpapi(octets, True)


def dpapi_deproteger(octets: bytes) -> bytes:
    return _dpapi(octets, False)


def sauver_jeton(refresh: str, chemin: str | None = None, proteger=dpapi_proteger) -> None:
    p = chemin or chemin_jeton()
    os.makedirs(os.path.dirname(p) or '.', exist_ok=True)
    with open(p + '.tmp', 'wb') as f:
        f.write(proteger(refresh.encode('utf-8')))
    os.replace(p + '.tmp', p)


def charger_jeton(chemin: str | None = None, deproteger=dpapi_deproteger) -> str:
    p = chemin or chemin_jeton()
    try:
        with open(p, 'rb') as f:
            brut = f.read()
    except FileNotFoundError as e:
        raise ErreurGmail('jeton_absent') from e
    except OSError as e:
        raise ErreurGmail('reautoriser', type(e).__name__) from e
    try:
        return deproteger(brut).decode('utf-8')
    except UnicodeDecodeError as e:
        raise ErreurGmail('reautoriser', 'jeton illisible') from e


# ---- HTTP ----
def http(methode: str, url: str, donnees: dict | None = None, entetes: dict | None = None) -> tuple[int, dict]:
    """(statut, JSON). Ne lève que ErreurGmail('reseau') ; le corps d'une erreur HTTP est rendu, pas imprimé."""
    corps = urllib.parse.urlencode(donnees).encode('ascii') if donnees is not None else None
    h = {'User-Agent': 'gantt-pc/gmail', **(entetes or {})}
    if corps is not None:
        h['Content-Type'] = 'application/x-www-form-urlencoded'
    req = urllib.request.Request(url, data=corps, method=methode, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=DELAI_S) as r:
            statut, texte = r.status, r.read(5_000_000).decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        statut, texte = e.code, e.read(20_000).decode('utf-8', 'replace')
    except OSError as e:
        raise ErreurGmail('reseau', type(e).__name__) from e
    try:
        return statut, json.loads(texte) if texte.strip() else {}
    except ValueError:
        return statut, {}


def _jeton_post(donnees: dict, requete) -> dict:
    statut, rep = requete('POST', URL_JETON, donnees)
    if statut == 200 and isinstance(rep.get('access_token'), str):
        return rep
    erreur = rep.get('error') if isinstance(rep, dict) else None
    if erreur in ('invalid_grant', 'invalid_client', 'unauthorized_client'):
        raise ErreurGmail('reautoriser', str(erreur))
    raise ErreurGmail('reponse', f'HTTP {statut}' + (f' {erreur}' if isinstance(erreur, str) else ''))


def jeton_d_acces(chemin_c: str | None = None, chemin_j: str | None = None, requete=http, deproteger=dpapi_deproteger, proteger=dpapi_proteger) -> str:
    """Jeton d'accès (en mémoire seulement) obtenu avec le jeton de renouvellement. `reautoriser` : le consentement n'est plus valable (geste de Marc)."""
    client_id, secret = lire_client(chemin_c)
    refresh = charger_jeton(chemin_j, deproteger)
    donnees = {'client_id': client_id, 'refresh_token': refresh, 'grant_type': 'refresh_token'}
    if secret:
        donnees['client_secret'] = secret
    rep = _jeton_post(donnees, requete)
    nouveau = rep.get('refresh_token')
    if isinstance(nouveau, str) and nouveau and nouveau != refresh:      # Google peut en émettre un neuf : on garde le plus récent
        sauver_jeton(nouveau, chemin_j, proteger)
    return rep['access_token']


def echanger_code(client_id: str, secret: str | None, code: str, verifier: str, redirect: str, requete=http) -> str:
    """Code d'autorisation -> jeton de renouvellement (le seul à garder). Lève ErreurGmail si Google n'en rend pas."""
    donnees = {'client_id': client_id, 'code': code, 'code_verifier': verifier, 'grant_type': 'authorization_code', 'redirect_uri': redirect}
    if secret:
        donnees['client_secret'] = secret
    rep = _jeton_post(donnees, requete)
    refresh = rep.get('refresh_token')
    if not isinstance(refresh, str) or not refresh:
        raise ErreurGmail('reponse', 'pas de jeton de renouvellement (révoquer l\'accès dans le compte Google puis recommencer)')
    return refresh


def autoriser(chemin_c: str | None = None, chemin_j: str | None = None, ouvrir=None, requete=http, proteger=dpapi_proteger, delai_s: int = 300) -> str:
    """Geste unique de Marc : ouvre le navigateur, attend le retour sur 127.0.0.1, range le jeton chiffré. Rend une phrase sans secret."""
    import http.server
    import threading
    import webbrowser

    client_id, secret = lire_client(chemin_c)
    verifier, defi = pkce()
    etat = secrets.token_urlsafe(24)
    recu: dict = {}

    class Retour(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            if 'code' in q or 'error' in q:
                recu.update({k: v[0] for k, v in q.items()})
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.end_headers()
            self.wfile.write('<p>Autorisation reçue. Cette fenêtre peut être fermée.</p>'.encode('utf-8'))

        def log_message(self, *a):      # rien dans la console : l'adresse porte le code
            pass

    serveur = http.server.HTTPServer(('127.0.0.1', 0), Retour)
    serveur.timeout = 1
    redirect = f'http://127.0.0.1:{serveur.server_address[1]}'
    (ouvrir or webbrowser.open)(url_autorisation(client_id, redirect, defi, etat))
    fil = threading.Event()
    attente = 0
    while not fil.is_set() and attente < delai_s:
        serveur.handle_request()
        attente += 1
        if recu:
            break
    serveur.server_close()
    if recu.get('error'):
        raise ErreurGmail('refuse', recu['error'])
    if not recu.get('code') or recu.get('state') != etat:
        raise ErreurGmail('refuse', 'pas de retour du navigateur (ou état différent)')
    refresh = echanger_code(client_id, secret, recu['code'], verifier, redirect, requete)
    sauver_jeton(refresh, chemin_j, proteger)
    return 'Gmail autorisé en lecture seule ; jeton rangé, chiffré par Windows.'


if __name__ == '__main__':
    import sys
    if '--autoriser' in sys.argv:
        try:
            print(autoriser())
        except ErreurGmail as e:
            print('ÉCHEC :', e.code, '-', str(e)[:200])
            raise SystemExit(1)
    else:
        print('Usage : python -X utf8 gmail_auth.py --autoriser')
