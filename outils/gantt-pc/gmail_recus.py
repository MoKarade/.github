#!/usr/bin/env python3
"""Reçus Gmail de Marc, lus UNE fois par semaine (28/10/2026, choix « A » de Marc ; tâche .github#657, point 4).

But : que la vue Coûts de la page Chantier ne dépende plus d'un relevé fait à la main. Ce module lit les en-têtes et l'extrait (`snippet`)
des courriels de reçu des fournisseurs connus, en LECTURE SEULE (`gmail.readonly`, voir gmail_auth.py), et range le résultat dans un
fichier PRIVÉ du PC : `C:\\dev\\_pc-local\\recus-gmail.json` (autre chemin : variable GMAIL_RECUS_FILE). Rien n'entre dans le dépôt (public).
`couts_manuels.lire` ajoute ce fichier au registre sous la clé `recus_gmail` ; la page affiche, elle ne calcule pas.

Règles « pas de fausse donnée » :
  - un montant n'est gardé que s'il est UNIQUE dans l'extrait ET porte un marqueur de devise ; sinon `montant: None` et `a_verifier: True` ;
  - une devise ambiguë (« $ » seul) reste `None` : jamais devinée ;
  - on ne garde NI l'objet NI l'extrait NI l'expéditeur complet : date, fournisseur, montant, devise, identifiant du message ;
  - fournisseur inconnu = courriel ignoré.
Cadence : au plus une lecture réussie par 7 jours ; après un échec, une nouvelle tentative au plus toutes les 6 h. Aucun minuteur nouveau :
la fonction `passer` est appelée par le tour du relevé et rend une phrase courte (vide = rien à dire). Elle ne lève jamais.
Stdlib seulement ; I/O injectable pour les tests (valeurs FICTIVES).
"""
from __future__ import annotations

import datetime
import json
import os
import re
import urllib.parse

import gmail_auth
from gmail_auth import ErreurGmail

API = 'https://gmail.googleapis.com/gmail/v1/users/me/messages'
CHEMIN_DEFAUT = r'C:\dev\_pc-local\recus-gmail.json'
INTERVALLE_H = 7 * 24
REESSAI_H = 6
JOURS_PREMIERE, JOURS_ENSUITE = 60, 21      # recouvrement : un courriel arrivé tard n'échappe pas à la lecture suivante ; dédoublonné par id
MAX_PAGES, MAX_MESSAGES, MAX_GARDES = 3, 150, 200

# (mot cherché dans l'expéditeur + l'objet, nom rangé) — le premier qui correspond gagne
FOURNISSEURS = (('anthropic', 'Anthropic'), ('vercel', 'Vercel'), ('windsurf', 'Windsurf'), ('codeium', 'Windsurf'),
                ('google play', 'Google Play'), ('google cloud', 'Google Cloud'), ('cloud platform', 'Google Cloud'),
                ('cloudflare', 'Cloudflare'), ('github', 'GitHub'))
DOMAINES = 'anthropic.com OR stripe.com OR vercel.com OR windsurf.com OR codeium.com OR github.com OR google.com OR cloudflare.com'
OBJET_RECU = re.compile(r're[cç]u|receipt|invoice|facture|paiement|payment|billing|statement', re.I)
DEVISES = {'us$': 'USD', 'usd': 'USD', 'ca$': 'CAD', 'c$': 'CAD', 'cad': 'CAD', '$': None}
_M = r'(?:US\$|USD|CA\$|C\$|CAD|\$)'
_N = r'(?:\d{1,3}(?:[ \u00a0\u202f,.]\d{3})+|\d+)(?:[.,]\d{2})'
MONTANT = re.compile(rf'(?P<pre>{_M})\s?(?P<n1>{_N})|(?P<n2>{_N})\s?(?P<post>{_M})', re.I)


def _nombre(texte: str) -> float | None:
    """« 1 234,50 », « 1,234.50 », « 321.93 » -> float ; le DERNIER séparateur suivi de 2 chiffres est la décimale."""
    t = re.sub(r'[ \u00a0\u202f]', '', texte)
    m = re.match(r'^(.*?)[.,](\d{2})$', t)
    if not m:
        return None
    entier = re.sub(r'[.,]', '', m.group(1))
    if not entier.isdigit():
        return None
    return float(f'{entier}.{m.group(2)}')


def montants(texte: str) -> set[tuple[float, str | None]]:
    """Montants AVEC marqueur de devise trouvés dans le texte : {(valeur, devise ou None)}. Sans marqueur, rien (évite dates et numéros)."""
    trouves = set()
    for m in MONTANT.finditer(texte or ''):
        n = _nombre(m.group('n1') or m.group('n2'))
        marque = (m.group('pre') or m.group('post') or '').lower()
        if n is not None and n > 0:
            trouves.add((n, DEVISES.get(marque)))
    return trouves


def fournisseur(expediteur: str, objet: str) -> str | None:
    t = f'{expediteur} {objet}'.lower()
    for mot, nom in FOURNISSEURS:
        if mot in t:
            return nom
    return None


def date_iso(internal_ms) -> str | None:
    try:
        return datetime.datetime.fromtimestamp(int(internal_ms) / 1000, datetime.timezone.utc).strftime('%Y-%m-%d')
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def en_recu(msg: dict) -> dict | None:
    """Message Gmail (format metadata) -> {id, date, fournisseur, montant, devise, a_verifier} ou None (pas un reçu connu)."""
    if not isinstance(msg, dict) or not isinstance(msg.get('id'), str):
        return None
    charge = msg.get('payload')
    entetes = charge.get('headers') if isinstance(charge, dict) else None
    ent = {str(h.get('name', '')).lower(): str(h.get('value', '')) for h in entetes if isinstance(h, dict)} if isinstance(entetes, list) else {}
    objet, de = ent.get('subject', ''), ent.get('from', '')
    nom, date = fournisseur(de, objet), date_iso(msg.get('internalDate'))
    if not nom or not date or not OBJET_RECU.search(objet):
        return None
    trouves = montants(f'{objet} {msg.get("snippet") or ""}')
    if len(trouves) == 1:
        (valeur, devise), = trouves
        return {'id': msg['id'], 'date': date, 'fournisseur': nom, 'montant': valeur, 'devise': devise, 'a_verifier': devise is None}
    return {'id': msg['id'], 'date': date, 'fournisseur': nom, 'montant': None, 'devise': None, 'a_verifier': True}


def requete_gmail(jours: int) -> str:
    return f'from:({DOMAINES}) newer_than:{jours}d'


def _get(url: str, acces: str, requete) -> dict:
    statut, rep = requete('GET', url, None, {'Authorization': f'Bearer {acces}'})
    if statut == 200:
        return rep
    raison = ''
    err = rep.get('error') if isinstance(rep, dict) else None
    if isinstance(err, dict):
        for e in err.get('errors') or []:
            if isinstance(e, dict) and isinstance(e.get('reason'), str):
                raison = ' ' + e['reason'][:40]
                break
    if statut == 401:
        raise ErreurGmail('reautoriser', 'HTTP 401')
    if statut == 429:
        raise ErreurGmail('reponse', 'HTTP 429 limite')
    raise ErreurGmail('refuse' if statut == 403 else 'reponse', f'HTTP {statut}{raison}')


def lire_messages(acces: str, jours: int, requete=gmail_auth.http) -> list[dict]:
    """Reçus lus dans Gmail (≤ MAX_MESSAGES courriels, métadonnées seulement : pas de corps, pas de pièce jointe)."""
    ids, page = [], None
    for _ in range(MAX_PAGES):
        q = {'q': requete_gmail(jours), 'maxResults': 100, **({'pageToken': page} if page else {})}
        rep = _get(API + '?' + urllib.parse.urlencode(q), acces, requete)
        ids += [m['id'] for m in rep.get('messages', []) if isinstance(m, dict) and isinstance(m.get('id'), str)]
        page = rep.get('nextPageToken')
        if not page or len(ids) >= MAX_MESSAGES:
            break
    recus = []
    for i in ids[:MAX_MESSAGES]:
        url = f'{API}/{urllib.parse.quote(i)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject'
        r = en_recu(_get(url, acces, requete))
        if r:
            recus.append(r)
    return recus


# ---- fichier privé ----
def chemin(env=None) -> str:
    return (os.environ if env is None else env).get('GMAIL_RECUS_FILE') or CHEMIN_DEFAUT


def lire_etat(p: str | None = None) -> dict | None:
    try:
        with open(p or chemin(), encoding='utf-8') as f:
            etat = json.load(f)
    except (OSError, ValueError):
        return None
    return etat if isinstance(etat, dict) and isinstance(etat.get('recus', []), list) else None


def ecrire_etat(etat: dict, p: str | None = None) -> None:
    p = p or chemin()
    os.makedirs(os.path.dirname(p) or '.', exist_ok=True)
    with open(p + '.tmp', 'w', encoding='utf-8') as f:
        json.dump(etat, f, ensure_ascii=False, indent=1)
    os.replace(p + '.tmp', p)


def _heures(depuis: str | None, maintenant: str) -> float | None:
    try:
        a = datetime.datetime.fromisoformat(depuis.replace('Z', '+00:00'))
        b = datetime.datetime.fromisoformat(maintenant.replace('Z', '+00:00'))
    except (AttributeError, ValueError):
        return None
    return (b - a).total_seconds() / 3600


def a_lire(etat: dict | None, maintenant: str) -> bool:
    """Première fois ; ou dernier essai en échec depuis 6 h ; ou dernière lecture réussie depuis 7 jours."""
    if not etat:
        return True
    if etat.get('erreur'):
        h = _heures(etat.get('tentative'), maintenant)
        return h is None or h >= REESSAI_H
    h = _heures(etat.get('lu_le'), maintenant)
    return h is None or h >= INTERVALLE_H


def fusionner(anciens: list, nouveaux: list) -> tuple[list, int]:
    """Union par identifiant (le plus récent écrase), du plus récent au plus ancien, plafonnée. Rend (liste, nombre d'identifiants nouveaux)."""
    par_id = {r['id']: r for r in anciens if isinstance(r, dict) and isinstance(r.get('id'), str)}
    neufs = sum(1 for r in nouveaux if r['id'] not in par_id)
    par_id.update({r['id']: r for r in nouveaux})
    tries = sorted(par_id.values(), key=lambda r: (r.get('date') or '', r['id']), reverse=True)
    return tries[:MAX_GARDES], neufs


def passer(maintenant: str, p: str | None = None, chemin_c: str | None = None, chemin_j: str | None = None, requete=gmail_auth.http,
           deproteger=gmail_auth.dpapi_deproteger, proteger=gmail_auth.dpapi_proteger) -> str:
    """Appelée par le tour. Rend une phrase courte (vide : rien à dire). Ne lève jamais ; ne perd jamais les reçus déjà rangés."""
    try:
        etat = lire_etat(p)
        if not a_lire(etat, maintenant):
            return ''
        try:
            acces = gmail_auth.jeton_d_acces(chemin_c, chemin_j, requete, deproteger, proteger)
            recus = lire_messages(acces, JOURS_ENSUITE if etat and etat.get('lu_le') else JOURS_PREMIERE, requete)
        except ErreurGmail as e:
            if e.code in ('client_absent', 'jeton_absent'):
                return ''                                            # pas encore autorisé : rien à dire à chaque tour
            ecrire_etat({**(etat or {}), 'v': 1, 'tentative': maintenant, 'erreur': e.code, 'recus': (etat or {}).get('recus', [])}, p)
            return 'Gmail : ' + ('autorisation à refaire (geste de Marc)' if e.code == 'reautoriser' else f'échec ({e.code})')
        liste, neufs = fusionner((etat or {}).get('recus', []), recus)
        ecrire_etat({'v': 1, 'lu_le': maintenant, 'tentative': maintenant, 'erreur': None, 'recus': liste}, p)
        return f'Gmail : {len(recus)} reçu(s) lu(s), {neufs} nouveau(x)'
    except Exception as e:                                           # jamais bloquer le tour ; se DIT
        return f'Gmail : ÉCHEC {type(e).__name__}'
