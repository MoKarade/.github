# Qui compte comme preuve d'une tâche fermée : la même règle que le garde-fou (scripts/preuve.mjs, humain() et automatique()).
# Un commentaire « **Acceptée** … » écrit par une personne ou par Claude (jamais Jules), ou l'acceptation automatique du robot
# `github-actions[bot]` marquée `<!-- acceptation-auto -->` (cycle de vie §10 ter). Tout autre robot ne prouve rien.
# Sans cette règle, .github#402 et #418 (fermées « Acceptée » par le robot) comptaient « fermée sans preuve » (22/10/2026).
import re

DEBUT = re.compile(r'^\s*\*\*\s*Accept[ée]e\s*\*\*', re.I)
MARQUEUR_AUTO = '<!-- acceptation-auto -->'
ROBOT_AUTO = 'github-actions[bot]'

def est_preuve(commentaire):
    """commentaire : un objet de l'API GitHub (body, user.type, user.login) -> True s'il compte comme « Acceptée »."""
    corps = commentaire.get('body') or ''
    if not DEBUT.match(corps): return False
    user = commentaire.get('user') or {}
    login = (user.get('login') or '')
    if login == ROBOT_AUTO: return MARQUEUR_AUTO in corps
    return user.get('type') == 'User' and 'jules' not in login.lower()
