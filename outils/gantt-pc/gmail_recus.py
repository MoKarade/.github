#!/usr/bin/env python3
"""Reçus Gmail de Marc, lus UNE fois par semaine (28/10/2026, choix « A » de Marc ; tâche .github#660).

Lecture SEULE (`gmail.readonly`, voir gmail_auth.py) de l'en-tête et du texte des courriels de reçu des fournisseurs connus ; le texte ne vit
qu'en mémoire. Résultat rangé dans un fichier PRIVÉ du PC, `C:\\dev\\_pc-local\\recus-gmail.json` (variable GMAIL_RECUS_FILE), jamais dans le dépôt.
Pas de fausse donnée : le montant est celui qui suit un libellé connu (« Amount paid », « Total : », « paiement de »…) ; sans libellé, il faut un
montant unique avec devise ; sinon `montant: None`. Un « $ » seul laisse `devise: None` (`devise_probable` donne la monnaie habituelle du
fournisseur, une SUPPOSITION) et le reçu reste `a_verifier`. Ni objet, ni texte, ni expéditeur gardés ; fournisseur inconnu = ignoré.
Cadence : une lecture réussie par 7 jours, nouvel essai toutes les 6 h après un échec ; `passer` est appelée par le tour (aucun minuteur
de plus), rend une phrase courte (vide = rien à dire) et ne lève jamais. Stdlib seulement ; I/O injectable (tests fictifs).
"""
from __future__ import annotations

import base64
import datetime
import html
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
VERSION = 2          # change quand la lecture des montants change : le fichier d'une version plus ancienne est relu en entier au prochain tour
MAX_PAGES, MAX_MESSAGES, MAX_GARDES = 3, 150, 200

# (mot cherché dans l'expéditeur + l'objet, nom rangé) — le premier qui correspond gagne
FOURNISSEURS = (('anthropic', 'Anthropic'), ('vercel', 'Vercel'), ('windsurf', 'Windsurf'), ('codeium', 'Windsurf'),
                ('google play', 'Google Play'), ('google cloud', 'Google Cloud'), ('cloud platform', 'Google Cloud'),
                ('cloudflare', 'Cloudflare'), ('github', 'GitHub'))
DOMAINES = 'anthropic.com OR stripe.com OR vercel.com OR windsurf.com OR codeium.com OR github.com OR google.com OR cloudflare.com'
OBJET_RECU = re.compile(r're[cç]u|receipt|invoice|facture|paiement|payment|billing|statement', re.I)
REMBOURSEMENT = re.compile(r'refund|rembours', re.I)
CORRECTION = re.compile(r'correction|avoir', re.I)            # « Correction to your Vercel invoices » : pas une dépense
DEVISES = {'us$': 'USD', '$us': 'USD', 'usd': 'USD', 'ca$': 'CAD', 'c$': 'CAD', '$ca': 'CAD', 'cad': 'CAD', '$': None}
DEVISE_PROBABLE = {'Vercel': 'USD', 'Google Play': 'CAD'}      # SUPPOSITION, uniquement quand le courriel ne dit que « $ »
_M = r'(?:US\$|CA\$|C\$|\$\s?CA|\$\s?US|USD|CAD|\$)'
_N = r'(?:\d{1,3}(?:[ \u00a0\u202f,.]\d{3})+|\d+)(?:[.,]\d{2})'
MONTANT_SRC = rf'(?:(?P<pre>{_M})\s?(?P<n1>{_N})(?:\s?(?P<s1>USD|CAD)\b)?|(?P<n2>{_N})\s?(?P<post>{_M}))'
MONTANT = re.compile(MONTANT_SRC, re.I)
# libellés qui précèdent immédiatement LE montant payé, du plus sûr au moins sûr (« Total des dépenses… » et « Total excluding tax » ne suivent pas de montant)
LIBELLES = tuple(re.compile(l + r'\s*' + MONTANT_SRC, re.I) for l in (r'(?<![\w-])Amount paid', r'(?<![\w-])Montant pay[ée]', r'(?<![\w-])paiement de', r'(?<![\w-])payment of', r'(?<![\w-])Total\s*:?'))
LIBELLES_REMBOURSEMENT = tuple(re.compile(l + r'\s*' + MONTANT_SRC, re.I) for l in (r'Refund(?:ed)? from[^$\d]{0,40}', r'Rembours[^$\d]{0,40}'))


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


def _valeur(m) -> tuple[float | None, str | None]:
    """(valeur, devise) d'une correspondance MONTANT ; un code de devise après le nombre (« $4.00 USD ») l'emporte sur « $ »."""
    marque = re.sub(r'\s', '', (m.group('s1') or m.group('pre') or m.group('post') or '')).lower()
    return _nombre(m.group('n1') or m.group('n2')), DEVISES.get(marque)


def montants(texte: str) -> set[tuple[float, str | None]]:
    """Montants AVEC marqueur de devise trouvés dans le texte : {(valeur, devise ou None)}. Sans marqueur, rien (évite dates et numéros)."""
    trouves = set()
    for m in MONTANT.finditer(texte or ''):
        n, devise = _valeur(m)
        if n is not None and n > 0:
            trouves.add((n, devise))
    return trouves


def montant_paye(texte: str, rembourse: bool = False) -> tuple[float | None, str | None]:
    """(montant, devise) : celui qui suit un libellé connu (zéro permis : essai gratuit) ; sinon l'unique montant du texte ; sinon (None, None)."""
    for lib in (LIBELLES_REMBOURSEMENT if rembourse else LIBELLES):
        m = lib.search(texte or '')
        if m:
            n, devise = _valeur(m)
            if n is not None:
                return n, devise
    trouves = montants(texte)
    return next(iter(trouves)) if len(trouves) == 1 else (None, None)


def corps_texte(charge) -> str:
    """Texte d'un message Gmail (format `full`) : les parties text/plain, sinon le HTML sans balises ; '' si rien. Les pièces jointes ne sont jamais lues."""
    brut = {'text/plain': [], 'text/html': []}
    pile = [charge]
    while pile:
        p = pile.pop(0)
        if not isinstance(p, dict):
            continue
        pile = (p.get('parts') if isinstance(p.get('parts'), list) else []) + pile
        corps = p.get('body') if isinstance(p.get('body'), dict) else {}
        if p.get('mimeType') in brut and isinstance(corps.get('data'), str):
            try:
                brut[p['mimeType']].append(base64.urlsafe_b64decode(corps['data'] + '=' * (-len(corps['data']) % 4)).decode('utf-8', 'replace'))
            except ValueError:
                pass
    if brut['text/plain']:
        return '\n'.join(brut['text/plain'])
    sans_script = re.sub(r'(?is)<(script|style).*?</\1>', ' ', '\n'.join(brut['text/html']))
    return html.unescape(re.sub(r'<[^>]+>', ' ', sans_script))


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
    """Message Gmail (format full) -> {id, date, instant, fournisseur, type, montant, devise, devise_probable, a_verifier} ou None (pas un reçu connu)."""
    if not isinstance(msg, dict) or not isinstance(msg.get('id'), str):
        return None
    charge = msg.get('payload')
    entetes = charge.get('headers') if isinstance(charge, dict) else None
    ent = {str(h.get('name', '')).lower(): str(h.get('value', '')) for h in entetes if isinstance(h, dict)} if isinstance(entetes, list) else {}
    objet, de = ent.get('subject', ''), ent.get('from', '')
    nom, date = fournisseur(de, objet), date_iso(msg.get('internalDate'))
    rembourse = bool(REMBOURSEMENT.search(objet))
    if not nom or not date or CORRECTION.search(objet) or not (rembourse or OBJET_RECU.search(objet)):
        return None
    montant, devise = montant_paye(corps_texte(charge) or f'{objet} {msg.get("snippet") or ""}', rembourse)
    probable = DEVISE_PROBABLE.get(nom) if devise is None and montant is not None else None
    return {'id': msg['id'], 'date': date, 'instant': datetime.datetime.fromtimestamp(int(msg['internalDate']) / 1000, datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
            'fournisseur': nom, 'type': 'remboursement' if rembourse else 'recu', 'montant': montant, 'devise': devise, 'devise_probable': probable,
            'a_verifier': montant is None or devise is None}


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
        url = f'{API}/{urllib.parse.quote(i)}?format=full'
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
    """Première fois ; ou fichier d'une ancienne VERSION ; ou dernier essai en échec depuis 6 h ; ou dernière lecture réussie depuis 7 jours."""
    if not etat or etat.get('v') != VERSION:
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
            recus = lire_messages(acces, JOURS_ENSUITE if etat and etat.get('lu_le') and etat.get('v') == VERSION else JOURS_PREMIERE, requete)
        except ErreurGmail as e:
            if e.code in ('client_absent', 'jeton_absent'):
                return ''                                            # pas encore autorisé : rien à dire à chaque tour
            ecrire_etat({**(etat or {}), 'v': VERSION, 'tentative': maintenant, 'erreur': e.code, 'recus': (etat or {}).get('recus', [])}, p)
            return 'Gmail : ' + ('autorisation à refaire (geste de Marc)' if e.code == 'reautoriser' else f'échec ({e.code})')
        liste, neufs = fusionner((etat or {}).get('recus', []), recus)
        ecrire_etat({'v': VERSION, 'lu_le': maintenant, 'tentative': maintenant, 'erreur': None, 'recus': liste}, p)
        return f'Gmail : {len(recus)} reçu(s) lu(s), {neufs} nouveau(x)'
    except Exception as e:                                           # jamais bloquer le tour ; se DIT
        return f'Gmail : ÉCHEC {type(e).__name__}'
