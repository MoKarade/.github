#!/usr/bin/env node
// Réacteur : ce qui se fait SANS IA à un événement GitHub (docs/cycle-de-vie-tache.md §6, mission MoKarade/.github#116).
//
// Nettoyage du 29/10/2026 (« go reco » de Marc) : le Réacteur ne réveille plus le Coordinateur ni les fils d'app, et ne réveille plus les dépôts dont une tâche en attendait
// une autre. Chaque tâche prête part dans une session neuve (routine « Prendre une tâche »). Ce qui reste :
//   - pr_fusionnee, tache_fermee, tache_ouverte, deploiement, preuve_page (acceptée) : l'acceptation automatique de la tâche (scripts/acceptation-auto.mjs, §10 ter),
//     puis, si le dépôt a une tâche suivante prenable, le LANCEMENT de la routine pour elle (`lancerRoutine`, scripts/routine-prendre.mjs, action « lancer »). Le message d'une décision (« D libre ; suivante : #n ; PR #x fusionnée ») n'est plus posté nulle part : il va au journal ;
//   - ci_rouge : un échec de charge du robot (job mort sans étape en échec) est relancé UNE fois ; le reste lance seulement les balayages de `.github` ;
//   - pr_ouverte, garde_fou_rouge : seulement les balayages de `.github` (tâche liée, relecture IA) ;
//   - filet : les preuves différées dues ;
//   - commentaire, fin_de_cron : les preuves différées dues (`preuve-attendue-auto.mjs`, §10 quater) ;
//   - le pilotage de l'événement (tâches, place immobile : `pilotage-evenement.mjs`) : ses signaux réveillent encore le Coordinateur (boîte app-template#58).
// Sur une PR fusionnée, une CI rouge ou une tâche fermée, il lance aussi `commentaire-tache-liee.yml` et `relecture-ia.yml` de `.github` (tâche #148) ; sur la fin en échec du
// Garde-fou d'une PR, `relecture-ia.yml` seule (#633) ; à l'ouverture d'une PR, `commentaire-tache-liee.yml` seule (#157).
//
// « D libre » n'est dit que si D est VRAIMENT libre (`travaux`). Jamais de nom de tâche suivante dans le message (règle MoKarade/.github#136) : des identifiants seulement.
// Les corps de PR et d'issues sont des données : seuls des numéros en sortent.
//
// Fonctions pures d'un côté (`estPanneRunner`, `construireMotif`), I/O de l'autre (`traiter`, avec `api` injecté : les tests n'ont besoin ni de réseau ni de jeton).
// Ne fait jamais échouer le job pour un réveil manqué (un avertissement dit ce qui n'a pas marché).
import { pathToFileURL } from 'node:url';
import { prAttendantMarc } from './attend-marc.mjs';
import { dispense, extraireTachesCompletes } from './tache-liee.mjs';
import { PLACES_PAR_DEPOT } from './capacite.mjs';
import { accepterApresFusion } from './acceptation-auto.mjs';
import { accepterPreuvesAttendues, LUES_EVENEMENT, LUES_FILET } from './preuve-attendue-auto.mjs';
import { fileDuDepot } from './file-depot.mjs';
import { ghSynchrone, lignesDesSignaux, piloteDuJob } from './pilotage-evenement.mjs';
import { lancerRoutine } from './routine-prendre.mjs';

export const DEPOT_BOITE = 'MoKarade/app-template';
export const WORKFLOW_BOITE = 'boite-reacteur.yml';
export const PREFIXE = 'RÉACTEUR : ';
export const LABEL_TACHE = 'niveau:tâche';
export const LONGUEUR_MAX = 600;
const ROBOTS = new Set(['dependabot[bot]', 'mergify[bot]', 'github-actions[bot]']);
// Le signal du pilotage ne repose pas un motif identique déjà posté sur la boîte depuis cette durée (deux passages à quelques minutes d'écart).
export const FENETRE_FILET_H = 6;
// Boîte du Coordinateur : PR brouillon permanente d'app-template (la #58) ; un commentaire du robot réveille le Coordinateur.
export const NUMERO_BOITE = 58;

export const DEPOT_GITHUB = 'MoKarade/.github';
// Les deux balayages de `.github` qu'une planification GitHub ne lance presque jamais (MoKarade/.github#148) : sans entrée,
// chacun relit toutes les PR ouvertes. Lancés après le réveil, sur les seuls événements d'une PR ou d'une tâche.
export const WORKFLOWS_BALAYAGE = ['commentaire-tache-liee.yml', 'relecture-ia.yml'];
export const TYPES_BALAYAGE = new Set(['pr_fusionnee', 'ci_rouge', 'tache_fermee']);
// Une PR qui s'ouvre ne lance que le commentaire tâche liée (et la marque `en-cours`) : la relecture IA a son propre déclencheur.
export const WORKFLOWS_PR_OUVERTE = ['commentaire-tache-liee.yml'];
// Le Garde-fou d'une PR vient de finir en échec (`workflow_run`, MoKarade/.github#633) : la relecture IA est la seule à lancer, sans minuteur
// (#626). Elle ne relit que les PR dont le Garde-fou est rouge sur leur dernier commit et qui n'ont pas déjà de verdict.
export const WORKFLOWS_GARDE_FOU_ROUGE = ['relecture-ia.yml'];
// Ce qui occupe un dépôt (une chose à la fois par app, docs/cycle-de-vie-tache.md) : une issue ouverte portant l'une de ces
// étiquettes, ou une PR ouverte (brouillon compris) qui n'est pas celle d'un robot. `preuve-attendue` ne l'occupe pas, ni `jules` : une tâche
// confiée à Jules (et sa PR) ne tient pas de place (décision de Marc, 23/10/2026 22:45Z : « il prend quand même »).
export const LABELS_OCCUPE = ['en-cours'];
const LABEL_JULES = 'jules';

/**
 * Un échec de charge du robot de tests (timeout, runner perdu) : tous les jobs en échec sont morts sans qu'AUCUNE
 * étape ne soit en échec. Un seul job avec une vraie étape rouge, et c'est un vrai échec.
 */
export function estPanneRunner(jobs) {
  const rouges = jobs.filter((j) => j.conclusion === 'failure' || j.conclusion === 'timed_out');
  if (rouges.length === 0) return false;
  return rouges.every((j) => j.conclusion === 'timed_out' || !(j.steps ?? []).some((s) => s.conclusion === 'failure'));
}

/** Ajoute le préfixe, borne la longueur : le texte part dans un champ de workflow, jamais plus de 600 caractères. */
export function construireMotif(lignes) {
  return `${PREFIXE}${lignes.filter(Boolean).join(' ; ')}`.slice(0, LONGUEUR_MAX);
}

/** Les lignes de signaux du pilotage ne sont lues qu'ici ; `dejaSignale` : ce motif exact est-il déjà sur la boîte du Coordinateur, posté par le robot dans les `FENETRE_FILET_H` dernières heures ?
 * Une lecture qui échoue ne cache rien : on rend faux (un réveil en double coûte moins qu'un signal qu'on ne dit pas). */
async function dejaSignale({ api, motif, maintenant }) {
  const limite = maintenant.getTime() - FENETRE_FILET_H * 3_600_000;
  try {
    const depuis = encodeURIComponent(new Date(limite).toISOString());
    const commentaires = await commentairesDe(api, DEPOT_BOITE, NUMERO_BOITE, depuis);
    return commentaires.some((c) => c.body === motif && c.user?.login === 'github-actions[bot]' && Date.parse(c.created_at ?? '') >= limite);
  } catch {
    return false;
  }
}

/** Le filet : plus aucun signal pour le Coordinateur ; il ne reste que les preuves différées dues (`decider`). */
async function filet({ api, evt, maintenant }) {
  return { action: 'rien', raison: 'filet : preuves différées seulement' };
}
async function commentairesDe(api, depot, numero, depuis = '') {
  const sortie = [];
  const filtre = depuis ? `&since=${depuis}` : '';
  for (let page = 1; page <= 5; page += 1) {
    const lot = (await api('GET', `/repos/${depot}/issues/${numero}/comments?per_page=100${filtre}&page=${page}`)) ?? [];
    sortie.push(...lot);
    if (lot.length < 100) break;
  }
  return sortie;
}

/**
 * Ce qui occupe encore le dépôt : ["#12", "PR #30"…], vide = libre. `tachesExclues` : numéros de tâches du dépôt que la PR
 * qui vient de fusionner citait ; leur étiquette `en-cours` n'est remplacée par `preuve-attendue` qu'après la fusion, elles
 * ne comptent donc pas, sauf si une autre PR ouverte les cite encore. Même règle pour une PR qui n'attend plus qu'un geste
 * de Marc (`prAttendantMarc`, tâche #216, comme `prochaine-tache.mjs`) : elle et ses tâches n'occupent pas le dépôt. Une
 * lecture qui échoue ne cache rien : on rend vide (libre), car un réveil de trop coûte moins qu'un dépôt libre qu'on ne signale pas.
 */
export async function occupations({ api, depot, tachesExclues = [] }) {
  const { prises, prs } = await lireOccupations({ api, depot, tachesExclues });
  return [...[...prises].map((n) => `#${n}`), ...prs.map((pr) => `PR #${pr.number}`)];
}

/**
 * Le nombre de TRAVAUX du dépôt (deux places par dépôt, décision de Marc du 21/10/2026) : une tâche `en-cours` et sa PR ouverte
 * comptent pour un, une PR qui ne cite aucune tâche occupée compte pour un. Même lecture que `occupations`, même repli (lecture ratée : 0).
 */
export async function travaux({ api, depot, tachesExclues = [] }) {
  const { prises, prs, tachesDe } = await lireOccupations({ api, depot, tachesExclues });
  return prises.size + prs.filter((pr) => !tachesDe([pr]).some((n) => prises.has(n))).length;
}

async function lireOccupations({ api, depot, tachesExclues }) {
  try {
    const ouvertes = ((await api('GET', `/repos/${depot}/pulls?state=open&per_page=30`)) ?? []).filter((pr) => !dispense(pr));
    const attendMarc = new Set(prAttendantMarc((await api('GET', `/repos/${depot}/issues?labels=qui:marc&state=open&per_page=100`)) ?? []));
    const tachesDe = (prs) => prs.flatMap((pr) => extraireTachesCompletes(pr.body, depot).filter((t) => t.depot === depot).map((t) => t.numero));
    const prs = ouvertes.filter((pr) => !attendMarc.has(pr.number));
    const encore = new Set(tachesDe(prs));
    const exclues = new Set([...tachesExclues, ...tachesDe(ouvertes.filter((pr) => attendMarc.has(pr.number)))].filter((n) => !encore.has(n)));
    const prises = new Set();
    for (const label of LABELS_OCCUPE) {
      const lot = (await api('GET', `/repos/${depot}/issues?labels=${label}&state=open&per_page=30`)) ?? [];
      for (const i of lot) if (!i.pull_request && !exclues.has(i.number)) prises.add(i.number);
    }
    // Les tâches de Jules ne tiennent pas de place, ni leur PR (qui ne cite aucune tâche `en-cours` : elle ne compterait pas non plus comme « PR seule »).
    const jules = new Set();
    const lotJules = (await api('GET', `/repos/${depot}/issues?labels=${LABEL_JULES}&state=open&per_page=30`)) ?? [];
    for (const i of lotJules) if (!i.pull_request) jules.add(i.number);
    const prsDeJules = (pr) => tachesDe([pr]).some((n) => jules.has(n)) && !tachesDe([pr]).some((n) => prises.has(n));
    return { prises, prs: prs.filter((pr) => !prsDeJules(pr)), tachesDe };
  } catch {
    return { prises: new Set(), prs: [], tachesDe: () => [] };
  }
}

/**
 * La tâche suivante du dépôt à cet instant (scripts/file-depot.mjs, lue avec le jeton du job, jamais sur le tour du PC) : { ligne, file }.
 * `ligne` : « suivante : #n », le NUMÉRO seulement (règle MoKarade/.github#136) ; vide si le dépôt n'a rien de prenable, est en incident ou n'a pas pu être lu
 * (une lecture qui échoue ne devine rien : le réveil part sans suivante, le Coordinateur lit le Gantt comme avant).
 */
async function suivanteDe({ api, depot, maintenant, exclure = [] }) {
  const file = await fileDuDepot({ api, depot, maintenant, exclure, libereA: maintenant.toISOString() }).catch(() => null);
  return file?.suivante ? { ligne: `suivante : #${file.suivante}`, file, brut: file } : { ligne: '', file: null, brut: file };
}

/** « D libre » sans travail, « D : une place libre » avec un seul ; rien quand les deux places sont prises. */
export function signeLibre(depot, travauxEnCours) {
  if (travauxEnCours <= 0) return `${depot} libre`;
  if (travauxEnCours < PLACES_PAR_DEPOT) return `${depot} : une place libre`;
  return '';
}

// Les événements qui passent par le Réacteur et pendant lesquels une preuve différée DUE peut se lire (tâche MoKarade/.github#700, §10 quater) :
// aucun minuteur en plus. Les autres (CI rouge, ouverture de PR…) n'y touchent pas.
export const TYPES_PREUVE_DIFFEREE = new Set(['pr_fusionnee', 'tache_fermee', 'filet', 'deploiement', 'commentaire', 'fin_de_cron']);
// Les événements ajoutés pour que RIEN n'attende un minuteur (tâche MoKarade/.github#712) : ils ne réveillent que si quelque chose vient d'être
// accepté ou si une tâche vient de devenir prenable ; sinon rien, et surtout pas de message de plus sur la boîte.
export const TYPES_EVENEMENT_NOUVEAU = new Set(['tache_ouverte', 'deploiement', 'commentaire', 'fin_de_cron']);
// Un identifiant venu d'un `repository_dispatch` (note LIA, cron d'app) : lettres, chiffres, point, tiret, souligné ; sinon rien n'en sort.
export const signalSur = (v) => (/^[0-9A-Za-z._-]{1,40}$/.test(String(v ?? '')) ? String(v) : '');

/**
 * Contrôle si l'alias Vercel de l'app est figé sur un ancien commit après un déploiement READY.
 * Effectue deux lectures de /api/sante à ~30 s d'intervalle si le commit ne correspond pas au premier essai.
 */
export async function verifierAliasVercel({
  api,
  depot,
  sha,
  apps,
  fetchImpl = globalThis.fetch,
  pause = (ms) => new Promise((r) => setTimeout(r, ms)),
  journal = console.log,
}) {
  const commitDeploye = String(sha ?? '').slice(0, 7);
  if (!commitDeploye) return { statut: 'non_couvert', raison: 'sha absent' };

  let listeApps = apps;
  if (!listeApps) {
    try {
      const res = await api('GET', '/repos/MoKarade/.github/contents/surveillance/apps.json').catch(() => null);
      if (res?.content) {
        listeApps = JSON.parse(Buffer.from(res.content, 'base64').toString('utf8'));
      }
    } catch (e) {
      journal(`::warning::Réacteur : impossible de lire surveillance/apps.json via API (${e.message}).`);
      return { statut: 'non_couvert', raison: 'apps.json introuvable' };
    }
  }

  const app = (listeApps ?? []).find((a) => a.depot === depot);
  if (!app || !app.sante) {
    const raison = app ? app.raison || 'URL de santé absente' : 'dépôt non couvert dans surveillance/apps.json';
    journal(`Réacteur : contrôle d'alias non couvert pour ${depot} (${raison}).`);
    return { statut: 'non_couvert', raison };
  }

  const lireSante = async () => {
    const res = await fetchImpl(app.sante, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const texte = await res.text();
    let data;
    try {
      data = JSON.parse(texte);
    } catch {
      throw new Error('JSON invalide');
    }
    return data;
  };

  let data1 = null;
  try {
    data1 = await lireSante();
  } catch {
    // Premier échec silencieux, retentative après pause.
  }

  if (data1 && typeof data1 === 'object' && data1.commit) {
    const commit1 = String(data1.commit).slice(0, 7);
    if (commit1 === commitDeploye) {
      return { statut: 'valide', commitServi: commit1, commitDeploye };
    }
  }

  // Si la première lecture ne correspond pas, attendre 30 s pour laisser l'alias Vercel se poser.
  await pause(30000);

  let data2 = null;
  let err2 = null;
  try {
    data2 = await lireSante();
  } catch (e) {
    err2 = e.message;
  }

  if (err2) {
    const msg = `domaine injoignable ou corps invalide (${err2})`;
    journal(`::warning::Réacteur : contrôle d'alias pour ${depot} : ${msg}.`);
    return { statut: 'erreur', raison: msg };
  }

  if (!data2 || typeof data2 !== 'object' || !data2.commit) {
    const msg = 'champ commit absent dans /api/sante';
    journal(`Réacteur : contrôle d'alias non couvert pour ${depot} (${msg}).`);
    return { statut: 'non_couvert', raison: msg };
  }

  const commitServi = String(data2.commit).slice(0, 7);
  if (commitServi === commitDeploye) {
    return { statut: 'valide', commitServi, commitDeploye };
  }

  // Deux déploiements qui se suivent : l'événement du premier arrive quand le second sert déjà. Un commit servi PLUS RÉCENT (descendant du sha déployé) n'est pas
  // un alias figé (tâche MoKarade/.github#864) ; le doute (introuvable, `behind`, `diverged`, API en échec) reste « figé », comme avant.
  if (typeof api === 'function') {
    const relation = await api('GET', `/repos/${depot}/compare/${sha}...${commitServi}`).then((r) => r?.status ?? null).catch(() => null);
    if (relation === 'ahead') {
      journal(`Réacteur : contrôle d'alias pour ${depot} : le domaine sert ${commitServi}, plus récent que le déploiement ${commitDeploye} ; pas un alias figé.`);
      return { statut: 'valide', commitServi, commitDeploye, plusRecent: true };
    }
  }
  journal(`::warning::Réacteur : alias figé pour ${depot} (servi: ${commitServi}, déployé: ${commitDeploye}).`);
  return { statut: 'fige', commitServi, commitDeploye };
}

/**
 * Décide quoi faire d'un événement, puis lit les preuves différées dues du dépôt (scripts/preuve-attendue-auto.mjs). Le résultat ne change pas
 * quand rien n'est accepté ni refusé par erreur : la clé `differees` n'apparaît que s'il y a quelque chose à dire.
 */
export async function decider({ api, evt, maintenant = new Date(), accepter = accepterApresFusion, accepterDifferees = accepterPreuvesAttendues, jetonLecture = '', pause, fetchImpl, journal, apps }) {
  const d = await deciderEvenement({ api, evt, maintenant, accepter, pause, fetchImpl, journal, apps });
  if (!TYPES_PREUVE_DIFFEREE.has(evt.type)) return d;
  const config = { deploiement: evt.deploiement === 'aucun' ? 'aucun' : 'vercel', workflows: String(evt.workflows ?? '').split(',').map((x) => x.trim()).filter(Boolean) };
  const differees = await accepterDifferees({ api, depot: evt.depot, maintenant, config, jeton: jetonLecture, lues: evt.type === 'filet' ? LUES_FILET : LUES_EVENEMENT }).catch((e) => ({ acceptees: [], ignorees: [], erreur: e.message }));
  if (differees.acceptees.length > 0 && d.action === 'rien' && TYPES_EVENEMENT_NOUVEAU.has(evt.type)) {
    // Une acceptation faite par un événement qui ne lançait rien libère une place (la fermeture par le jeton du job ne lance aucun autre workflow) : la routine part ici pour la suivante.
    const apres = await suiteApresAcceptation({ api, depot: evt.depot, maintenant, taches: differees.acceptees });
    return apres ? { ...d, ...apres, differees } : { ...d, differees };
  }
  return differees.acceptees.length > 0 || differees.erreur ? { ...d, differees } : d;
}

/**
 * La suite d'une tâche que le Réacteur vient d'accepter seul hors d'une PR fusionnée (déploiement READY, preuve différée due, preuve de page lue) : « D libre ; suivante : #n ;
 * tâche D#n acceptée seule », la routine part pour la suivante. Rend null si rien à dire.
 */
async function suiteApresAcceptation({ api, depot, maintenant, taches }) {
  const en = await travaux({ api, depot });
  const suite = await suivanteDe({ api, depot, maintenant });
  if (en >= PLACES_PAR_DEPOT) return null;
  const lignes = taches.map((n) => `tâche ${depot}#${n} acceptée seule`);
  return { action: 'lancer', motif: construireMotif([signeLibre(depot, en), suite.ligne, ...lignes]), ...(suite.file ? { file: suite.file } : {}) };
}

/**
 * Décide quoi faire d'un événement. Rend { action: 'lancer', motif, file? } (acceptation faite, routine à lancer pour `file.suivante`, balayages) | { action: 'reveiller', motif, cibles }
 * (la boîte du Coordinateur à commenter, pour les signaux du pilotage imposés par `traiter`) | { action: 'relance', run } | { action: 'balayer' } | { action: 'rien', raison }.
 * `evt` : { type, depot, pr, issue, raison, evenement, sha, run, brancheRun, brancheDefaut, forcer }.
 */
async function deciderEvenement({ api, evt, maintenant, accepter, pause, fetchImpl, journal, apps }) {
  const { type, depot } = evt;
  if (type === 'filet') return filet({ api, evt, maintenant });
  if (type === 'pr_ouverte') return { action: 'balayer' };
  if (type === 'garde_fou_rouge') return { action: 'balayer', workflows: WORKFLOWS_GARDE_FOU_ROUGE };
  // Une tâche s'ouvre, change ou perd une étiquette : si elle devient LA suivante d'un dépôt qui a une place, la routine part pour elle tout de suite (tâche #712).
  if (type === 'tache_ouverte') {
    const n = Number(evt.issue);
    const issue = await api('GET', `/repos/${depot}/issues/${n}`);
    const noms = (issue?.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
    if (!issue || issue.state !== 'open' || !noms.includes(LABEL_TACHE)) return { action: 'rien', raison: 'pas une tâche ouverte' };
    const en = await travaux({ api, depot });
    const suite = await suivanteDe({ api, depot, maintenant });
    if (en >= PLACES_PAR_DEPOT) return { action: 'rien', raison: 'dépôt encore occupé' };
    if (suite.brut?.suivante !== n) return { action: 'rien', raison: 'cette tâche n’est pas la suivante' };
    // Une modification de plus du même corps ne relance pas la routine : son marqueur (routine-prendre.mjs) tient six heures.
    return { action: 'lancer', motif: construireMotif([signeLibre(depot, en), suite.ligne, `tâche ${depot}#${n} prête`]), file: suite.file };
  }
  // Un déploiement de production réussi : la tâche de la PR fusionnée sur ce commit s'accepte seule si sa règle le permet (la PR a pu fusionner avant la fin du déploiement).
  if (type === 'deploiement') {
    const alias = await verifierAliasVercel({ api, depot, sha: evt.sha, pause, fetchImpl, journal, apps });
    if (alias.statut === 'fige') {
      // L'incident reste ouvert (il coupe la file du dépôt) ; plus personne n'est réveillé pour autant.
      const remede = 'promouvoir le dernier READY avec l’outil Vercel de la session, puis relire /api/sante';
      const titre = `alias figé sur ${alias.commitServi}, dernier READY ${alias.commitDeploye}`;
      const existantes = (await api('GET', `/repos/${depot}/issues?labels=incident&state=open&per_page=20`).catch(() => [])) ?? [];
      if (!existantes.find((i) => i.title === titre)) {
        await api('POST', `/repos/${depot}/issues`, {
          title: titre,
          labels: ['incident'],
          body: `L'alias Vercel de l'application \`${depot}\` est figé sur le commit \`${alias.commitServi}\` alors que le dernier déploiement READY est sur \`${alias.commitDeploye}\`.\n\n**Remède** : ${remede}.`,
        }).catch(() => null);
      }
      return { action: 'rien', raison: `${titre} ; remède : ${remede}`, alias };
    }
    const prs = (await api('GET', `/repos/${depot}/commits/${evt.sha}/pulls`).catch(() => null)) ?? [];
    const config = { deploiement: evt.deploiement === 'aucun' ? 'aucun' : 'vercel', workflows: String(evt.workflows ?? '').split(',').map((x) => x.trim()).filter(Boolean) };
    for (const pr of prs.filter((p) => p.merged_at)) {
      const a = await accepter({ api, depot, numeroPr: pr.number, config, essais: 1, pause: 0 }).catch((e) => ({ statut: 'erreur', motifs: [e.message] }));
      if (a.statut === 'acceptee') {
        const apres = await suiteApresAcceptation({ api, depot, maintenant, taches: [a.tache] });
        return { ...(apres ?? { action: 'rien', raison: 'tâche acceptée, dépôt encore occupé' }), acceptation: a, alias };
      }
    }
    return { action: 'rien', raison: 'déploiement sans tâche à accepter', alias };
  }
  // Un commentaire « Preuve attendue » et la fin d'un cron d'app : seules les preuves différées dues se lisent (`decider`), rien d'autre ne bouge.
  if (type === 'commentaire' || type === 'fin_de_cron') return { action: 'rien', raison: type === 'commentaire' ? 'commentaire lu (preuves différées)' : `fin de cron ${signalSur(evt.signal) || 'inconnu'} lue (preuves différées)` };
  // Une note de LIA ne réveille plus le Coordinateur (nettoyage du 29/10/2026) : le type reste accepté (reacteur.yml l'envoie encore) mais ne fait rien.
  if (type === 'note_lia') return { action: 'rien', raison: 'note LIA : plus de réveil du Coordinateur' };
  // Classe B (scripts/preuve-page.mjs, workflow preuve-page.yml) : la page a été lue en mode fictif. Acceptée : la place se libère, la routine part pour la suivante.
  // Refusée ou lecture impossible : la tâche reste ouverte, personne n'est réveillé (le fil qui l'a livrée prouve ; le guetteur de silence voit le reste).
  if (type === 'preuve_page') {
    const n = Number(evt.issue);
    if (!Number.isInteger(n) || n <= 0) return { action: 'rien', raison: 'preuve de page sans numéro de tâche' };
    if (evt.raison === 'acceptee') {
      const apres = await suiteApresAcceptation({ api, depot, maintenant, taches: [n] });
      return apres ?? { action: 'rien', raison: 'tâche acceptée par la classe B, dépôt encore occupé' };
    }
    return { action: 'rien', raison: `preuve de page ${depot}#${n} non acceptée : la tâche reste ouverte` };
  }
  if (type === 'tache_fermee') {
    const abandon = evt.raison === 'not_planned' ? ' (abandonnée)' : '';
    const en = await travaux({ api, depot });
    const suite = await suivanteDe({ api, depot, maintenant });
    if (en >= PLACES_PAR_DEPOT) return { action: 'rien', raison: 'dépôt encore occupé' };
    return { action: 'lancer', motif: construireMotif([signeLibre(depot, en), suite.ligne, `tâche ${depot}#${evt.issue} fermée${abandon}`]), ...(suite.file ? { file: suite.file } : {}) };
  }

  if (type === 'pr_fusionnee') {
    const pr = await api('GET', `/repos/${depot}/pulls/${evt.pr}`);
    const taches = extraireTachesCompletes(pr?.body, depot);
    // Une mise à jour de robot (Dependabot…) sans tâche ne libère aucun dépôt.
    if (taches.length === 0 && ROBOTS.has(pr?.user?.login)) return { action: 'rien', raison: 'PR de robot sans tâche' };
    // Une tâche dont la preuve est lisible par une machine s'accepte ICI (scripts/acceptation-auto.mjs, §10 ter). Un échec n'arrête rien : la tâche reste ouverte.
    const config = { deploiement: evt.deploiement === 'aucun' ? 'aucun' : 'vercel', workflows: String(evt.workflows ?? '').split(',').map((x) => x.trim()).filter(Boolean) };
    const acceptation = await accepter({ api, depot, numeroPr: Number(evt.pr), config }).catch((e) => ({ statut: 'erreur', motifs: [e.message] }));
    // « ignoree » est le cas ordinaire (la tâche n'a rien demandé) : il ne sort pas de la décision.
    const dit = acceptation.statut === 'ignoree' ? {} : { acceptation };
    const tachesExclues = taches.filter((t) => t.depot === depot).map((t) => t.numero);
    const en = await travaux({ api, depot, tachesExclues });
    const suite = await suivanteDe({ api, depot, maintenant, exclure: tachesExclues });
    if (en >= PLACES_PAR_DEPOT) return { action: 'rien', raison: 'dépôt encore occupé', ...dit };
    const acceptee = acceptation.statut === 'acceptee' ? `tâche ${depot}#${acceptation.tache} acceptée seule` : '';
    return { action: 'lancer', motif: construireMotif([signeLibre(depot, en), suite.ligne, `PR #${evt.pr} fusionnée`, acceptee]), ...dit, ...(suite.file ? { file: suite.file } : {}) };
  }

  if (type === 'ci_rouge') {
    if (evt.evenement === 'pull_request') {
      if (evt.pr) {
        const pr = await api('GET', `/repos/${depot}/pulls/${evt.pr}`);
        if (!pr || pr.state !== 'open') return { action: 'rien', raison: 'PR fermée ou introuvable' };
        if (pr.draft) return { action: 'rien', raison: 'PR en brouillon' };
        if (pr.head?.sha !== evt.sha) return { action: 'rien', raison: 'un commit plus récent existe' };
      }
    } else if (evt.evenement === 'push' && evt.brancheRun !== evt.brancheDefaut) {
      return { action: 'rien', raison: 'branche de travail, pas la branche par défaut' };
    }
    const run = await api('GET', `/repos/${depot}/actions/runs/${evt.run}`);
    if (run && run.run_attempt === 1) {
      const lot = await api('GET', `/repos/${depot}/actions/runs/${evt.run}/jobs?filter=latest&per_page=100`);
      if (estPanneRunner(lot?.jobs ?? [])) return { action: 'relance', run: evt.run };
    }
    // Une vraie CI rouge ne réveille plus le Coordinateur : la PR et son fil la voient ; seuls les balayages de `.github` (relecture IA) partent.
    return { action: 'balayer', workflows: WORKFLOWS_BALAYAGE };
  }
  return { action: 'rien', raison: `type inconnu : ${type}` };
}

/** Exécute la décision. `journal` reçoit les lignes à afficher ; rend un résumé court. */
export async function traiter({ pilote = null, ...options }) {
  const { api, evt, journal = console.log, maintenant = new Date() } = options;
  // Pilotage des tâches (tâche MoKarade/.github#715) AVANT la décision : une tâche acceptée ici change ce que la décision voit (place libérée).
  const pilotage = pilote ? await pilote({ evt, maintenant }) : null;
  if (pilotage?.lignes.length) journal(`Réacteur : pilotage (${evt.type}) : ${pilotage.lignes.join(' ; ')}.`);
  for (const e of pilotage?.erreurs ?? []) journal(`::warning::Réacteur : pilotage, étape en échec : ${e}.`);
  const commun = { ...options, maintenant };
  const resultat = await traiterDecision(commun);
  // Ce que le pilotage vient de voir (place immobile, PR hors « Fichiers permis » de Jules, PR fusionnée non acceptée seule) est dit au Coordinateur dans SON message, pour que la déduplication
  // (même texte déjà sur la boîte depuis moins de `FENETRE_FILET_H` h : rien) joue même si le pilotage n'a aucune mémoire d'un passage à l'autre.
  let signale = false;
  if (pilotage?.signaux.length) {
    const motif = construireMotif(lignesDesSignaux(pilotage.signaux));
    if (evt.forcer === 'true' || !(await dejaSignale({ api, motif, maintenant }))) {
      await traiterDecision({ ...commun, decisionImposee: { action: 'reveiller', motif, cibles: [NUMERO_BOITE] } });
      signale = true;
    }
  }
  return { ...resultat, ...(pilotage ? { pilotage, ...(signale ? { signauxDits: pilotage.signaux.length } : {}) } : {}) };
}

/** Réveille chaque boîte de `cibles` (workflow `boite-reacteur.yml` d'app-template, jeton de réveil). Un échec sur la dernière cible restante remonte ; sur une autre, avertissement. */
async function commenterBoites({ api, d, evt, jetonReveil, journal }) {
  const reveilles = [];
  let echec = null;
  for (const numero of d.cibles ?? [NUMERO_BOITE]) {
    try {
      await api('POST', `/repos/${DEPOT_BOITE}/actions/workflows/${WORKFLOW_BOITE}/dispatches`, { ref: 'main', inputs: numero === NUMERO_BOITE ? { texte: d.motif } : { texte: d.motif, boite: String(numero) } }, jetonReveil);
      reveilles.push(numero);
    } catch (e) {
      echec = e;
    }
  }
  if (reveilles.includes(NUMERO_BOITE)) journal(`Réacteur : Coordinateur réveillé (${d.motif})`);
  for (const n of reveilles.filter((x) => x !== NUMERO_BOITE)) journal(`Réacteur : boîte #${n} réveillée pour ${evt.depot} (${d.motif})`);
  if (echec) throw echec;
  return reveilles;
}

async function traiterDecision({ api, evt, jetonReveil, journal = console.log, maintenant = new Date(), jetonLecture = '', accepterDifferees, decisionImposee = null, pause, fetchImpl, apps, routine = null, appeler = fetch }) {
  let d = decisionImposee ?? await decider({ api, evt, maintenant, jetonLecture, pause, fetchImpl, journal, apps, ...(accepterDifferees ? { accepterDifferees } : {}) });
  if (d.differees?.acceptees.length) journal(`Réacteur : preuve différée lue et acceptée automatiquement sur ${d.differees.acceptees.map((n) => `#${n}`).join(', ')} (docs/cycle-de-vie-tache.md §10 quater).`);
  if (d.differees?.erreur) journal(`::warning::Réacteur : preuves différées non lues (${d.differees.erreur}). Un fil prouvera.`);
  if (d.acceptation?.statut === 'acceptee') journal(`Réacteur : tâche #${d.acceptation.tache} acceptée automatiquement (docs/cycle-de-vie-tache.md §10 ter).`);
  else if (d.acceptation?.statut === 'erreur') journal(`::warning::Réacteur : acceptation automatique non faite (${d.acceptation.motifs.join(' ; ')}). Un fil prouvera.`);
  if (d.action === 'rien') {
    journal(`Réacteur : rien à faire (${d.raison}).`);
    return d;
  }
  if (d.action === 'relance') {
    await api('POST', `/repos/${evt.depot}/actions/runs/${d.run}/rerun-failed-jobs`);
    journal(`Réacteur : échec de charge du robot, jobs relancés une fois (run ${d.run}), personne n'est réveillé.`);
    return d;
  }
  if (d.action === 'balayer') {
    // Aucun réveil ici : une PR qui s'ouvre ou une CI rouge ne dérange personne.
    if (!jetonReveil) {
      journal('::warning::Réacteur : balayage impossible, le secret REVEIL_TOKEN est absent (PR d’un fork, ou secret pas encore posé).');
      return { ...d, balayages: [] };
    }
    return { ...d, balayages: await lancerBalayages({ api, jetonReveil, journal, workflows: d.workflows ?? WORKFLOWS_PR_OUVERTE }) };
  }
  if (d.action === 'reveiller') {
    if (!jetonReveil) {
      journal('::warning::Réacteur : réveil impossible, le secret REVEIL_TOKEN est absent (PR d’un fork, ou secret pas encore posé).');
      return { ...d, reveille: false };
    }
    await commenterBoites({ api, d, evt, jetonReveil, journal });
    return { ...d, reveille: true };
  }
  // action « lancer ». Chaque tâche prête, de n'importe quel dépôt, part dans une session neuve (tâche MoKarade/.github#860, étendue à tous les dépôts par la tâche #871, demande de Marc du 29/10/2026 :
  // « à chaque tâche une session neuve » ; docs/cycle-de-vie-tache.md §6). Sans les secrets de la routine, rien ne se lance ; un lancement raté est un avertissement, jamais une exception.
  const suivante = d.file?.suivante;
  if (routine && suivante) {
    const lancee = await lancerRoutine({ api, depot: evt.depot, n: suivante, routine, file: d.file, maintenant, journal, appeler });
    if (lancee.statut === 'lancee' || lancee.statut === 'deja') d = { ...d, routine: { n: suivante }, motif: `${d.motif} ; routine : #${suivante} ${lancee.statut === 'deja' ? 'déjà ' : ''}lancée`.slice(0, LONGUEUR_MAX) };
    else if (lancee.statut === 'rien') journal(`Réacteur : routine non lancée pour ${evt.depot}#${suivante} (${lancee.raison}).`);
  }
  journal(`Réacteur : ${d.motif}`);
  const balayages = jetonReveil && TYPES_BALAYAGE.has(evt.type) ? await lancerBalayages({ api, jetonReveil, journal }) : [];
  return { ...d, balayages };
}

/** Lance les balayages de `.github`, un par un ; un échec (jeton sans droit, workflow absent) est un avertissement, jamais une exception. */
async function lancerBalayages({ api, jetonReveil, journal, workflows = WORKFLOWS_BALAYAGE }) {
  const lances = [];
  for (const workflow of workflows) {
    try {
      await api('POST', `/repos/${DEPOT_GITHUB}/actions/workflows/${workflow}/dispatches`, { ref: 'main' }, jetonReveil);
      lances.push(workflow);
    } catch (e) {
      journal(`::warning::Réacteur : ${workflow} non lancé (${e.message}). Le jeton de réveil couvre-t-il ${DEPOT_GITHUB} ?`);
    }
  }
  if (lances.length > 0) journal(`Réacteur : balayages lancés (${lances.join(', ')})`);
  return lances;
}

function apiGitHub(jeton) {
  return async function api(methode, chemin, corps, jetonSpecifique) {
    const reponse = await fetch(`https://api.github.com${chemin}`, {
      method: methode,
      headers: {
        authorization: `Bearer ${jetonSpecifique ?? jeton}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
        'user-agent': 'reveil-reacteur',
      },
      body: corps ? JSON.stringify(corps) : undefined,
    });
    if (reponse.status === 404 && methode === 'GET') return null;
    if (!reponse.ok) throw new Error(`HTTP ${reponse.status} sur ${methode} ${chemin}`);
    return reponse.status === 204 ? null : reponse.json();
  };
}

export async function main(env = process.env) {
  const evt = {
    type: env.REVEIL_TYPE,
    depot: env.REVEIL_DEPOT,
    pr: env.REVEIL_PR || '',
    issue: env.REVEIL_ISSUE || '',
    raison: env.REVEIL_RAISON || '',
    evenement: env.REVEIL_EVENEMENT || '',
    sha: env.REVEIL_SHA || '',
    run: env.REVEIL_RUN || '',
    brancheRun: env.REVEIL_BRANCHE_RUN || '',
    brancheDefaut: env.REVEIL_BRANCHE_DEFAUT || '',
    forcer: env.REVEIL_FORCER || '',
    deploiement: env.REVEIL_DEPLOIEMENT || '',
    workflows: env.REVEIL_WORKFLOWS || '',
    signal: env.REVEIL_SIGNAL || '',
  };
  try {
    // Le pilotage des tâches et de Jules écrit avec le jeton du job, jamais avec celui du réveil, et sans la CLI `gh` (absente du PATH du robot du PC : DriveAI#798).
    const r = await traiter({ api: apiGitHub(env.GITHUB_TOKEN), evt, jetonReveil: env.REVEIL_TOKEN, jetonLecture: env.GITHUB_TOKEN, routine: env.ROUTINE_PRENDRE_URL && env.ROUTINE_PRENDRE_TOKEN ? { url: env.ROUTINE_PRENDRE_URL, token: env.ROUTINE_PRENDRE_TOKEN } : null, pilote: piloteDuJob({ gh: ghSynchrone({ jeton: env.GITHUB_TOKEN }) }) });
    // Une étape du pilotage en échec rend le run rouge APRÈS le réveil : `signaler-echec.yml` ouvre alors l'issue `boucle:erreur` (rien ne se perd en silence).
    if (r?.pilotage?.erreurs.length) process.exitCode = 1;
  } catch (e) {
    // Jamais de rouge : un échec ici ne doit pas se rejouer.
    console.log(`::warning::Réacteur : réveil non fait (${e.message}). Le filet de 6 h reprend la main.`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
