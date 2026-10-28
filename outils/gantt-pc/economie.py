# Un tour économe (quota REST sous 1 500) ne doit jamais devenir un relevé PLEIN (~280 appels). fetch.py ne sait faire un relevé léger que si le relevé
# précédent a le bon format et moins de 45 min ; sinon il relit tout. Un relevé refusé par le garde de complétude (ou un tour sauté) laisse le précédent
# vieillir : mesuré le 28/10/2026, chaque tour refait alors un plein de ~280 appels, jusqu'à vider le jeton (602 restants à 21:52Z, 5 000 au départ).
import datetime

AGE_LEGER_MAX_S = 45 * 60    # au-delà, le relevé précédent ne sert plus de base à un relevé léger (une seule définition, lue aussi par fetch.py)
VERSION_LEGER_MIN = 10

def leger_possible(prec, maintenant, age_max=AGE_LEGER_MAX_S):
    """prec : le relevé précédent (dict) ou None ; maintenant : datetime UTC. Vrai si fetch.py --leger partirait de lui sans relire tout."""
    try:
        if prec.get('v', 0) < VERSION_LEGER_MIN: return False
        age = (maintenant - datetime.datetime.fromisoformat(prec['asof'].replace('Z', '+00:00'))).total_seconds()
    except (KeyError, TypeError, ValueError, AttributeError):
        return False
    return age <= age_max

def sauter_le_plein(econome, prec, maintenant):
    """Au tour économe, le relevé est SAUTÉ (le précédent reste, la page le montre en retard) plutôt que refait en plein."""
    return bool(econome) and not leger_possible(prec, maintenant)
