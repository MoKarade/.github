#!/usr/bin/env node
// Écrire seul la ligne « Acceptation automatique » des tâches dont la preuve se lit par machine (tâche MoKarade/.github#421, demande de Marc relayée
// par le fil « Fusion rapide » le 21/10/2026 : « une tâche dont la preuve est entièrement lisible par une machine s'accepte toute seule »).
// `scripts/acceptation-auto.mjs` n'accepte que les tâches qui portent `**Acceptation automatique** : oui — <pourquoi>` (§10 ter, condition 1) ; or personne
// ne l'écrivait. Le filet du PC l'ajoute donc, À LA FIN du corps et sans toucher au texte existant, quand la règle prudente ci-dessous est vraie.
//
// Règle prudente (au moindre doute, rien) : le « Fini quand » cite un contrôle de machine (test, CI, build, lint, typecheck, déploiement) ET ne cite
// ni réponse HTTP, URL, écran, capture, donnée, production, PC, Drive, page, durée, relevé ni « preuve ensuite » ; « Fichiers touchés » est connu
// (au plus `FICHIERS_MAX`) et sans écran. Ce que la PR touche VRAIMENT (écrans, CI, déploiement) est jugé à la fusion par `acceptation-auto.mjs` :
// cette ligne n'est qu'une autorisation, jamais une preuve.
//
// Une tâche qui porte déjà une ligne « Acceptation automatique » (oui OU non, de n'importe qui) n'est jamais touchée. La ligne posée ici se retire
// d'elle-même quand le CORPS ne la justifie plus (jamais à cause d'une étiquette : une tâche qui vient de livrer passe `preuve-attendue` et
// `acceptation-auto.mjs` la refuse alors de lui-même).
//
// Fonctions pures (`evaluerMarquage`, `composerLigne`) d'un côté ; I/O injecté (`gh`) de l'autre : les tests n'ont besoin ni de réseau ni de fichier.

import { section } from './jules-auto.mjs';
import { fichiersDeclares } from './capacite.mjs';
import { ECRAN, LABELS_ATTENTE } from './acceptation-auto.mjs';

const ORG = 'MoKarade';
export const MARQUEUR = '<!-- acceptation-auto-marquee -->';
export const PAR_TOUR_MAX = 8; // lignes écrites par tour, tous dépôts confondus
export const FICHIERS_MAX = 10;
// Une ligne « Acceptation automatique » existe déjà, quelle que soit sa valeur : la décision de quelqu'un ne se défait pas.
const LIGNE_QUELCONQUE = /^[\s>*_-]*\*{0,2}\s*Acceptation automatique\s*\*{0,2}\s*:/im;
const BLOC = /\n*<!-- acceptation-auto-marquee -->\n\*\*Acceptation automatique\*\*[^\n]*(?:\n|$)/;
// `jules` : Jules a sa propre acceptation (`jules-suivi.mjs`) ; `en-cours` reste permis (la tâche est écrite avant que le fil ne livre).
const ETIQUETTES_QUI_ECARTENT = [...LABELS_ATTENTE, 'jules'];

// Ce qui se prouve par une machine.
const MACHINE = /\b(?:tests?|node\s+--test|npm\s+(?:run\s+)?\w+|unittest|pytest|vitest|CI|verte?s?|build|lint|typecheck|déploiement)\b/i;
// Ce qui ne s'y prouve pas : on le lit sur une page, on le mesure dans le temps ou on le constate chez Marc.
const HORS_MACHINE = [
  [/https?:\/\/|\bHTTP\b|\bURL\b/i, 'réponse HTTP ou URL'],
  [/écrans?\b|captures?\b|screenshots?|navigateur|affich|visibles?\b|\brendu\b/i, 'écran'],
  [/données?\b|donnees?\b/i, 'donnée'],
  [/production|\bprod\b/i, 'production'],
  [/\bPC\b|\bDrive\b|\bpages?\b|relev[ée]s?\b|prochaines\.json|fiabilit|quota|\bcron\b|mesur/i, 'PC, Drive, page ou mesure'],
  [/preuve\s+(?:ensuite|attendue)|preuve\s*:/i, 'preuve ensuite'],
  [/\b\d+\s?(?:h|min|jours?|semaines?|heures?)\b/i, 'durée'],
];
// Un « Avant » ou « Après » qui parle d'écran suffit à exclure, même si le « Fini quand » est un test.
const ECRAN_AILLEURS = /écrans?\b|affich|visibles?\b|navigateur|capture/i;

const noms = (labels) => (labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));

/** La tâche porte-t-elle déjà une ligne « Acceptation automatique » (oui ou non) ? */
export const aUneLigne = (corps) => LIGNE_QUELCONQUE.test(String(corps ?? '').replace(BLOC, ''));

/** La ligne posée par ce script est-elle dans le corps ? */
export const estMarquee = (corps) => BLOC.test(String(corps ?? ''));

/** Le corps sans la ligne posée par ce script. */
export const sansLigne = (corps) => String(corps ?? '').replace(BLOC, '').replace(/\s+$/, '');

/**
 * Le corps justifie-t-il la ligne ? Rend { ok, raison } : `raison` dit ce qui manque (ou le motif d'exclusion), jamais vide quand `ok` est faux.
 * Ne lit PAS les étiquettes : voir `completerDepot`.
 */
export function evaluerMarquage({ titre = '', corps = '' }) {
  const c = sansLigne(corps);
  const fini = section(c, 'Fini quand');
  if (!fini) return { ok: false, raison: 'pas de « Fini quand »' };
  if (!MACHINE.test(fini)) return { ok: false, raison: '« Fini quand » ne cite aucun contrôle de machine' };
  for (const [motif, nom] of HORS_MACHINE) if (motif.test(fini)) return { ok: false, raison: `« Fini quand » cite ${nom}` };
  for (const t of ['Avant', 'Après']) if (ECRAN_AILLEURS.test(section(c, t) ?? '')) return { ok: false, raison: `« ${t} » parle d'un écran` };
  if (ECRAN_AILLEURS.test(titre)) return { ok: false, raison: 'le titre parle d\'un écran' };
  const fichiers = fichiersDeclares(c);
  if (!fichiers) return { ok: false, raison: 'fichiers touchés inconnus' };
  if (fichiers.length > FICHIERS_MAX) return { ok: false, raison: `plus de ${FICHIERS_MAX} fichiers` };
  const ecran = fichiers.find((f) => ECRAN.test(f));
  if (ecran) return { ok: false, raison: `écran touché (${ecran})` };
  return { ok: true, raison: '' };
}

/** La ligne à ajouter : elle passe `LIGNE_AUTO` de acceptation-auto.mjs et dit qui l'a écrite et pourquoi. */
export const composerLigne = () =>
  `${MARQUEUR}\n**Acceptation automatique** : oui — posée par le Réacteur (§10 ter) : le « Fini quand » se lit par un test ou la CI, sans écran, sans donnée ni production à constater, et les fichiers touchés sont connus. La PR doit encore passer les sept conditions à la fusion ; le fil qui prend la tâche peut la retirer ou la remplacer par « non ».\n`;

/**
 * Complète, dans un dépôt, les tâches ouvertes `niveau:tâche` éligibles, par priorité puis numéro, dans la limite de `budget.restant` (partagé entre
 * les dépôts d'un tour). Retire d'abord (sans budget) la ligne posée ici dont le corps ne tient plus. Le corps est relu juste avant l'écriture : s'il a
 * bougé entre-temps, la tâche attend le tour suivant.
 * @returns {{ ecrites: string[], retirees: string[] }}
 */
export function completerDepot({ depot, gh, budget = { restant: PAR_TOUR_MAX }, aBlanc = false }) {
  const court = depot.replace(`${ORG}/`, '');
  const sortie = { ecrites: [], retirees: [] };
  const prio = (t) => Number(/prio:(\d)/.exec(noms(t.labels).find((l) => /^prio:\d$/.test(l)) ?? '')?.[1] ?? 9);
  const ouvertes = gh('GET', `repos/${depot}/issues?state=open&per_page=100`)
    .filter((i) => !i.pull_request && noms(i.labels).includes('niveau:tâche'))
    .sort((a, b) => prio(a) - prio(b) || a.number - b.number);
  const reecrire = (t, garde, calculer) => {
    if (aBlanc) return true;
    const frais = gh('GET', `repos/${depot}/issues/${t.number}`);
    if (frais.updated_at !== t.updated_at || !garde(frais)) return false;
    gh('PATCH', `repos/${depot}/issues/${t.number}`, { body: calculer(frais.body) });
    return true;
  };
  // 1. La ligne posée ici que le corps ne justifie plus.
  for (const t of ouvertes.filter((i) => estMarquee(i.body))) {
    if (evaluerMarquage({ titre: t.title, corps: t.body }).ok) continue;
    if (reecrire(t, (f) => estMarquee(f.body) && !evaluerMarquage({ titre: f.title, corps: f.body }).ok, (c) => sansLigne(c) + '\n')) sortie.retirees.push(`${court}#${t.number}`);
  }
  // 2. Les tâches éligibles sans ligne, dans la limite du budget.
  const candidates = ouvertes.filter((i) => !aUneLigne(i.body) && !ETIQUETTES_QUI_ECARTENT.some((x) => noms(i.labels).includes(x)));
  for (const t of candidates) {
    if (budget.restant <= 0) break;
    if (!evaluerMarquage({ titre: t.title, corps: t.body }).ok) continue;
    const ecrit = reecrire(
      t,
      (f) => !aUneLigne(f.body) && !ETIQUETTES_QUI_ECARTENT.some((x) => noms(f.labels).includes(x)) && evaluerMarquage({ titre: f.title, corps: f.body }).ok,
      (c) => `${String(c ?? '').replace(/\s+$/, '')}\n\n${composerLigne()}`,
    );
    if (!ecrit) continue;
    budget.restant -= 1;
    sortie.ecrites.push(`${court}#${t.number}`);
  }
  return sortie;
}
