#!/usr/bin/env python3
"""Notes de LIA non lues -> réveil du Coordinateur (28/10/2026, tâche .github#681, choix « A » de Marc : repli par le tour du PC).

Le tour lit `GET https://www.hubperso.com/api/chantier/notes-lia` (en-tête `Authorization: Bearer <GANTT_SECRET>`, le secret que le PC a déjà : aucun nouveau secret).
Réponse 200 : {"ok": true, "notesLia": <entier >= 0 ou null>} ; `null` = inconnu (MemoryAI injoignable, métrique absente) : on ne déclenche RIEN et on ne le prend jamais pour 0.
Le Coordinateur est réveillé par `boite-reacteur.yml` (même route que Drive absent, tour.py) quand le nombre de notes monte, puis en rappel toutes les 4 h tant que
des notes restent non lues. Un réveil raté n'est pas enregistré : le tour suivant réessaie. `passer` rend une phrase courte (vide : rien à dire) et ne lève jamais.
État : lia-notes-etat.json (dossier d'état du PC) = {signale, quand}. Stdlib seulement ; I/O injectable (tests fictifs).
"""
import json
import os
import urllib.error
import urllib.request

import pousser_hub

D = os.path.dirname(os.path.abspath(__file__)) + os.sep
URL_HUB = 'https://www.hubperso.com/api/chantier/notes-lia'      # www, pas l'apex (comme reponses.py)
ETAT = D + 'lia-notes-etat.json'
RAPPEL_S = 4 * 3600
DELAI_S = 30
RAISONS = {401: 'secret refusé (GANTT_SECRET différent ?)', 404: 'route pas encore en ligne', 429: 'trop de demandes', 503: 'pas encore actif côté hub'}


def _requete(url, secret):
    """Rend (code HTTP, corps texte) ; lève OSError (réseau, délai)."""
    req = urllib.request.Request(url, method='GET', headers={'Authorization': 'Bearer ' + secret, 'User-Agent': 'gantt-pc/lia_notes.py'})
    try:
        with urllib.request.urlopen(req, timeout=DELAI_S) as r: return r.status, r.read(20_000).decode('utf-8', 'replace')
    except urllib.error.HTTPError as e: return e.code, e.read(2000).decode('utf-8', 'replace')


def lire_notes(secret, requete=_requete):
    """(nombre ou None, raison). None + raison vide = le hub dit « inconnu » ; None + raison = lecture impossible. Ne lève jamais."""
    try: code, texte = requete(URL_HUB, secret)
    except (OSError, ValueError) as e: return None, f'lecture impossible ({type(e).__name__})'
    if code != 200: return None, f'{RAISONS.get(code, "réponse inattendue")} (HTTP {code})'
    try: corps = json.loads(texte)
    except ValueError: return None, 'réponse illisible'
    if not isinstance(corps, dict) or 'notesLia' not in corps: return None, 'réponse sans notesLia'      # clé absente (hub d'une autre forme) ≠ null (« inconnu »)
    n = corps['notesLia']
    if isinstance(n, bool) or not (n is None or (isinstance(n, int) and n >= 0)): return None, 'notesLia invalide'
    return n, ''


def decider(notes, etat, ts):
    """Pure. (texte du réveil ou None, nouvel état). Le nouvel état n'est enregistré que si le réveil est parti (ou s'il n'y en avait pas à faire).
    Réveil : notes > 0 et (jamais signalé, ou le nombre a monté, ou le dernier réveil date de plus de RAPPEL_S). Zéro note : l'état repart à zéro."""
    etat = etat or {}
    if notes == 0: return None, {'signale': 0, 'quand': None}
    signale, quand = etat.get('signale') or 0, etat.get('quand')
    if notes > signale or quand is None or ts - quand >= RAPPEL_S:
        return f'RÉACTEUR : LIA a laissé {notes} note(s) non lue(s), lis memoryai_notes_lia', {'signale': notes, 'quand': ts}
    return None, {**etat, 'signale': notes}       # le nombre a baissé : on le suit sans réveiller


def lire_etat(chemin=ETAT):
    try:
        with open(chemin, encoding='utf-8') as fh: e = json.load(fh)
        return e if isinstance(e, dict) else {}
    except (OSError, ValueError): return {}


def ecrire_etat(etat, chemin=ETAT):
    with open(chemin + '.tmp', 'w', encoding='utf-8') as fh: json.dump(etat, fh)
    os.replace(chemin + '.tmp', chemin)


def passer(ts, reveiller, chemin_secret=pousser_hub.SECRET_PAR_DEFAUT, chemin_etat=ETAT, requete=_requete):
    """Appelée par le tour. `ts` : secondes (time.time()) ; `reveiller(texte)` -> True si le réveil est parti. Rend une phrase courte ; ne lève jamais."""
    try:
        secret, raison = pousser_hub.lire_secret(chemin_secret)
        if not secret: return f'LIA : {raison}'
        notes, raison = lire_notes(secret, requete)
        if notes is None: return f'LIA : notes inconnues ({raison})' if raison else 'LIA : notes inconnues du hub (rien déclenché)'
        texte, nouveau = decider(notes, lire_etat(chemin_etat), ts)
        if texte is None:
            ecrire_etat(nouveau, chemin_etat)
            return f'LIA : {notes} note(s) non lue(s), déjà signalée(s)' if notes else 'LIA : aucune note non lue'
        if not reveiller(texte): return f'LIA : {notes} note(s) non lue(s), réveil en ÉCHEC (nouvel essai au prochain tour)'
        ecrire_etat(nouveau, chemin_etat)
        return f'LIA : {notes} note(s) non lue(s), réveil envoyé'
    except Exception as e:                                           # jamais bloquer le tour ; se DIT
        return f'LIA : ÉCHEC {type(e).__name__}'
