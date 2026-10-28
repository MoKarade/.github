# Un relevé qui PERD des éléments n'est pas un relevé : les tâches ne disparaissent pas de GitHub (la fenêtre `since` du relevé est fixe, donc les
# éléments ne font que s'ajouter). Une perte brutale vient d'une lecture incomplète (page vide de GitHub, 22/10/2026) : on garde le relevé précédent.
import datetime

SEUIL = 5            # éléments perdus dans un même dépôt à partir desquels le relevé est refusé
AGE_MAX_S = 3 * 3600 # au-delà, le relevé précédent ne fait plus foi : le nouveau est accepté (un vrai retrait durable ne bloque pas le relevé pour toujours)

# Remplacement d'un dépôt par un dépôt neuf du même nom (FinanceAI, 28/10/2026 : ancien dépôt devenu FinanceAI-archive, 90 -> 30 éléments
# par renumérotation). Une perte de CE dépôt n'est pas une lecture incomplète : elle est ignorée jusqu'à la date indiquée, puis la garde
# reprend (le relevé accepté entre-temps devient le précédent, donc plus aucune perte à ignorer). Une entrée = un changement connu, daté.
BASCULES = {'FinanceAI': datetime.datetime(2026, 10, 29, 12, 0, tzinfo=datetime.timezone.utc)}

def pertes(prec, nouveau, maintenant, seuil=SEUIL, age_max=AGE_MAX_S, bascules=BASCULES):
    """prec, nouveau : relevés ({'asof', 'repos': [{'repo', 'nodes': {n: ...}}]}) ; maintenant : datetime UTC.
    -> [(dépôt, avant, après)] des dépôts qui ont perdu au moins `seuil` éléments ; [] si le précédent est absent, illisible ou trop vieux."""
    try:
        age = (maintenant - datetime.datetime.fromisoformat(prec['asof'].replace('Z', '+00:00'))).total_seconds()
        avant = {r['repo']: len(r['nodes']) for r in prec['repos']}
    except (KeyError, TypeError, ValueError, AttributeError):
        return []
    if age > age_max: return []
    apres = {r['repo']: len(r['nodes']) for r in nouveau['repos']}
    return [(d, n, apres.get(d, 0)) for d, n in avant.items() if n - apres.get(d, 0) >= seuil and not (d in bascules and maintenant < bascules[d])]
