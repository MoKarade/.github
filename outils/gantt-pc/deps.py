# Dépendances écrites vers une PR (« **Attend** : #208 ») : ni tâche connue ni défaut utile. Réparées dans le relevé, sans toucher l'issue :
# une PR qui cite une tâche (« Tâche : #n ») devient cette tâche ; une PR fusionnée sans tâche est une dépendance déjà levée ; le reste est gardé tel quel
# (la pastille « dépendance inconnue » le signale : un numéro qui n'existe pas nulle part, comme memoryai#128 dans .github#16, 22/10/2026).

def normaliser(deps, soi, pr_vers_tache, prs_fusionnees):
    """deps : références « dépôt#n » en minuscules ; soi : la référence de la tâche ; pr_vers_tache : {PR -> tâche qu'elle cite} ; prs_fusionnees : ensemble de PR fusionnées.
    -> liste triée sans doublon, sans la tâche elle-même."""
    out = set()
    for d in deps:
        d = pr_vers_tache.get(d, d)
        if d in prs_fusionnees: continue        # PR fusionnée sans tâche : travail fini, rien à attendre
        if d != soi: out.add(d)
    return sorted(out)
