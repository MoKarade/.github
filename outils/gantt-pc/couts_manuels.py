#!/usr/bin/env python3
"""Registre des dépenses de Marc, lu dans un fichier PRIVÉ du PC (26/10/2026, Marc : « Oui pour couts manuels »).

Le dépôt est public : aucun montant ne s'y trouve. Le fichier vit hors dépôt (`C:\\dev\\_pc-local\\couts-manuels.json`,
autre chemin : variable `COUTS_MANUELS_FILE`). Ce module le lit, ne garde que les clés connues et rend le tout tel quel :
aucune valeur n'est calculée ni inventée. Fichier absent, illisible, trop gros ou sans clé connue : `(None, raison)`.

28/10/2026 (tâche .github#657) : s'y ajoute, sous la clé `recus_gmail`, le fichier PRIVÉ `recus-gmail.json` écrit une fois par semaine par
gmail_recus.py (reçus lus dans Gmail en lecture seule : date, fournisseur, montant, devise, `a_verifier`). Il ne remplace jamais le registre :
les deux coexistent, la page montre les reçus lus avec leur date de lecture (`lu_le`) et leur éventuelle `erreur`.
"""
from __future__ import annotations

import json
import os

CHEMIN_DEFAUT = r'C:\dev\_pc-local\couts-manuels.json'
CLES = ('vercel_recus', 'vercel_courant', 'lignes', 'avenir', 'notes')
TAILLE_MAX = 200 * 1024
RECUS_DEFAUT = r'C:\dev\_pc-local\recus-gmail.json'


def chemin(env=None) -> str:
    env = os.environ if env is None else env
    return env.get('COUTS_MANUELS_FILE') or CHEMIN_DEFAUT


def chemin_recus(env=None) -> str:
    env = os.environ if env is None else env
    return env.get('GMAIL_RECUS_FILE') or RECUS_DEFAUT


def lire_recus(chemin_fichier: str) -> dict | None:
    """Bloc `recus_gmail` (lu_le, erreur, recus) ou None si le fichier est absent, trop gros ou illisible. Rien n'est recalculé."""
    try:
        if os.path.getsize(chemin_fichier) > TAILLE_MAX:
            return None
        with open(chemin_fichier, encoding='utf-8') as f:
            brut = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(brut, dict) or not isinstance(brut.get('recus'), list):
        return None
    return {k: brut.get(k) for k in ('lu_le', 'erreur', 'recus')}


def lire(chemin_fichier: str | None = None, recus_fichier: str | None = None) -> tuple[dict | None, str]:
    """(registre, raison) : registre = None si rien d'utilisable, raison dit pourquoi en une ligne.
    `recus_fichier` : reçus Gmail ; par défaut le fichier du PC, sauf quand un registre est désigné explicitement (tests)."""
    registre, raison = _lire_registre(chemin_fichier or chemin())
    recus = lire_recus(recus_fichier or (chemin_recus() if chemin_fichier is None else ''))
    if recus is None:
        return registre, raison
    return {**(registre or {}), 'recus_gmail': recus}, 'ok'


def _lire_registre(p: str) -> tuple[dict | None, str]:
    try:
        taille = os.path.getsize(p)
    except OSError:
        return None, 'fichier absent'
    if taille > TAILLE_MAX:
        return None, f'fichier trop gros ({taille // 1024} Ko, plafond {TAILLE_MAX // 1024} Ko)'
    try:
        with open(p, encoding='utf-8') as f:
            brut = json.load(f)
    except (OSError, ValueError) as e:
        return None, f'illisible ({type(e).__name__})'
    if not isinstance(brut, dict):
        return None, 'racine du JSON non objet'
    garde = {k: brut[k] for k in CLES if k in brut}
    if not garde:
        return None, 'aucune clé connue'
    return garde, 'ok'
