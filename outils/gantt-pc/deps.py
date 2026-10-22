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

# Lecture de la ligne « **Attend** : ... » : « #12 » (le dépôt de la tâche), « MoKarade/x#3 » ET la forme courte « Hubperso#311 » / « MemoryAI#63 » que les fils
# écrivent le plus souvent. Avant le 22/10/2026 seule la forme avec « MoKarade/ » gardait le dépôt : « Hubperso#311 » devenait « #311 » du dépôt de la tâche
# (5 faux « dépendance inconnue » sur batchchef-#275, memoryai#63 et hub-contract#78, créées à 17:46Z).
# Noms reconnus : ceux des dix dépôts (en minuscules, comme les références du relevé) ; « batchchef » seul vaut « batchchef- » (nom d'usage).
import re
NOMS_DEPOTS = ['.github', 'financeai', 'jobai', 'batchchef-', 'batchchef', 'driveai', 'hubperso', 'carai', 'memoryai', 'app-template', 'hub-contract']
ALIAS_DEPOTS = {'batchchef': 'batchchef-'}
REF_ATTEND = re.compile(r'(?:MoKarade/([\w.-]+)|(?<![\w./-])(' + '|'.join(re.escape(n) for n in sorted(NOMS_DEPOTS, key=len, reverse=True)) + r'))?#(\d+)', re.I)

def lire_attend(body, repo):
    """Les dépendances écrites sur la ligne « **Attend** » : « dépôt#n » en minuscules. « **Attend** : rien (PR #n fusionnée) » n'attend rien (le #n est une remarque)."""
    deps = []
    for line in (body or '').splitlines():
        if line.startswith('**Attend**'):
            avant = line.split('—')[0]
            if re.match(r'^\*\*Attend\*\*[\s:*]*(?:rien|aucune?|néant)\b', avant, re.I): continue
            for plein, court, num in REF_ATTEND.findall(avant):
                nom = (plein or court or repo).lower()
                deps.append(f"{ALIAS_DEPOTS.get(nom, nom)}#{num}")
    return deps
