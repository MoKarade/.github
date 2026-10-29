// Une seule règle de Marc reste du comptage de places (nettoyage du 29/10/2026, « go reco ») : pas deux PR sur les mêmes fichiers.
// Plus de limite de places, plus de fichiers estimés : on lit les fichiers RÉELS des PR ouvertes, et la ligne « Fichiers touchés » (ou « Fichiers permis »)
// de la tâche quand elle existe. Fichiers inconnus = aucun blocage (avant : « dans le doute, un seul ») ; seul Jules garde le doute (`raisonIncompatible`).
// Fonctions pures partagées par `acceptation-marquage.mjs` (la file calculée `prochaine-tache.mjs` et `file-depot.mjs` ont été retirées le 29/10/2026) ; `controleFichiers` (I/O, `api` injecté)
// est le contrôle « Fichiers » du Garde-fou.

import { dispense } from './tache-liee.mjs';

export const MARQUEUR_FICHIERS = '<!-- garde-fou-fichiers -->';
/** Ancien marqueur du contrôle « Places » : les commentaires déjà posés sont repris et mis à jour par le contrôle « Fichiers ». */
export const MARQUEUR_ANCIEN_PLACES = '<!-- garde-fou-places -->';

// Journaux que presque chaque PR touche (la doc touchée se met à jour dans la MÊME PR) : ils ne rendent pas deux travaux incompatibles,
// un conflit de texte s'y règle en fusionnant la base. Même sort pour les deux index que chaque tâche complète (21/10/2026, demande de JobAI : cinq tâches
// prêtes ne pouvaient pas tourner ensemble pour cela seul) : `docs/INDEX.md` (généré : on le régénère après la fusion de la base) et `docs/adr/README.md`
// (une ligne ajoutée par ADR). Tout autre fichier commun (package.json, lockfile, CLAUDE.md, AGENTS.md…) compte.
const JOURNAUX = /(^|\/)(HANDOVER|CHANGELOG)\.md$|^docs\/(INDEX|adr\/README)\.md$/i;

// « **Fichiers permis** (aucun autre) : » (PR de Jules, `jules-suivi.mjs`) ou « **Fichiers touchés** : » (tâche écrite pour Claude),
// suivi d'une liste à puces. Même grammaire que `fichiers_declares` de outils/gantt-pc/fetch.py. Un corps peut porter les deux (une estimation
// automatique écrite jadis par le filet, supprimée, puis un « Fichiers permis » exact) : « permis » d'abord, « touchés » à défaut.
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

/** Le conflit de deux travaux : 'fichier-commun:<chemin>' ou null. Une liste inconnue ou vide ne bloque RIEN (règle de la file et du Garde-fou). */
export function conflitDeFichiers(a, b) {
  const [x, y] = [sansJournaux(a), sansJournaux(b)];
  if (!Array.isArray(x) || !Array.isArray(y) || !x.length || !y.length) return null;
  const c = cheminCommun(a, b);
  return c === null ? null : `fichier-commun:${c}`;
}

/** Comme `conflitDeFichiers`, mais dans le doute on bloque (Jules, qui ne tient pas de place et ne devine rien) : 'fichiers-inconnus' si une liste manque. */
export function raisonIncompatible(a, b) {
  const [x, y] = [sansJournaux(a), sansJournaux(b)];
  if (!Array.isArray(x) || !Array.isArray(y) || !x.length || !y.length) return 'fichiers-inconnus';
  return conflitDeFichiers(a, b);
}

const PAGES_MAX = 3;

/** Les fichiers réels d'une PR (noms actuels et anciens), ou null si la liste est tronquée ou illisible : elle ne prouve rien. */
async function fichiersReels(api, depot, numero) {
  const noms = [];
  for (let page = 1; page <= PAGES_MAX; page += 1) {
    const lot = await api('GET', `/repos/${depot}/pulls/${numero}/files?per_page=100&page=${page}`);
    if (!Array.isArray(lot)) return null;
    noms.push(...lot.flatMap((f) => [f.filename, f.previous_filename]).filter(Boolean));
    if (lot.length < 100) return [...new Set(noms)];
  }
  return null;
}

/**
 * Contrôle « Fichiers » du Garde-fou : une PR sortie du brouillon ne touche pas un fichier déjà touché par une AUTRE PR ouverte sortie du brouillon.
 * Quand deux PR se recoupent, la plus ancienne (numéro le plus petit) garde ses fichiers : la règle ne rougit jamais les deux.
 * @param pr la PR contrôlée ; @param fichiers ses fichiers (liste de l'API GitHub) ; @param lien résultat de `controleTacheLiee`
 * @param depot « MoKarade/<dépôt> » ; @param api (méthode, chemin) -> JSON ou null (404)
 * Une lecture qui échoue n'est PAS un refus : avertissement seulement.
 */
export async function controleFichiers({ api, depot, pr, fichiers, lien }) {
  const sansObjet = (raison) => ({ ok: true, raison, conflits: [], avertissement: null });
  if (pr?.draft === true) return sansObjet('brouillon');
  if (lien?.dispense) return sansObjet(lien.dispense);
  if (lien?.ouvertes?.some((t) => t.jules)) return sansObjet('tâche de Jules');
  const miens = [...new Set((fichiers ?? []).flatMap((f) => [f.filename, f.previous_filename]).filter(Boolean))];
  if (sansJournaux(miens).length === 0) return sansObjet('aucun fichier hors journaux');
  try {
    const ouvertes = (await api('GET', `/repos/${depot}/pulls?state=open&per_page=100`)) ?? [];
    const conflits = [];
    for (const autre of ouvertes) {
      if (autre.number >= pr.number || autre.draft === true || dispense(autre)) continue;
      const siens = await fichiersReels(api, depot, autre.number);
      if (!siens) continue;
      const commun = cheminCommun(miens, siens);
      if (commun) conflits.push({ pr: autre.number, chemin: commun });
    }
    return { ok: conflits.length === 0, raison: null, conflits, avertissement: null };
  } catch (erreur) {
    return { ok: true, raison: null, conflits: [], avertissement: `PR ouvertes illisibles (${erreur.message}) : contrôle sauté` };
  }
}

export function rapportFichiers(verdict) {
  if (verdict.avertissement) return `Fichiers : non contrôlés, ${verdict.avertissement}.`;
  if (verdict.raison) return `Fichiers : sans objet (${verdict.raison}).`;
  if (verdict.ok) return 'Fichiers : vert (aucun fichier commun avec une autre PR ouverte).';
  const liste = verdict.conflits.slice(0, 4).map((c) => `#${c.pr} (\`${c.chemin}\`)`).join(', ');
  return [
    `Fichiers : **rouge**, cette PR touche des fichiers déjà touchés par une autre PR ouverte : ${liste}.`,
    '',
    'Règle de Marc : pas deux PR sur les mêmes fichiers. La plus ancienne garde ses fichiers.',
    '',
    'Pour lever, au choix : (1) attendre la fusion de l’autre PR, puis relancer le contrôle « Garde-fou » (Re-run jobs) ; (2) retirer ces fichiers de cette PR ; (3) repasser cette PR en brouillon pendant qu’elle itère.',
  ].join('\n');
}
