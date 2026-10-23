#!/usr/bin/env node
// Capacité d'un dépôt : UN travail à la fois (décision de Marc, 21/10/2026 20:00Z, « 124 » : économiser le quota Claude). Entre 13:21Z et 20:00Z ce même
// jour, DEUX travaux pouvaient avancer ensemble sur des fichiers disjoints (option 2 : « plusieurs fils sur un même projet en même temps ») : toute la
// mécanique reste en place et se rouvre en changeant `PLACES_PAR_DEPOT` (les tests de parallélisme tournent à deux places, `places-deux.mjs`).
// Un travail est une tâche `en-cours`, ou la PR ouverte d'une tâche (une tâche `jules` n'en est pas un depuis le 23/10/2026).
// Ce module ne fait que des fonctions pures, partagées par `prochaine-tache.mjs` (la file), `jules-auto.mjs` (fichiers déjà pris)
// et testées sans réseau : lire les fichiers qu'une tâche déclare, et dire si deux travaux peuvent avancer ensemble.
//
// Règle du doute : un travail dont les fichiers ne sont pas déclarés (ou illisibles) n'est compatible avec RIEN. Dans le doute, un seul.

// `PLACES_ENV` ne sert qu'aux tests (`places-deux.mjs`) ; en production la valeur est celle de la décision de Marc.
export const PLACES_PAR_DEPOT = Number(process.env.PLACES_ENV) || 1;

// Journaux que presque chaque PR touche (la doc touchée se met à jour dans la MÊME PR) : ils ne rendent pas deux travaux incompatibles,
// un conflit de texte s'y règle en fusionnant la base. Même sort pour les deux index que chaque tâche complète (21/10/2026, demande de JobAI : cinq tâches
// prêtes ne pouvaient pas tourner ensemble pour cela seul) : `docs/INDEX.md` (généré : on le régénère après la fusion de la base) et `docs/adr/README.md`
// (une ligne ajoutée par ADR). Tout autre fichier commun (package.json, lockfile, CLAUDE.md, AGENTS.md…) compte.
const JOURNAUX = /(^|\/)(HANDOVER|CHANGELOG)\.md$|^docs\/(INDEX|adr\/README)\.md$/i;

// « **Fichiers permis** (aucun autre) : » (gabarit Jules, docs/jules-gabarit-issue.md) ou « **Fichiers touchés** : » (tâche écrite pour Claude),
// suivi d'une liste à puces. Même grammaire que `fichiers_declares` de outils/gantt-pc/fetch.py. Un corps peut porter les deux (une estimation
// automatique de `fichiers-touches.mjs`, puis le « Fichiers permis » exact du gabarit Jules) : « permis » d'abord, « touchés » à défaut.
const SECTION = /^\s*\*\*\s*Fichiers (permis|touchés)\s*\*\*[^\n]*\n((?:[ \t]*[-*][ \t][^\n]*(?:\n|$))+)/gim;

const nettoyer = (c) => String(c).trim().replace(/^\.\//, '').replace(/[`,;:.]+$/g, '').replace(/\\/g, '/');

/**
 * Les chemins qu'une tâche déclare toucher, ou null si elle n'en déclare aucun lisible (ou seulement des journaux).
 * Un chemin est ce qui est entre `backticks` sur chaque puce, à défaut le premier mot de la puce.
 */
export function fichiersDeclares(body) {
  const sections = [...String(body ?? '').matchAll(SECTION)].sort((a, b) => Number(/touch/i.test(a[1])) - Number(/touch/i.test(b[1])));
  for (const m of sections) {
    const chemins = [];
    for (const ligne of m[2].split('\n')) {
      if (!/^[ \t]*[-*][ \t]/.test(ligne)) continue;
      const texte = ligne.replace(/^[ \t]*[-*]\s*/, '');
      const cites = [...texte.matchAll(/`([^`]+)`/g)].map((x) => x[1]);
      const c = (cites.length ? cites : [texte.split(/\s+/)[0]]).map(nettoyer).filter((x) => x && !/^(aucun|rien|n\/a)$/i.test(x));
      chemins.push(...c);
    }
    const utiles = [...new Set(chemins)].filter((c) => !JOURNAUX.test(c));
    if (utiles.length) return utiles;
  }
  return null;
}

/**
 * Les fichiers d'un travail en cours : ceux que sa tâche DÉCLARE plus ceux que sa PR ouverte touche VRAIMENT (`pr.ff` du relevé du PC). La réalité
 * s'ajoute à la déclaration sans la remplacer : une PR peut encore grandir jusqu'à ses fichiers déclarés. `reels` null = liste tronquée ou absente
 * (le relevé ne garde pas les PR de 100 fichiers ou plus) : elle ne fournit rien. Résultat null = rien de connu (hors journaux) : pas de parallèle.
 */
export function fichiersDuTravail(declares, reels) {
  const tous = [...new Set([...(Array.isArray(declares) ? declares : []), ...(Array.isArray(reels) ? reels : [])])].filter((c) => !JOURNAUX.test(nettoyer(c)));
  return tous.length ? tous : null;
}

/** Un chemin devient soit un fichier exact, soit un préfixe (dossier `a/b/` ou motif `a/b/*.ts` : tout ce qui précède l'étoile). */
function forme(chemin) {
  const c = nettoyer(chemin).toLowerCase();
  const etoile = c.indexOf('*');
  if (etoile >= 0) return { prefixe: c.slice(0, etoile) };
  if (c.endsWith('/')) return { prefixe: c };
  return { exact: c };
}

/** Deux chemins se recouvrent-ils ? (même fichier, ou l'un est dans le dossier/motif de l'autre) */
export function seRecouvrent(a, b) {
  const x = forme(a);
  const y = forme(b);
  if (x.exact !== undefined && y.exact !== undefined) return x.exact === y.exact;
  if (x.exact !== undefined) return x.exact.startsWith(y.prefixe);
  if (y.exact !== undefined) return y.exact.startsWith(x.prefixe);
  return x.prefixe.startsWith(y.prefixe) || y.prefixe.startsWith(x.prefixe);
}

/** Les chemins d'une liste hors journaux (le relevé du PC peut les avoir gardés). */
const sansJournaux = (l) => (Array.isArray(l) ? l.filter((c) => !JOURNAUX.test(nettoyer(c))) : l);

/** Le premier chemin commun de deux listes, ou null. */
export function cheminCommun(a, b) {
  for (const p of sansJournaux(a)) for (const q of sansJournaux(b)) if (seRecouvrent(p, q)) return p === q ? p : `${p} ~ ${q}`;
  return null;
}

/**
 * Deux travaux peuvent-ils avancer ensemble ? Faux si l'un des deux ne déclare pas ses fichiers (null, vide), ou s'ils ont un chemin commun.
 * @param a liste de chemins ou null
 * @param b liste de chemins ou null
 */
export function compatibles(a, b) {
  return raisonIncompatible(a, b) === null;
}

/** Pourquoi deux travaux ne vont pas ensemble : 'fichiers-inconnus' | 'fichier-commun:<chemin>' | null (compatibles). */
export function raisonIncompatible(a, b) {
  const [x, y] = [sansJournaux(a), sansJournaux(b)];
  if (!Array.isArray(x) || !Array.isArray(y) || !x.length || !y.length) return 'fichiers-inconnus';
  const c = cheminCommun(a, b);
  return c === null ? null : `fichier-commun:${c}`;
}
