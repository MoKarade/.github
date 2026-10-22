# Quand chaque dépôt était privé (fonctions pures ; quota.py y mémorise l'historique dans quota_cache.json).
# Pourquoi : GitHub ne facture des minutes Actions que pour les exécutions lancées PENDANT que le dépôt est privé. Lire la visibilité
# du moment seulement faisait compter tout le mois d'un dépôt devenu privé hier (FinanceAI, 21/10 : 5 478 min comptées, ~90 facturables).
# Historique : liste d'instants [[iso, privé?], ...] triée ; l'état d'un instant est celui de la dernière entrée antérieure ou égale.

DEBUT = '0000-00-00T00:00:00Z'   # « depuis toujours » : un dépôt vu pour la première fois est supposé inchangé avant la première lecture

# Passages connus avant la première lecture (GitHub ne donne pas l'historique de visibilité). Chaque date est une borne HAUTE de la
# consommation facturée : on compte à partir du dernier instant où le dépôt était sûrement public (ou jusqu'au premier où il l'était).
SEMIS = {
    # FinanceAI : public à la création de FinanceAI#1238 (21/10/2026 18:06Z), privé à celle de #1240 (18:28Z) ; geste de Marc le 21/10.
    'FinanceAI': [[DEBUT, False], ['2026-10-21T18:06:00Z', True]],
    # CarAI et MemoryAI : privés, puis publics à leur « Première version publique » (19/10/2026 13:20:54Z et 17:39:34Z).
    'carai': [[DEBUT, True], ['2026-10-19T13:20:54Z', False]],
    'memoryai': [[DEBUT, True], ['2026-10-19T17:39:34Z', False]],
}

def noter(hist, depot, prive, maintenant):
    """Ajoute à `hist` (modifié en place) la lecture du moment. Une lecture qui change l'état ajoute un passage à `maintenant`
    (précis à l'intervalle entre deux lectures) ; une lecture identique n'ajoute rien. -> True si `hist` a changé."""
    h = hist.get(depot)
    if not h:
        hist[depot] = [list(e) for e in SEMIS.get(depot, [])] or [[DEBUT, bool(prive)]]
        h = hist[depot]
        changed = True
    else:
        changed = False
    if bool(h[-1][1]) != bool(prive):
        h.append([maintenant, bool(prive)])
        changed = True
    return changed

def etait_prive(hist, depot, instant):
    """Le dépôt était-il privé à `instant` (iso UTC, même format que l'historique) ? Inconnu : jamais vu, donc non compté."""
    h = hist.get(depot)
    if not h: return False
    etat = h[0][1]
    for t, p in h:
        if t <= instant: etat = p
        else: break
    return bool(etat)

def a_ete_prive_depuis(hist, depot, instant):
    """Privé à `instant` ou devenu privé ensuite : ses exécutions depuis `instant` peuvent être facturées."""
    h = hist.get(depot)
    if not h: return False
    return etait_prive(hist, depot, instant) or any(p and t > instant for t, p in h)

def passages(hist, depot, depuis):
    """Passages (instant, privé?) de `depot` à partir de `depuis`, pour la note de la jauge."""
    return [(t, bool(p)) for t, p in (hist.get(depot) or []) if t >= depuis and t != DEBUT]
