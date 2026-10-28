#!/usr/bin/env python3
"""Taux USD -> CAD du relevé (28/10/2026, Marc : « je veux être certain que ce soit des vraies données »).

Un SEUL taux, dans `quota.json` (clé `taux_usd_cad`), avec sa date et sa source : le taux moyen quotidien de la Banque du Canada
(série FXUSDCAD, API Valet, gratuite, sans jeton). Avant, trois valeurs coexistaient (1,38 dans le hub, 1,4305 dans la page, aucune date).

Règles : jamais de taux inventé. Lecture en échec : on garde le dernier taux lu, marqué `perime` et `erreur` ; aucun taux connu :
`taux: None` et `erreur`. Un taux hors de 0,5 à 3 est refusé (une série qui change de sens ne doit pas fausser tous les coûts).
Fonctions pures d'un côté (`analyser`, `mesure`), I/O de l'autre (`_requete`, injectable pour les tests).
"""
from __future__ import annotations

import datetime
import json
import math
import re
import urllib.request

URL = 'https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?recent=5'
SOURCE = 'Banque du Canada, série FXUSDCAD (taux moyen quotidien, API Valet)'
DELAI_S = 20
RELIRE_APRES_H = 6      # la banque ne publie qu'un taux par jour ouvrable : inutile de la solliciter à chaque tour
MIN_TAUX, MAX_TAUX = 0.5, 3.0
DATE = re.compile(r'^\d{4}-\d{2}-\d{2}$')


def analyser(texte: str) -> dict:
    """Réponse Valet -> {'taux', 'date'} de la dernière observation lisible. Lève ValueError si aucune."""
    try:
        observations = json.loads(texte)['observations']
    except (ValueError, KeyError, TypeError) as e:
        raise ValueError(f'réponse illisible ({type(e).__name__})') from e
    if not isinstance(observations, list):
        raise ValueError('observations absentes')
    lisibles = []
    for o in observations:
        try:
            date, valeur = o['d'], float(o['FXUSDCAD']['v'])
        except (KeyError, TypeError, ValueError):
            continue
        if DATE.match(str(date)) and math.isfinite(valeur) and MIN_TAUX <= valeur <= MAX_TAUX:
            lisibles.append((date, valeur))
    if not lisibles:
        raise ValueError('aucune observation lisible')
    date, valeur = max(lisibles)
    return {'taux': valeur, 'date': date}


def _requete(url: str = URL) -> str:
    with urllib.request.urlopen(url, timeout=DELAI_S) as r:
        return r.read(200_000).decode('utf-8', 'replace')


def _age_h(ancien: dict | None, maintenant: str) -> float | None:
    try:
        lu = datetime.datetime.fromisoformat(ancien['releve'].replace('Z', '+00:00'))
        ici = datetime.datetime.fromisoformat(maintenant.replace('Z', '+00:00'))
    except (KeyError, TypeError, ValueError, AttributeError):
        return None
    return (ici - lu).total_seconds() / 3600


def mesure(ancien: dict | None, maintenant: str, requete=_requete) -> dict:
    """Le bloc `taux_usd_cad` de quota.json. `ancien` : le bloc du relevé précédent (ou None). Ne lève jamais."""
    if ancien and ancien.get('taux') is not None and not ancien.get('erreur'):
        age = _age_h(ancien, maintenant)
        if age is not None and 0 <= age < RELIRE_APRES_H:
            return ancien
    try:
        lu = analyser(requete())
    except (OSError, ValueError) as e:
        raison = f'{type(e).__name__} : {str(e)[:120]}'
        if ancien and ancien.get('taux') is not None:
            return {**ancien, 'perime': ancien.get('releve'), 'erreur': raison}
        return {'taux': None, 'date': None, 'source': SOURCE, 'releve': maintenant, 'erreur': raison}
    return {'taux': lu['taux'], 'date': lu['date'], 'source': SOURCE, 'releve': maintenant}
