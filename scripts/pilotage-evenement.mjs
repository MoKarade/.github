#!/usr/bin/env node
// Pilotage des tâches et de Jules À L'ÉVÉNEMENT (tâche MoKarade/.github#715, mission #703 « tout par événements »).
// Avant : le tour du PC (`filet-pc.mjs`, toutes les 10 min) posait `faisable-jules`, complétait le corps des tâches, écrivait « Fichiers touchés » et
// « Acceptation automatique », suivait les PR de Jules, retirait les étiquettes des tâches fermées. Un PC éteint = rien de tout cela.
// Maintenant : le Réacteur (`reveil-reacteur.mjs`) appelle LES MÊMES fonctions, avec les mêmes règles et les mêmes plafonds, quand l'événement qui les
// rend utiles arrive (voir `PAR_EVENEMENT`). Aucune règle n'est réécrite ici : ce fichier ne fait que choisir quelle fonction part sur quel événement.
//
// Ce qui change par rapport au tour du PC, dit une fois :
//   - pas d'état gardé d'un passage à l'autre (un job GitHub ne garde rien) : le plafond « 20 complétées par 24 h » du gabarit et la mémoire de refus
//     ne vivent que le temps du passage (au plus UNE tâche complétée par passage, et un refus n'écrit rien) ; le signalement d'un problème est
//     dédoublonné par le Réacteur (même texte déjà sur la boîte depuis moins de 6 h = rien) ;
//   - `gh` est la CLI du job, jeton `github.token` (issues et pull-requests en écriture) : aucun nouveau secret ;
//   - un échec d'une étape est DIT (`erreurs`), les autres étapes passent ; le Réacteur le rend visible (avertissement, puis échec du run, donc
//     une issue `boucle:erreur` par `signaler-echec.yml`) : rien ne se perd en silence.
// Fonctions pures d'un côté (`etapesPour`, `lignesDe`), I/O de l'autre (`gh` injecté).
import { ghCli } from './lier-taches.mjs';
import { suivreDepot, menageFermees, marquerParJules } from './jules-suivi.mjs';
import { marquerFaisables, retirerPerimees } from './jules-marquage.mjs';
import { completerDepot as completerGabarit } from './jules-gabarit.mjs';
import { completerDepot as estimerFichiers, PAR_TOUR_MAX as ESTIMATIONS_PAR_TOUR } from './fichiers-touches.mjs';
import { completerDepot as marquerAcceptation, PAR_TOUR_MAX as MARQUAGES_PAR_TOUR } from './acceptation-marquage.mjs';

/** Les étapes, dans l'ordre où le tour du PC les faisait : une étiquette périmée libère la tâche avant qu'on la complète, la complétion précède la réservation. */
export const ETAPES = ['suivi', 'parJules', 'menage', 'perimees', 'completer', 'fichiers', 'acceptation', 'marquer'];

/**
 * Quelle étape pour quel événement du Réacteur.
 *   tache_ouverte (issue qui s'ouvre, change ou change d'étiquette) : tout ce qui prépare une tâche pour Jules ou pour un fil ;
 *   tache_fermee : les étiquettes de travail d'une tâche fermée ;
 *   pr_ouverte / pr_fusionnee : le suivi des PR de Jules (nettoyage du corps, `hold`, acceptation d'une PR de tests fusionnée) et son étiquette `par-jules` ;
 *   deploiement : une PR de Jules fusionnée n'est acceptée qu'une fois le déploiement de production réussi ;
 *   filet : tout, en rattrapage d'un événement manqué.
 */
export const PAR_EVENEMENT = {
  tache_ouverte: ['perimees', 'completer', 'fichiers', 'acceptation', 'marquer'],
  tache_fermee: ['menage'],
  pr_ouverte: ['suivi', 'parJules'],
  pr_fusionnee: ['suivi', 'parJules'],
  deploiement: ['suivi'],
  filet: ETAPES,
};

/** Les étapes d'un type d'événement (vide pour un type inconnu ou qui n'en a pas). */
export const etapesPour = (type) => PAR_EVENEMENT[type] ?? [];

const court = (e) => String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 80);

/**
 * Lance les étapes d'un événement sur le dépôt de l'événement. Ne lève jamais : une étape qui échoue est dite dans `erreurs`, les autres passent.
 * @param gh (methode, chemin, corps) -> JSON ; par défaut `gh api` du job
 * @returns {{ etapes: string[], lignes: string[], signaux: {ref: string, raison: string}[], erreurs: string[] }}
 */
export function pilotage({ evt, gh = ghCli, maintenant = new Date(), aBlanc = false }) {
  const depot = evt.depot;
  const sortie = { etapes: etapesPour(evt.type), lignes: [], signaux: [], erreurs: [] };
  if (!depot || sortie.etapes.length === 0) return sortie;
  const etat = {}; // un job ne garde rien (voir l'en-tête) : la mémoire du gabarit et le « pas de Jules » ne durent que ce passage
  const budgetFichiers = { restant: ESTIMATIONS_PAR_TOUR };
  const budgetAcceptation = { restant: MARQUAGES_PAR_TOUR };
  const dire = (texte) => sortie.lignes.push(texte);
  const essayer = (nom, f) => {
    try { f(); } catch (e) { sortie.erreurs.push(`${nom} (${court(e)})`); }
  };
  const actions = {
    suivi: () => {
      const r = suivreDepot({ depot, gh, etat, maintenant, aBlanc });
      sortie.signaux.push(...r.signaux);
      if (r.acceptees.length) dire(`jules : ${r.acceptees.length} tâche(s) acceptée(s) (${r.acceptees.join(', ')})`);
      if (r.nettoyees.length) dire(`jules : corps nettoyé sur ${r.nettoyees.join(', ')}`);
      if (r.holds.length) dire(`jules : hold posé sur ${r.holds.join(', ')}`);
    },
    parJules: () => {
      const pr = Number(evt.pr);
      const r = marquerParJules({ depot, gh, aBlanc, etat, maintenant, seulement: evt.type === 'pr_ouverte' && Number.isInteger(pr) && pr > 0 ? pr : null });
      if (r.marquees.length) dire(`jules : PR marquée(s) par-jules (${r.marquees.join(', ')})`);
    },
    menage: () => {
      const r = menageFermees({ depot, gh, aBlanc });
      if (r.length) dire(`ménage : ${r.length} étiquette(s) retirée(s) sur tâches fermées (${r.slice(0, 4).join(', ')})`);
    },
    perimees: () => {
      const r = retirerPerimees({ depot, gh, aBlanc });
      if (r.length) dire(`faisable-jules périmée(s) retirée(s) (${r.join(', ')})`);
    },
    completer: () => {
      const r = completerGabarit({ depot, gh, etat, maintenant, aBlanc });
      if (r.completees.length) dire(`corps complété(s) au gabarit (${r.completees.join(', ')})`);
      if (r.refusees.length) dire(`gabarit refusé : ${r.refusees.slice(0, 3).map((x) => `${x.ref} ${x.raison.slice(0, 70)}`).join(' ; ')}`);
    },
    fichiers: () => {
      const r = estimerFichiers({ depot, gh, budget: budgetFichiers, aBlanc });
      if (r.ecrites.length) dire(`fichiers touchés écrits (${r.ecrites.map((x) => x.ref).slice(0, 6).join(', ')})`);
      if (r.recalculees.length) dire(`fichiers touchés recalculés (${r.recalculees.map((x) => x.ref).slice(0, 4).join(', ')})`);
    },
    acceptation: () => {
      const r = marquerAcceptation({ depot, gh, budget: budgetAcceptation, aBlanc });
      if (r.ecrites.length) dire(`acceptation automatique marquée (${r.ecrites.slice(0, 6).join(', ')})`);
      if (r.retirees.length) dire(`acceptation automatique retirée (${r.retirees.slice(0, 4).join(', ')})`);
    },
    marquer: () => {
      const r = marquerFaisables({ depot, gh, aBlanc });
      if (r.marquees.length) dire(`faisable-jules posé (${r.marquees.join(', ')})`);
    },
  };
  for (const nom of sortie.etapes) essayer(nom, actions[nom]);
  return sortie;
}

/** Les signaux du suivi de Jules, en lignes du motif de réveil (quatre au plus : le texte part dans un champ borné). */
export const lignesDesSignaux = (signaux) => signaux.slice(0, 4).map((x) => `jules : ${x.ref} ${x.raison}`);

/** Le pilotage tel que le Réacteur l'appelle : `pilote({ evt, maintenant })`. Ne lève jamais. */
export const piloteDuJob = ({ gh = ghCli, aBlanc = false } = {}) => async ({ evt, maintenant }) => {
  try {
    return pilotage({ evt, gh, maintenant, aBlanc });
  } catch (e) {
    return { etapes: etapesPour(evt.type), lignes: [], signaux: [], erreurs: [`pilotage (${court(e)})`] };
  }
};
