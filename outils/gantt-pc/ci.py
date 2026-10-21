# CI d'une PR fusionnée, pour l'onglet Rythme de la page (Marc, 21/10/2026 : attente de CI séparée de l'attente de relecture, taux de CI rouge par app).
# Pur : reçoit les runs d'Actions de la branche (déjà bornés à la vie de la PR) et le dernier commit, rend {'ci': fin ISO | None, 'cr': 0 | 1 | None}.
import datetime

VAGUE_S = 300   # une sortie de brouillon relance la CI sur le même commit : seule la première vague (5 min) est du temps de CI


def _t(iso): return datetime.datetime.fromisoformat(iso.replace('Z', '+00:00'))


def resume_ci(runs, sha):
    """ci = fin de la première vague de runs sur le dernier commit (None si un run de la vague n'est pas fini ou si aucun ne porte ce commit).
    cr = 1 si au moins un run de la branche a échoué avant la fusion, 0 sinon, None sans aucun run (rien de mesuré n'est pas « vert »)."""
    if not runs: return {'ci': None, 'cr': None}
    cr = int(any(r.get('conclusion') == 'failure' for r in runs))
    tete = sorted((r for r in runs if sha and r.get('head_sha') == sha), key=lambda r: r['created_at'])
    if not tete: return {'ci': None, 'cr': cr}
    t0 = _t(tete[0]['created_at'])
    vague = [r for r in tete if (_t(r['created_at']) - t0).total_seconds() <= VAGUE_S]
    if any(r.get('status') != 'completed' for r in vague): return {'ci': None, 'cr': cr}
    return {'ci': max(vague, key=lambda r: _t(r['updated_at']))['updated_at'], 'cr': cr}
