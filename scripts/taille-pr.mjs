// Taille d'une PR (docs/archive/cycle-de-vie-tache-2026-10-29.md §1 : une tâche = une PR d'environ 400 lignes modifiées au plus, hors tests et
// fichiers générés). Jusqu'au 22/10/2026 la règle n'était vue qu'après coup, par la pastille du Gantt (driveai#468 : 1101 lignes,
// Hubperso#286 : 3356, memoryai#10 : 626). Ce module est appelé par le Garde-fou (scripts/garde-fou.mjs), donc par le contrôle
// « Garde-fou » déjà exigé dans les dix dépôts : une PR sortie du brouillon qui dépasse la limite est refusée, sauf dérogation.
//
// Même définition de « hors tests » que le relevé du Gantt (outils/gantt-pc/fetch.py, HORS_TAILLE) : si l'une change, l'autre aussi.
// Fonctions pures uniquement : la liste des fichiers vient du Garde-fou (toutes les pages de l'API, jusqu'à 3000 fichiers).

import { dispense } from './tache-liee.mjs';

export const LIMITE_LIGNES = 400;
export const LABEL_DEROGATION = 'derogation-taille';
export const MARQUEUR_TAILLE = '<!-- garde-fou-taille -->';

export const HORS_TAILLE = /(^|\/)(tests?|__tests__|e2e|fixtures?|__snapshots__|dist|captures)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)drizzle\/meta\/|\.snap$|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$|\.lock$/i;

/** Lignes ajoutées + supprimées, hors tests, lockfiles et fichiers générés (dont `drizzle/meta/`, l'instantané et le journal de drizzle-kit ; les `.sql` de `drizzle/` restent comptés). */
export function lignesModifiees(fichiers) {
  return (fichiers ?? []).reduce((somme, f) => (HORS_TAILLE.test(f.filename ?? '') ? somme : somme + (f.additions ?? 0) + (f.deletions ?? 0)), 0);
}

/**
 * Verdict de taille. Jamais refusés : les brouillons (ils itèrent), les robots dispensés (mises à jour, file de Mergify),
 * les PR qui portent l'étiquette de dérogation (posée par Marc ou le Coordinateur, avec la raison en commentaire).
 */
export function controleTaille({ pr, fichiers }) {
  const lignes = lignesModifiees(fichiers);
  const base = { lignes, limite: LIMITE_LIGNES };
  if (pr?.draft === true) return { ...base, ok: true, raison: 'brouillon' };
  const robot = dispense(pr);
  if (robot) return { ...base, ok: true, raison: robot };
  const etiquettes = (pr?.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
  if (etiquettes.includes(LABEL_DEROGATION)) return { ...base, ok: true, raison: `dérogation (${LABEL_DEROGATION})` };
  if (lignes > LIMITE_LIGNES) return { ...base, ok: false, raison: null };
  return { ...base, ok: true, raison: null };
}

export function rapportTaille(verdict) {
  const { ok, lignes, limite, raison } = verdict;
  if (raison) return `Taille : sans objet (${raison}), ${lignes} ligne(s) hors tests.`;
  if (ok) return `Taille : vert (${lignes} ligne(s) hors tests, limite ${limite}).`;
  return [
    `Taille : **rouge**, ${lignes} lignes modifiées hors tests, lockfiles et fichiers générés (limite ${limite}).`,
    '',
    'Une tâche tient en une PR d’environ 400 lignes au plus (cycle de vie §1) : au-delà, la PR est trop longue pour être relue sérieusement.',
    '',
    `Pour lever, au choix : (1) découper la PR en tâches plus petites ; (2) demander la dérogation à Marc ou au Coordinateur : l’étiquette \`${LABEL_DEROGATION}\` avec la raison en commentaire, puis relancer le contrôle « Garde-fou » (Re-run jobs). Repasser la PR en brouillon la met aussi hors de ce contrôle pendant qu’elle itère.`,
  ].join('\n');
}
