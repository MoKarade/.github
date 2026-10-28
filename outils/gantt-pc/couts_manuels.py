#!/usr/bin/env python3
"""Registre des dépenses de Marc, lu dans un fichier PRIVÉ du PC (26/10/2026, Marc : « Oui pour couts manuels »).

Le dépôt est public : aucun montant ne s'y trouve. Le fichier vit hors dépôt (`C:\\dev\\_pc-local\\couts-manuels.json`,
autre chemin : variable `COUTS_MANUELS_FILE`). Ce module le lit, ne garde que les clés connues et rend le tout tel quel :
aucune valeur n'est calculée ni inventée. Fichier absent, illisible, trop gros ou sans clé connue : `(None, raison)`.
"""
from __future__ import annotations

import json
import os

CHEMIN_DEFAUT = r'C:\dev\_pc-local\couts-manuels.json'
CLES = ('vercel_recus', 'vercel_courant', 'lignes', 'avenir', 'notes')
TAILLE_MAX = 200 * 1024


def chemin(env=None) -> str:
    env = os.environ if env is None else env
    return env.get('COUTS_MANUELS_FILE') or CHEMIN_DEFAUT


def lire(chemin_fichier: str | None = None) -> tuple[dict | None, str]:
    """(registre, raison) : registre = None si rien d'utilisable, raison dit pourquoi en une ligne."""
    p = chemin_fichier or chemin()
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
