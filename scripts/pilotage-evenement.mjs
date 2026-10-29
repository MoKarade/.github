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
//   - les appels GitHub passent par `ghSynchrone` (un `node` enfant qui fait le `fetch`, jeton `github.token`, issues et pull-requests en écriture) : aucun nouveau secret, et
//     surtout aucune CLI `gh` à trouver dans le PATH (le robot du PC, qui sert les dépôts privés, n'en a pas : DriveAI#798, 29/10/2026) ;
//   - un échec d'une étape est DIT (`erreurs`), les autres étapes passent ; le Réacteur le rend visible (avertissement, puis échec du run, donc
//     une issue `boucle:erreur` par `signaler-echec.yml`) : rien ne se perd en silence.
// Fonctions pures d'un côté (`etapesPour`, `lignesDe`), I/O de l'autre (`gh` injecté).
import { spawnSync } from 'node:child_process';
import { suivreDepot, menageFermees, marquerParJules } from './jules-suivi.mjs';
import { marquerFaisables, retirerPerimees } from './jules-marquage.mjs';
import { completerDepot as completerGabarit } from './jules-gabarit.mjs';
import { completerDepot as marquerAcceptation, PAR_TOUR_MAX as MARQUAGES_PAR_TOUR } from './acceptation-marquage.mjs';
import { libererPlacesImmobiles } from './place-immobile.mjs';

/** Les étapes, dans l'ordre où le tour du PC les faisait : une étiquette périmée libère la tâche avant qu'on la complète, la complétion précède la réservation. */
export const ETAPES = ['suivi', 'parJules', 'menage', 'perimees', 'completer', 'acceptation', 'marquer', 'immobiles'];

/**
 * Quelle étape pour quel événement du Réacteur.
 *   tache_ouverte (issue qui s'ouvre, change ou change d'étiquette) : tout ce qui prépare une tâche pour Jules ou pour un fil ;
 *   tache_fermee : les étiquettes de travail d'une tâche fermée ;
 *   pr_ouverte / pr_fusionnee : le suivi des PR de Jules (nettoyage du corps, `hold`, acceptation d'une PR de tests fusionnée) et son étiquette `par-jules` ;
 *   deploiement : une PR de Jules fusionnée n'est acceptée qu'une fois le déploiement de production réussi ;
 *   `immobiles` (tâche #868) : une tâche `en-cours` sans PR depuis 3 h est signalée, puis libérée une heure après (scripts/place-immobile.mjs) ; elle part avec les
 *   événements qui libèrent ou prennent une place (tâche ouverte ou fermée, PR fusionnée) ;
 *   filet : tout, en rattrapage d'un événement manqué.
 */
export const PAR_EVENEMENT = {
  tache_ouverte: ['perimees', 'completer', 'acceptation', 'marquer', 'immobiles'],
  tache_fermee: ['menage', 'immobiles'],
  pr_ouverte: ['suivi', 'parJules'],
  pr_fusionnee: ['suivi', 'parJules', 'immobiles'],
  deploiement: ['suivi'],
  filet: ETAPES,
};

/** Les étapes d'un type d'événement (vide pour un type inconnu ou qui n'en a pas). */
export const etapesPour = (type) => PAR_EVENEMENT[type] ?? [];

const court = (e) => String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 80);

const SCRIPT_ENFANT = `
const { methode, chemin, corps, base } = JSON.parse(process.env.PILOTAGE_REQUETE);
const reponse = await fetch(base + '/' + chemin.replace(/^\\//, ''), {
  method: methode,
  headers: {
    authorization: 'Bearer ' + process.env.PILOTAGE_JETON,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'content-type': 'application/json',
    'user-agent': 'pilotage-evenement',
  },
  body: corps ? JSON.stringify(corps) : undefined,
});
process.stdout.write(JSON.stringify({ statut: reponse.status, texte: await reponse.text() }));
`;

/** Le corps d'un appel `gh api -F k=v` : une clé en `[]` est une liste (`labels[]`), les autres gardent leur valeur. */
export function corpsJson(corps) {
  if (!corps) return undefined;
  const sortie = {};
  for (const [k, v] of Object.entries(corps)) {
    if (k.endsWith('[]')) (sortie[k.slice(0, -2)] ??= []).push(v);
    else sortie[k] = v;
  }
  return sortie;
}

/**
 * `gh(methode, chemin, corps) -> JSON` synchrone, SANS la CLI `gh` : un `node` enfant (celui qui nous fait tourner) fait la requête. Même contrat que `ghCli` : chemin sans
 * barre initiale, `{}` quand la réponse est vide, une exception portant le statut HTTP (« 404 Not Found ») quand GitHub refuse.
 * @param lancer  `spawnSync` (injectable pour les tests) ; @param base  l'URL de l'API (injectable pour les tests)
 */
export function ghSynchrone({ jeton = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '', lancer = spawnSync, base = 'https://api.github.com' } = {}) {
  return (methode, chemin, corps) => {
    const r = lancer(process.execPath, ['--input-type=module', '-e', SCRIPT_ENFANT], {
      encoding: 'utf8',
      env: { ...process.env, PILOTAGE_JETON: jeton, PILOTAGE_REQUETE: JSON.stringify({ methode, chemin, corps: corpsJson(corps), base }) },
      timeout: 60_000,
    });
    if (r.error) throw new Error(`${methode} ${chemin} : ${court(r.error)}`);
    let reponse;
    try { reponse = JSON.parse(r.stdout); } catch { throw new Error(`${methode} ${chemin} : réponse illisible (${court(r.stderr || r.stdout)})`); }
    if (reponse.statut >= 200 && reponse.statut < 300) return reponse.texte.trim() ? JSON.parse(reponse.texte) : {};
    const motif = `HTTP ${reponse.statut}${reponse.statut === 404 ? ' Not Found' : ''} sur ${methode} ${chemin}`;
    throw Object.assign(new Error(motif), { stderr: motif });
  };
}

/**
 * Lance les étapes d'un événement sur le dépôt de l'événement. Ne lève jamais : une étape qui échoue est dite dans `erreurs`, les autres passent.
 * @param gh (methode, chemin, corps) -> JSON ; par défaut `ghSynchrone()` (pas de CLI `gh`)
 * @returns {{ etapes: string[], lignes: string[], signaux: {ref: string, raison: string}[], erreurs: string[] }}
 */
export function pilotage({ evt, gh = ghSynchrone(), maintenant = new Date(), aBlanc = false }) {
  const depot = evt.depot;
  const sortie = { etapes: etapesPour(evt.type), lignes: [], signaux: [], erreurs: [] };
  if (!depot || sortie.etapes.length === 0) return sortie;
  const etat = {}; // un job ne garde rien (voir l'en-tête) : la mémoire du gabarit et le « pas de Jules » ne durent que ce passage
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
    acceptation: () => {
      const r = marquerAcceptation({ depot, gh, budget: budgetAcceptation, aBlanc });
      if (r.ecrites.length) dire(`acceptation automatique marquée (${r.ecrites.slice(0, 6).join(', ')})`);
      if (r.retirees.length) dire(`acceptation automatique retirée (${r.retirees.slice(0, 4).join(', ')})`);
    },
    marquer: () => {
      const r = marquerFaisables({ depot, gh, aBlanc });
      if (r.marquees.length) dire(`faisable-jules posé (${r.marquees.join(', ')})`);
    },
    immobiles: () => {
      const r = libererPlacesImmobiles({ depot, gh, maintenant, aBlanc });
      for (const ref of r.signalees) sortie.signaux.push({ nature: 'place', ref, raison: 'en-cours sans PR depuis plus de 3 h, signalée' });
      if (r.liberees.length) dire(`places immobiles libérées (${r.liberees.slice(0, 4).join(', ')})`);
      if (r.illisibles.length) sortie.erreurs.push(`immobiles (lecture impossible : ${r.illisibles.slice(0, 3).join(', ')})`);
    },
  };
  for (const nom of sortie.etapes) essayer(nom, actions[nom]);
  return sortie;
}

/** Les signaux du suivi de Jules, en lignes du motif de réveil (quatre au plus : le texte part dans un champ borné). */
export const lignesDesSignaux = (signaux) => signaux.slice(0, 4).map((x) => `${x.nature === 'place' ? 'place immobile' : 'jules'} : ${x.ref} ${x.raison}`);

/** Le pilotage tel que le Réacteur l'appelle : `pilote({ evt, maintenant })`. Ne lève jamais. */
export const piloteDuJob = ({ gh = ghSynchrone(), aBlanc = false } = {}) => async ({ evt, maintenant }) => {
  try {
    return pilotage({ evt, gh, maintenant, aBlanc });
  } catch (e) {
    return { etapes: etapesPour(evt.type), lignes: [], signaux: [], erreurs: [`pilotage (${court(e)})`] };
  }
};
