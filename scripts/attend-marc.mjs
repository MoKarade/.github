// Une PR qui n'attend plus qu'un geste de Marc n'occupe pas le dépôt (docs/archive/cycle-de-vie-tache-2026-10-29.md §6, tâches #197 et #216).
//
// Le signe est UN seul : le Garde-fou, quand il est rouge « la PR attend Marc », ouvre une issue `qui:marc` au titre
// « Garde-fou : la PR #n attend un geste de Marc » (scripts/garde-fou.mjs) et la ferme quand le blocage est levé.
// Ce module dit comment la lire. Le Réacteur (reveil-reacteur.mjs) l'importe ; le relevé du Gantt (outils/gantt-pc/fetch.py)
// en garde la même expression, car il est en Python : scripts/reveil-reacteur.test.mjs échoue si les deux divergent.
//
// Fonction pure : aucune lecture réseau.

export const LABEL_ATTEND_MARC = 'qui:marc';
export const TITRE_ATTEND_MARC = /^Garde-fou : la PR #(\d+) attend un geste de Marc$/;

/** Numéros des PR dont le seul obstacle est un geste de Marc, d'après les issues `qui:marc` OUVERTES données. Trié, sans doublon. */
export function prAttendantMarc(issues) {
  const numeros = new Set();
  for (const i of issues ?? []) {
    if (i.pull_request || (i.state && i.state !== 'open')) continue;
    if (!(i.labels ?? []).some((l) => (l.name ?? l) === LABEL_ATTEND_MARC)) continue;
    const m = TITRE_ATTEND_MARC.exec(i.title ?? '');
    if (m) numeros.add(Number(m[1]));
  }
  return [...numeros].sort((a, b) => a - b);
}
