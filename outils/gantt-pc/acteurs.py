# Qui a travaillé sur une tâche, lu dans les commits de sa PR (refonte du workflow, demande de Marc du 26/10/2026 : « oui pour gantt »).
# Pur : reçoit les commits de l'API GitHub (`pulls/<n>/commits`), rend [{qui, debut, fin, commits}] trié par début.
#
#   Copilot : commits de `copilot-swe-agent[bot]`.
#   Jules   : commits de `google-labs-jules[bot]`.
#   Claude  : commits dont le message porte l'attribution de session (« Co-Authored-By: Claude », lien claude.ai/code/session).
#   Marc    : tout le reste (ses propres commits).
# Les commits de Claude passent sous l'identité de Marc : seule l'attribution du message les distingue. Un commit de Claude sans
# attribution compte donc pour Marc ; la plage d'un fil Claude est un minimum (sa lecture avant le premier commit ne laisse pas de trace).
import re

BOTS = {'copilot-swe-agent[bot]': 'Copilot', 'copilot': 'Copilot', 'google-labs-jules[bot]': 'Jules'}
CLAUDE = re.compile(r'Co-Authored-By:\s*Claude|claude\.ai/code/session', re.I)


def qui(commit):
    """Le nom de l'acteur d'un commit de l'API : Copilot, Jules, Claude ou Marc."""
    c = commit.get('commit') or {}
    for nom in ((c.get('author') or {}).get('name'), (commit.get('author') or {}).get('login'), (c.get('committer') or {}).get('name')):
        if nom and nom.lower() in BOTS: return BOTS[nom.lower()]
    return 'Claude' if CLAUDE.search(c.get('message') or '') else 'Marc'


def acteurs(commits):
    """[{qui, debut, fin, commits}] : première et dernière modification de chaque acteur (dates d'auteur ISO), du plus tôt au plus tard."""
    par = {}
    for cm in commits or []:
        c = cm.get('commit') or {}
        d = (c.get('author') or {}).get('date') or (c.get('committer') or {}).get('date')
        if not d: continue
        p = par.setdefault(qui(cm), {'qui': qui(cm), 'debut': d, 'fin': d, 'commits': 0})
        p['debut'], p['fin'], p['commits'] = min(p['debut'], d), max(p['fin'], d), p['commits'] + 1
    return sorted(par.values(), key=lambda p: (p['debut'], p['qui']))
