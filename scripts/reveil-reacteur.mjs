#!/usr/bin/env node
// Réveil du Coordinateur par un événement GitHub, SANS IA (docs/cycle-de-vie-tache.md §6, mission MoKarade/.github#116).
//
// Remplace la routine « Réacteur » (session Claude lancée à chaque événement). Tout ce qu'elle faisait de mécanique
// est ici, en code testé :
//   - pr_fusionnee : « D libre » (aucun travail) ou « D : une place libre » (un seul sur deux places), et « preuve à poser sur D#n » si la tâche citée n'a ni « Acceptée » ni `preuve-attendue` ;
//   - tache_fermee : « D libre » ou « D : une place libre » (le garde-fou de preuve a déjà validé la fermeture, voir reacteur.yml) ;
//   - ci_rouge : PR encore ouverte, hors brouillon, au même commit, sinon rien ; un échec de charge du robot (job mort
//     sans étape en échec) est relancé UNE fois et ne réveille personne ; le reste réveille.
//   - filet : à CHAQUE passage (cron, même en retard de plusieurs heures, ou lancement manuel), ce que les événements n'ont
//     pas signalé, lu dans le dépôt appelant avec le jeton du job : PR rouge depuis plus de 30 min (hors brouillon, hors
//     Dependabot et Mergify, hors Garde-fou qui attend Marc), issue `incident` ouverte, branche par défaut rouge ; le jeudi,
//     dans .github seulement, le rappel de remesure de la consommation Claude. Un seul réveil par dépôt, rien à signaler =
//     aucun réveil. Aucune garde d'heure : GitHub a lancé les crons du 17/10/2026 avec 3 h de retard et la garde « 6 h au
//     Québec » les a tous fait sauter. Pour qu'un même signal ne réveille pas deux fois quand deux passages tombent à quelques
//     minutes d'écart, un motif identique déjà posté sur la boîte dans les 6 dernières heures n'est pas reposté.
//     Tâches MoKarade/.github#143 et #194.
// Sur une PR fusionnée, une tâche fermée ou le filet, il lit aussi les preuves différées DUES du dépôt (`preuve-attendue-auto.mjs`, §10 quater) : une tâche en
// `preuve-attendue` dont l'heure est passée et dont les lignes `**Contrôle**` (http, actions) réussissent s'accepte seule, sans minuteur de plus (tâche #700).
// Puis il lance `boite-reacteur.yml` d'app-template, qui commente la boîte (app-template#58) en `github-actions[bot]` :
// ce commentaire réveille le Coordinateur (un commentaire du compte de Marc ne réveille personne).
//
// Sur une PR fusionnée, une CI rouge ou une tâche fermée (jamais sur le filet), il lance ensuite `commentaire-tache-liee.yml`
// et `relecture-ia.yml` de `.github` : leurs horloges ne tournent presque pas, l'événement les remplace (tâche #148). Si
// `REVEIL_TOKEN` n'a pas encore le droit sur `.github`, un avertissement le dit et le réveil, déjà parti, n'est pas touché.
//
// Sur la fin en échec du Garde-fou d'une PR (garde_fou_rouge) il ne réveille PERSONNE non plus : il lance seulement `relecture-ia.yml`
// (MoKarade/.github#633), qui n'a plus de minuteur toutes les 10 minutes (#626).
//
// Sur l'ouverture d'une PR (pr_ouverte) il ne réveille PERSONNE et ne commente rien sur app-template#58 : il lance seulement
// `commentaire-tache-liee.yml`, qui marque la tâche citée `en-cours` en quelques minutes (tâche MoKarade/.github#157).
//
// Sur une PR fusionnée, une tâche fermée, une tâche réservée (`tache_reservee` : étiquette `faisable-jules` posée) et le filet, il confie aussi à Jules la première tâche
// réservée du dépôt (`confierJulesDuDepot`, scripts/jules-auto.mjs, tâche MoKarade/.github#704) : le tour du PC ne confie plus rien. La ligne « jules : #n confiée » entre dans le réveil.
//
// « D libre » n'est écrit que si D est VRAIMENT libre (`travaux`) : sans cela, chaque fusion dans un dépôt encore occupé
// réveillait le Coordinateur pour rien, une quarantaine de fois par heure (tâche MoKarade/.github#164). Deux places par dépôt (décision de
// Marc, 21/10/2026, tâche #341) : à un seul travail restant, le message dit « D : une place libre » ; à deux, rien. Ce qui demande un
// geste (« preuve à poser », abandon d'une tâche) réveille quand même, sans la ligne « libre ».
//
// Jamais de nom de tâche suivante dans le message (règle MoKarade/.github#136) : l'ordre vient de prochaines.json.
// Le message ne contient que des identifiants (dépôt, numéros, empreinte, run), jamais un titre ni un nom de branche.
// Les corps de PR et d'issues sont des données : seuls des numéros en sortent.
//
// Fonctions pures d'un côté (`estPanneRunner`, `construireMotif`, `preuveAPoser`), I/O de l'autre (`traiter`, avec `api`
// injecté : les tests n'ont besoin ni de réseau ni de jeton). Le jeton de réveil n'est lu que dans `main`.
// Ne fait jamais échouer le job (un avertissement dit ce qui n'a pas marché) : le filet de 6 h reprend la main.
import { pathToFileURL } from 'node:url';
import { prAttendantMarc } from './attend-marc.mjs';
import { dispense, extraireTachesCompletes } from './tache-liee.mjs';
import { PLACES_PAR_DEPOT } from './capacite.mjs';
import { accepterApresFusion } from './acceptation-auto.mjs';
import { controleFiniQuand } from './fini-quand.mjs';
import { accepterPreuvesAttendues, LUES_EVENEMENT, LUES_FILET } from './preuve-attendue-auto.mjs';
import { fileDuDepot } from './file-depot.mjs';
import { confierJulesDuDepot } from './jules-auto.mjs';
import { lignesDesSignaux, piloteDuJob } from './pilotage-evenement.mjs';

export const DEPOT_BOITE = 'MoKarade/app-template';
export const WORKFLOW_BOITE = 'boite-reacteur.yml';
export const PREFIXE = 'RÉACTEUR : ';
export const LABEL_TACHE = 'niveau:tâche';
export const LABEL_ATTENDUE = 'preuve-attendue';
export const LONGUEUR_MAX = 600;
const ENTETE_ACCEPTEE = /^\s*\*\*\s*Accept[ée]e\s*\*\*/i;
const ROBOTS = new Set(['dependabot[bot]', 'mergify[bot]', 'github-actions[bot]']);
export const FUSEAU = 'America/Toronto';
export const SEUIL_ROUGE_MIN = 30;
// Le filet ne repose pas un motif identique déjà posté sur la boîte depuis cette durée (deux crons à quelques minutes d'écart).
export const FENETRE_FILET_H = 6;
export const NUMERO_BOITE = 58;
// Une boîte par dépôt (tâche MoKarade/.github#750, demande de Marc du 28/10/2026 : « tout automatique », démarrage d'un fil compris) : PR brouillon permanente
// d'app-template, créée comme la #58. Le fil de l'app s'y abonne et un commentaire du robot le réveille sans passer par le Coordinateur.
export const BOITES = {
  'MoKarade/.github': 196,
  'MoKarade/app-template': 197,
  'MoKarade/batchchef-': 198,
  'MoKarade/CarAI': 199,
  'MoKarade/DriveAI': 200,
  'MoKarade/FinanceAI': 201,
  'MoKarade/hub-contract': 202,
  'MoKarade/Hubperso': 203,
  'MoKarade/JobAI': 204,
  'MoKarade/lia-ui': 205,
  'MoKarade/MemoryAI': 206,
};
// Dépôts dont le fil est CONFIRMÉ réveillé par sa boîte : plus de ligne sur la #58 pour eux. On n'y ajoute un dépôt qu'après un réveil réel de son fil (un fil non abonné ne doit rien perdre).
// Hubperso : confirmé le 28/10/2026 à 22:01:53Z (commentaire de la boîte #203 à 22:01:50Z). MemoryAI : 22:01:59Z (boîte #206).
// DriveAI : 22:03:26Z (#200). FinanceAI : 22:03:37Z (#201). batchchef- : vers 22:03Z (#198).
// JobAI : 22:03:31Z (#204). CarAI : 22:03:32Z (#199). .github : 22:03:30Z (#196). lia-ui : 22:03:29Z (#205, lu en file à 22:08Z, rien de perdu).
export const BOITES_DIRECTES = new Set(['MoKarade/Hubperso', 'MoKarade/MemoryAI', 'MoKarade/DriveAI', 'MoKarade/FinanceAI', 'MoKarade/batchchef-', 'MoKarade/JobAI', 'MoKarade/CarAI', 'MoKarade/.github', 'MoKarade/lia-ui']);
// Ce qui regarde le fil d'une app (une place libre, une tâche prête, une preuve à poser) ; la CI rouge, les notes LIA et le filet restent au Coordinateur.
export const TYPES_POUR_LE_FIL = new Set(['pr_fusionnee', 'tache_fermee', 'tache_ouverte', 'deploiement', 'preuve_page']);

// Boîte « preuve PC » (tâche MoKarade/.github#807, choix « A » de Marc du 29/10/2026 00:40Z) : le PC est réveillé directement, sans passer par le Coordinateur.
// Le fil propriétaire d'une tâche en `preuve-attendue` demande un relevé d'écran par un commentaire `**Relevé PC demandé** — …` ; le PC répond par `**Relevé PC** — …`
// sur la même issue, et la boîte du dépôt propriétaire est réveillée pour poser « Acceptée ». PR brouillon permanente app-template#211 (tâche #808) ; 0 la désactive : la demande ne réveille alors personne.
export const BOITE_PC = 211;
export const RELEVE_MIN = 40;
const ENTETE_DEMANDE_PC = /^\s*\*\*Relevé PC demandé\*\*/i;
const ENTETE_RELEVE_PC = /^\s*\*\*Relevé PC\*\*\s*[—:-]\s*(.*)$/is;

/**
 * Que dit le DERNIER commentaire d'une tâche ? { sorte: 'demande' | 'releve' | null, erreur }. Seul un humain (compte de Marc, donc le fil ou le PC) compte :
 * un robot n'ouvre ni ne ferme un relevé. Un relevé trop court n'en est pas un.
 */
export function lireCommentairePc(commentaire) {
  if (!commentaire || commentaire.user?.type !== 'User') return { sorte: null, erreur: 'commentaire absent ou posé par un robot' };
  const corps = String(commentaire.body ?? '');
  if (ENTETE_DEMANDE_PC.test(corps)) return { sorte: 'demande', erreur: null };
  const m = ENTETE_RELEVE_PC.exec(corps);
  if (!m) return { sorte: null, erreur: 'ni demande ni relevé PC' };
  if (m[1].trim().length < RELEVE_MIN) return { sorte: null, erreur: `relevé PC trop court (${RELEVE_MIN} caractères au moins)` };
  return { sorte: 'releve', erreur: null };
}

/** Les numéros de boîte qui reçoivent ce réveil, dans l'ordre : la #58 d'abord (sauf dépôt direct), puis la boîte du dépôt. */
export function boitesDuReveil({ evt, boites = BOITES, directes = BOITES_DIRECTES }) {
  const fil = boites[evt.depot];
  if (!fil || !TYPES_POUR_LE_FIL.has(evt.type)) return [NUMERO_BOITE];
  return directes.has(evt.depot) ? [fil] : [NUMERO_BOITE, fil];
}
// Hubperso porte deux fils (le dépôt et la Page chantier) : une seconde boîte, app-template#210, est pour les tâches qui touchent le chantier
// (tâche MoKarade/.github#769, décision du 28/10/2026 22:15Z). Un fil n'est jamais réveillé pour ce qui ne le regarde pas, et rien ne se perd :
// dans le doute (tâche illisible, aucune tâche citée), le réveil va à la boîte du dépôt, la #203.
export const BOITE_PAGE_CHANTIER = 210;
export const DEPOT_PAGE_CHANTIER = 'MoKarade/Hubperso';
export const LABEL_PAGE_CHANTIER = 'fil:page-chantier';
const FICHIERS_CHANTIER = /chantier\/|gantt/i;

/** La tâche (issue GitHub : labels + corps) regarde-t-elle la Page chantier ? Étiquette `fil:page-chantier`, ou un chemin chantier dans « Fichiers touchés ». */
export function regardeLaPageChantier(issue) {
  if (!issue) return false;
  const noms = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
  if (noms.includes(LABEL_PAGE_CHANTIER)) return true;
  const corps = String(issue.body ?? '');
  const debut = corps.search(/\*\*Fichiers (?:touchés|permis)\*\*/);
  if (debut < 0) return false;
  // La section va jusqu'au prochain titre en gras en début de ligne (**Source**, **Attend**…).
  const reste = corps.slice(debut + 2);
  const fin = reste.search(/\n\*\*[^*\n]+\*\*/);
  return FICHIERS_CHANTIER.test(fin < 0 ? reste : reste.slice(0, fin));
}

/**
 * Pour Hubperso : les numéros de boîte du réveil, d'après les tâches en jeu. Toutes pour la Page chantier -> sa boîte seule ;
 * mélange -> les deux ; aucune tâche, ou aucune lisible -> la boîte du dépôt. `lire(n)` rend l'issue ou null (jamais d'exception attendue).
 */
export async function boitesDuDepotAvecChantier({ sujets, lire, boiteDepot }) {
  const numeros = [...new Set((sujets ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (numeros.length === 0) return [boiteDepot];
  const verdicts = [];
  for (const n of numeros) verdicts.push(regardeLaPageChantier(await lire(n).catch(() => null)));
  if (verdicts.every(Boolean)) return [BOITE_PAGE_CHANTIER];
  if (verdicts.some(Boolean)) return [boiteDepot, BOITE_PAGE_CHANTIER];
  return [boiteDepot];
}
// Repli sans jeton (tâche MoKarade/.github#772) : un dépôt sans secret `REVEIL_TOKEN` (FinanceAI neuf, MemoryAI le 28/10/2026) ne peut pas lancer le workflow
// d'app-template. Il commente alors sa PROPRE boîte, un brouillon permanent sur `claude/boite-reacteur`, avec le jeton du job : le fil du dépôt qui s'y abonne
// est réveillé comme par une boîte d'app-template. Seuls les types destinés au fil passent ; le reste attend le jeton (le Coordinateur n'est pas sur cette boîte).
export const BRANCHE_BOITE_LOCALE = 'claude/boite-reacteur';

/** Commente la boîte locale du dépôt. Rend son numéro, ou null (aucune boîte brouillon ouverte, type non destiné au fil, lecture ou écriture en échec : jamais d'exception). */
export async function reveilLocal({ api, evt, texte, journal }) {
  if (!TYPES_POUR_LE_FIL.has(evt.type)) return null;
  try {
    const [proprietaire] = String(evt.depot).split('/');
    const prs = await api('GET', `/repos/${evt.depot}/pulls?state=open&head=${proprietaire}:${BRANCHE_BOITE_LOCALE}&per_page=1`);
    const boite = (prs ?? []).find((pr) => pr.draft === true && pr.head?.ref === BRANCHE_BOITE_LOCALE);
    if (!boite) return null;
    await api('POST', `/repos/${evt.depot}/issues/${boite.number}/comments`, { body: texte });
    return boite.number;
  } catch (e) {
    journal(`::warning::Réacteur : boîte locale de ${evt.depot} non réveillée (${e.message}).`);
    return null;
  }
}
// Réveil impossible (tâche MoKarade/.github#826) : sans `REVEIL_TOKEN` ni boîte locale, le journal ne portait qu'un avertissement et les réveils se perdaient
// en silence (CarAI, 29/10/2026 : une tâche restée libre 36 min). Le Réacteur laisse donc une issue unique par dépôt, avec le jeton du job (aucun nouveau
// secret). Étiquette à part, jamais `incident` : un `incident` ouvert coupe la file du dépôt (scripts/file-depot.mjs). Fermée au premier réveil réussi.
export const ETIQUETTE_SANS_JETON = 'reacteur-sans-jeton';
export const titreSansJeton = (depot) => `Réacteur sans jeton : ${depot}`;

async function ouvertesSansJeton({ api, depot }) {
  const issues = await api('GET', `/repos/${depot}/issues?state=open&labels=${ETIQUETTE_SANS_JETON}&per_page=5`);
  return (issues ?? []).filter((i) => !i.pull_request && (i.labels ?? []).some((l) => (l.name ?? l) === ETIQUETTE_SANS_JETON));
}

/** Ouvre l'issue « Réacteur sans jeton » si aucune n'est ouverte. Rend son numéro, ou null (déjà là, ou écriture refusée : PR d'un fork, jeton en lecture seule). Jamais d'exception. */
export async function signalerSansJeton({ api, evt, journal }) {
  try {
    if ((await ouvertesSansJeton({ api, depot: evt.depot })).length > 0) return null;
    const perdu = `\`${evt.type}\`${evt.issue ? ` sur #${evt.issue}` : ''}${evt.pr ? ` (PR #${evt.pr})` : ''}`;
    const cree = await api('POST', `/repos/${evt.depot}/issues`, {
      title: titreSansJeton(evt.depot),
      labels: [ETIQUETTE_SANS_JETON],
      body: `Le Réacteur n'a pas pu réveiller le fil de ${evt.depot} : le secret \`REVEIL_TOKEN\` est absent et le dépôt n'a pas de boîte locale. Dernier événement perdu : ${perdu}.\n\n**Geste** : poser \`REVEIL_TOKEN\` sur ${evt.depot} (jeton fine-grained avec Actions en écriture sur MoKarade/app-template). Aucune valeur de jeton ici.\n\nCette issue se ferme seule au premier réveil réussi (tâche MoKarade/.github#826).`,
    });
    journal(`Réacteur : issue « ${titreSansJeton(evt.depot)} » ouverte${cree?.number ? ` (#${cree.number})` : ''}.`);
    return cree?.number ?? null;
  } catch (e) {
    journal(`::warning::Réacteur : alerte « réveil impossible » non posée sur ${evt.depot} (${e.message}).`);
    return null;
  }
}

/** Ferme les issues « Réacteur sans jeton » ouvertes, une fois un réveil réussi. Rend les numéros fermés ; jamais d'exception. */
export async function leverSansJeton({ api, evt, journal }) {
  try {
    const fermees = [];
    for (const issue of await ouvertesSansJeton({ api, depot: evt.depot })) {
      await api('POST', `/repos/${evt.depot}/issues/${issue.number}/comments`, { body: 'Réveil réussi : le secret `REVEIL_TOKEN` est en place. Issue fermée par le Réacteur.' });
      await api('PATCH', `/repos/${evt.depot}/issues/${issue.number}`, { state: 'closed', state_reason: 'completed' });
      fermees.push(issue.number);
    }
    if (fermees.length > 0) journal(`Réacteur : réveil réussi, issue « ${titreSansJeton(evt.depot)} » fermée (${fermees.map((n) => `#${n}`).join(', ')}).`);
    return fermees;
  } catch (e) {
    journal(`::warning::Réacteur : issue « réveil impossible » non fermée sur ${evt.depot} (${e.message}).`);
    return [];
  }
}
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
const CONTROLE_MARC = 'Garde-fou';
const CONCLUSIONS_ROUGES = new Set(['failure', 'timed_out']);
const ROBOTS_SANS_FILET = /dependabot|mergify/i;

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

/** La tâche citée par la PR fusionnée attend-elle encore une preuve ? (ouverte, `niveau:tâche`, ni « Acceptée » ni `preuve-attendue`) */
export function preuveAPoser({ issue, commentaires }) {
  if (!issue || issue.state !== 'open') return false;
  const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
  if (!labels.includes(LABEL_TACHE) || labels.includes(LABEL_ATTENDUE)) return false;
  return !commentaires.some((c) => c.user?.type === 'User' && ENTETE_ACCEPTEE.test(c.body ?? ''));
}

/** Jour et heure au Québec pour une date : { heure: 0..23, jour: 'Mon'..'Sun' }. */
export function heureQuebec(date) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: FUSEAU, hour: 'numeric', hourCycle: 'h23', weekday: 'short' }).formatToParts(date);
  return { heure: Number(p.find((x) => x.type === 'hour').value), jour: p.find((x) => x.type === 'weekday').value };
}

/**
 * Un contrôle rouge depuis plus de `minutes` ? Le Garde-fou est exclu : rouge, il attend Marc (issue `qui:marc`)
 * et le signaler chaque matin ne ferait que du bruit.
 */
export function rougeDepuis(controles, maintenant, minutes = SEUIL_ROUGE_MIN) {
  const limite = maintenant.getTime() - minutes * 60_000;
  return controles.some((c) => {
    if (c.name === CONTROLE_MARC || !CONCLUSIONS_ROUGES.has(c.conclusion)) return false;
    const fin = Date.parse(c.completed_at ?? '');
    return Number.isFinite(fin) && fin <= limite;
  });
}

/** Le filet quotidien d'un dépôt : les lignes du réveil (vide = rien à signaler). Numéros seulement, jamais un titre. */
async function lignesDuFiletPour({ api, evt, maintenant }) {
  const { depot } = evt;
  const lignes = [];

  const prs = (await api('GET', `/repos/${depot}/pulls?state=open&per_page=30`)) ?? [];
  const rouges = [];
  for (const pr of prs) {
    if (pr.draft || ROBOTS_SANS_FILET.test(pr.user?.login ?? '')) continue;
    const lot = await api('GET', `/repos/${depot}/commits/${pr.head?.sha}/check-runs?per_page=100`);
    if (rougeDepuis(lot?.check_runs ?? [], maintenant)) rouges.push(`#${pr.number}`);
  }
  if (rouges.length > 0) lignes.push(`PR rouge depuis plus de ${SEUIL_ROUGE_MIN} min sur ${depot} : ${rouges.join(', ')}`);

  const incidents = ((await api('GET', `/repos/${depot}/issues?labels=incident&state=open&per_page=20`)) ?? []).filter((i) => !i.pull_request);
  if (incidents.length > 0) lignes.push(`incident ouvert sur ${depot} : ${incidents.map((i) => `#${i.number}`).join(', ')}`);

  if (evt.brancheDefaut) {
    const lot = await api('GET', `/repos/${depot}/commits/${evt.brancheDefaut}/check-runs?per_page=100`);
    if (rougeDepuis(lot?.check_runs ?? [], maintenant)) lignes.push(`branche par défaut rouge sur ${depot}`);
  }

  if (depot === DEPOT_GITHUB && heureQuebec(maintenant).jour === 'Thu') {
    lignes.push('jeudi : remesure hebdo de la consommation Claude à lancer');
  }
  return lignes;
}

/**
 * Ce motif exact est-il déjà sur la boîte, posté par le robot dans les `FENETRE_FILET_H` dernières heures ? Une lecture qui
 * échoue ne cache rien : on rend faux (un réveil en double coûte moins qu'un signal qu'on ne dit pas).
 */
async function dejaSignale({ api, motif, maintenant, depot = '' }) {
  const limite = maintenant.getTime() - FENETRE_FILET_H * 3_600_000;
  try {
    const depuis = encodeURIComponent(new Date(limite).toISOString());
    const numeros = [NUMERO_BOITE, ...(BOITES[depot] ? [BOITES[depot]] : [])];
    for (const numero of numeros) {
      const commentaires = await commentairesDe(api, DEPOT_BOITE, numero, depuis);
      if (commentaires.some((c) => c.body === motif && c.user?.login === 'github-actions[bot]' && Date.parse(c.created_at ?? '') >= limite)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function filet({ api, evt, maintenant }) {
  const lignes = await lignesDuFiletPour({ api, evt, maintenant });
  // Le filet est aussi le rattrapage de Jules : une tâche réservée dont l'événement a été manqué part ici (tâche #704).
  const dit = await julesDe({ api, depot: evt.depot, maintenant });
  if (lignes.length === 0) return { action: 'rien', raison: 'rien à signaler', ...dit };
  // La ligne « jules » n'entre pas dans le motif du filet : le réveil du filet dit des signaux, et sa déduplication compare le motif tel quel.
  const motif = construireMotif(lignes);
  // « forcer » (lancement manuel) repose le réveil même si le même signal vient d'être posté : c'est une demande d'essai.
  if (evt.forcer !== 'true' && (await dejaSignale({ api, motif, maintenant, depot: evt.depot }))) {
    return { action: 'rien', raison: `déjà signalé sur la boîte dans les ${FENETRE_FILET_H} dernières heures`, ...dit };
  }
  return { action: 'reveiller', motif, ...dit };
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

/**
 * Jules prend la première tâche réservée (`faisable-jules`) du dépôt à cet événement (tâche MoKarade/.github#704, §5 quater) : plus de tour du PC.
 * Part même dans un dépôt occupé (23/10/2026) ; les règles sont celles de `confierJulesDuDepot`. `file` : la file déjà lue pour la suivante, sinon relue ici.
 * Rend { jules } seulement quand une tâche vient d'être confiée (le reste ne change rien à la décision), jamais d'exception.
 */
async function julesDe({ api, depot, maintenant, file = null, exclure = [] }) {
  try {
    const brut = file ?? (await fileDuDepot({ api, depot, maintenant, exclure, libereA: maintenant.toISOString() }).catch(() => null));
    const jules = await confierJulesDuDepot({ api, depot, file: brut });
    if (jules.statut === 'confiee') return { jules };
    // Une réservée qui reste là a sa raison dans le journal (ne réveille personne) ; « aucune tâche réservée » est le cas ordinaire, il ne se dit pas.
    return jules.statut === 'rien' && jules.raison !== 'aucune tâche réservée' ? { julesRaison: jules.raison } : {};
  } catch {
    return {};
  }
}

/** La ligne du réveil pour une tâche confiée à Jules : le numéro seulement (règle MoKarade/.github#136). */
const ligneJules = (dit) => (dit.jules ? `jules : #${dit.jules.n} confiée` : '');

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
export const TYPES_EVENEMENT_NOUVEAU = new Set(['tache_ouverte', 'deploiement', 'commentaire', 'fin_de_cron', 'note_lia']);
// Un identifiant venu d'un `repository_dispatch` (note LIA, cron d'app) : lettres, chiffres, point, tiret, souligné ; sinon rien n'en sort.
export const signalSur = (v) => (/^[0-9A-Za-z._-]{1,40}$/.test(String(v ?? '')) ? String(v) : '');

/**
 * Décide quoi faire d'un événement, puis lit les preuves différées dues du dépôt (scripts/preuve-attendue-auto.mjs). Le résultat ne change pas
 * quand rien n'est accepté ni refusé par erreur : la clé `differees` n'apparaît que s'il y a quelque chose à dire.
 */
export async function decider({ api, evt, maintenant = new Date(), accepter = accepterApresFusion, accepterDifferees = accepterPreuvesAttendues, jetonLecture = '', boitePc = BOITE_PC }) {
  const d = await deciderEvenement({ api, evt, maintenant, accepter, boitePc });
  if (!TYPES_PREUVE_DIFFEREE.has(evt.type)) return d;
  const config = { deploiement: evt.deploiement === 'aucun' ? 'aucun' : 'vercel', workflows: String(evt.workflows ?? '').split(',').map((x) => x.trim()).filter(Boolean) };
  const differees = await accepterDifferees({ api, depot: evt.depot, maintenant, config, jeton: jetonLecture, lues: evt.type === 'filet' ? LUES_FILET : LUES_EVENEMENT }).catch((e) => ({ acceptees: [], ignorees: [], erreur: e.message }));
  if (differees.acceptees.length > 0 && d.action === 'rien' && TYPES_EVENEMENT_NOUVEAU.has(evt.type)) {
    // Une acceptation faite par un événement qui ne réveillait personne libère une place (la fermeture par le jeton du job ne lance aucun autre workflow) : on le dit ici.
    const apres = await reveilApresAcceptation({ api, depot: evt.depot, maintenant, taches: differees.acceptees });
    return apres ? { ...d, ...apres, differees } : { ...d, differees };
  }
  return differees.acceptees.length > 0 || differees.erreur ? { ...d, differees } : d;
}

/** La preuve de cette tâche se lit-elle par la classe B ? « Fini quand » de classe B bien écrit ET le dépôt a le workflow `preuve-page.yml`. */
async function parLaClasseB({ api, depot, issue }) {
  const v = controleFiniQuand(issue?.body);
  if (!v.ok || v.classe !== 'B') return false;
  return Boolean(await api('GET', `/repos/${depot}/contents/.github/workflows/preuve-page.yml`).catch(() => null));
}

/**
 * Le réveil d'une tâche que le Réacteur vient d'accepter seul hors d'une PR fusionnée (déploiement READY, preuve différée due) : « D libre ; suivante : #n ;
 * tâche D#n acceptée seule », et Jules reçoit sa tâche. Dépôt dont les deux places sont prises : rien (même règle qu'à la fusion). Rend null si rien à dire.
 */
async function reveilApresAcceptation({ api, depot, maintenant, taches }) {
  const en = await travaux({ api, depot });
  const suite = await suivanteDe({ api, depot, maintenant });
  const dit = await julesDe({ api, depot, maintenant, file: suite.brut });
  if (en >= PLACES_PAR_DEPOT) return Object.keys(dit).length ? { raison: 'dépôt encore occupé', ...dit } : null;
  const lignes = taches.map((n) => `tâche ${depot}#${n} acceptée seule`);
  return { action: 'reveiller', motif: construireMotif([signeLibre(depot, en), suite.ligne, ligneJules(dit), ...lignes]), ...(suite.file ? { file: suite.file } : {}), ...dit };
}

/**
 * Décide quoi faire d'un événement. Rend { action: 'reveiller', motif } | { action: 'relance', run } | { action: 'balayer' } | { action: 'rien', raison }.
 * `evt` : { type, depot, pr, issue, raison, evenement, sha, run, brancheRun, brancheDefaut, forcer }.
 */
async function deciderEvenement({ api, evt, maintenant, accepter, boitePc = BOITE_PC }) {
  const { type, depot } = evt;
  if (type === 'filet') return filet({ api, evt, maintenant });
  if (type === 'pr_ouverte') return { action: 'balayer' };
  if (type === 'garde_fou_rouge') return { action: 'balayer', workflows: WORKFLOWS_GARDE_FOU_ROUGE };
  // Une tâche s'ouvre, change ou perd une étiquette : si elle devient LA suivante d'un dépôt qui a une place, le Coordinateur le sait tout de suite (tâche #712).
  if (type === 'tache_ouverte') {
    const n = Number(evt.issue);
    const issue = await api('GET', `/repos/${depot}/issues/${n}`);
    const noms = (issue?.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
    if (!issue || issue.state !== 'open' || !noms.includes(LABEL_TACHE)) return { action: 'rien', raison: 'pas une tâche ouverte' };
    const en = await travaux({ api, depot });
    const suite = await suivanteDe({ api, depot, maintenant });
    const dit = await julesDe({ api, depot, maintenant, file: suite.brut });
    if (en >= PLACES_PAR_DEPOT) return { action: 'rien', raison: 'dépôt encore occupé', ...dit };
    if (suite.brut?.suivante !== n) return { action: 'rien', raison: 'cette tâche n’est pas la suivante', ...dit };
    const motif = construireMotif([signeLibre(depot, en), suite.ligne, ligneJules(dit), `tâche ${depot}#${n} prête`]);
    // Une modification de plus du même corps ne repose pas le même réveil.
    if (evt.forcer !== 'true' && (await dejaSignale({ api, motif, maintenant, depot }))) return { action: 'rien', raison: `déjà signalé sur la boîte dans les ${FENETRE_FILET_H} dernières heures`, ...dit };
    return { action: 'reveiller', motif, file: suite.file, sujets: [n], ...dit };
  }
  // Un déploiement de production réussi : la tâche de la PR fusionnée sur ce commit s'accepte seule si sa règle le permet (la PR a pu fusionner avant la fin du déploiement).
  if (type === 'deploiement') {
    const prs = (await api('GET', `/repos/${depot}/commits/${evt.sha}/pulls`).catch(() => null)) ?? [];
    const config = { deploiement: evt.deploiement === 'aucun' ? 'aucun' : 'vercel', workflows: String(evt.workflows ?? '').split(',').map((x) => x.trim()).filter(Boolean) };
    for (const pr of prs.filter((p) => p.merged_at)) {
      const a = await accepter({ api, depot, numeroPr: pr.number, config, essais: 1, pause: 0 }).catch((e) => ({ statut: 'erreur', motifs: [e.message] }));
      if (a.statut === 'acceptee') {
        const apres = await reveilApresAcceptation({ api, depot, maintenant, taches: [a.tache] });
        return { ...(apres ?? { action: 'rien', raison: 'tâche acceptée, dépôt encore occupé' }), acceptation: a };
      }
    }
    return { action: 'rien', raison: 'déploiement sans tâche à accepter' };
  }
  // Relevé PC (BOITE_PC) : la demande réveille le PC, le relevé réveille le fil propriétaire. Rien d'autre ne bouge pour un commentaire.
  if (type === 'commentaire') {
    const n = Number(evt.issue);
    if (Number.isInteger(n) && n > 0 && /^[\w.-]+\/[\w.-]+$/.test(depot)) {
      const dernier = (await commentairesDe(api, depot, n).catch(() => [])).at(-1);
      const { sorte } = lireCommentairePc(dernier);
      if (sorte === 'demande') {
        if (!boitePc) return { action: 'rien', raison: 'relevé PC demandé, boîte PC pas encore créée (#808) : le fil prouve comme avant' };
        return { action: 'reveiller', motif: construireMotif([`relevé PC demandé sur ${depot}#${n}`]), sujets: [n], cibles: [boitePc] };
      }
      if (sorte === 'releve') {
        return { action: 'reveiller', motif: construireMotif([`relevé PC posé sur ${depot}#${n}`, 'poser « Acceptée » en citant le relevé']), sujets: [n], cibles: boitesDuReveil({ evt: { depot, type: 'preuve_page' } }) };
      }
    }
  }
  // Un commentaire « Preuve attendue » et la fin d'un cron d'app : seules les preuves différées dues se lisent (`decider`), rien d'autre ne bouge.
  if (type === 'commentaire' || type === 'fin_de_cron') return { action: 'rien', raison: type === 'commentaire' ? 'commentaire lu (preuves différées)' : `fin de cron ${signalSur(evt.signal) || 'inconnu'} lue (preuves différées)` };
  // Une note de LIA est arrivée : le Coordinateur est réveillé avec un identifiant seulement (règle MoKarade/.github#136).
  if (type === 'note_lia') {
    const note = signalSur(evt.signal);
    return { action: 'reveiller', motif: construireMotif([`note LIA reçue sur ${depot}`, note ? `note ${note}` : '']) };
  }
  // Une tâche vient d'être réservée à Jules (étiquette `faisable-jules` posée) : il la prend tout de suite si le dépôt le permet, sans réveiller personne.
  // Classe B (scripts/preuve-page.mjs, workflow preuve-page.yml) : la page a été lue en mode fictif. Acceptée : la place se libère, le fil suivant est réveillé.
  // Refusée ou lecture impossible : la tâche reste ouverte et le fil de l'app prouve (rien ne se perd, aucun minuteur).
  if (type === 'preuve_page') {
    const n = Number(evt.issue);
    if (!Number.isInteger(n) || n <= 0) return { action: 'rien', raison: 'preuve de page sans numéro de tâche' };
    if (evt.raison === 'acceptee') {
      const apres = await reveilApresAcceptation({ api, depot, maintenant, taches: [n] });
      return apres ?? { action: 'rien', raison: 'tâche acceptée par la classe B, dépôt encore occupé' };
    }
    return { action: 'reveiller', motif: construireMotif([`preuve à poser sur ${depot}#${n}`, 'classe B : la lecture de la page en mode fictif n’a pas abouti', evt.pr ? `PR #${evt.pr}` : '']), sujets: [n] };
  }
  if (type === 'tache_reservee') {
    const dit = await julesDe({ api, depot, maintenant });
    return { action: 'rien', raison: dit.jules ? `tâche #${dit.jules.n} confiée à Jules` : 'rien à confier à Jules', ...dit };
  }
  if (type === 'tache_fermee') {
    const abandon = evt.raison === 'not_planned' ? ' (abandonnée : vérifier la raison)' : '';
    const en = await travaux({ api, depot });
    // Jules part même dans un dépôt occupé : la file est lue avant l'éventuel « rien ».
    const suite = await suivanteDe({ api, depot, maintenant });
    const dit = await julesDe({ api, depot, maintenant, file: suite.brut });
    // Un dépôt dont les deux places sont prises n'a rien de neuf à dire, sauf une tâche abandonnée dont il faut vérifier la raison.
    if (en >= PLACES_PAR_DEPOT && !abandon) return { action: 'rien', raison: 'dépôt encore occupé', ...dit };
    return { action: 'reveiller', motif: construireMotif([signeLibre(depot, en), suite.ligne, ligneJules(dit), `tâche ${depot}#${evt.issue} fermée${abandon}`]), sujets: [Number(evt.issue), suite.brut?.suivante].filter(Boolean), ...(suite.file ? { file: suite.file } : {}), ...dit };
  }

  if (type === 'pr_fusionnee') {
    const pr = await api('GET', `/repos/${depot}/pulls/${evt.pr}`);
    const taches = extraireTachesCompletes(pr?.body, depot);
    // Une mise à jour de robot (Dependabot…) sans tâche ne libère aucun dépôt : pas de réveil, donc pas de quota.
    if (taches.length === 0 && ROBOTS.has(pr?.user?.login)) return { action: 'rien', raison: 'PR de robot sans tâche' };
    // Une tâche dont la preuve est lisible par une machine s'accepte ICI (scripts/acceptation-auto.mjs, §10 ter), avant de lire ce qui reste à prouver.
    // Un échec n'arrête rien : la tâche reste ouverte et le Coordinateur est réveillé comme avant (« preuve à poser »).
    const config = { deploiement: evt.deploiement === 'aucun' ? 'aucun' : 'vercel', workflows: String(evt.workflows ?? '').split(',').map((x) => x.trim()).filter(Boolean) };
    const acceptation = await accepter({ api, depot, numeroPr: Number(evt.pr), config }).catch((e) => ({ statut: 'erreur', motifs: [e.message] }));
    // « ignoree » est le cas ordinaire (la tâche n'a rien demandé) : il ne sort pas de la décision.
    const dit = acceptation.statut === 'ignoree' ? {} : { acceptation };
    const preuves = [];
    const classeB = [];
    for (const t of taches) {
      const cle = `${t.depot}#${t.numero}`;
      const issue = await api('GET', `/repos/${t.depot}/issues/${t.numero}`).catch(() => null);
      if (preuveAPoser({ issue, commentaires: issue ? await commentairesDe(api, t.depot, t.numero).catch(() => []) : [] })) {
        // Classe B dans un dépôt qui a `preuve-page.yml` : la machine lit la page et réveille elle-même (type `preuve_page`) si elle n'accepte pas.
        if (t.depot === depot && (await parLaClasseB({ api, depot, issue }))) classeB.push(`${cle} lue par la classe B`);
        else preuves.push(`preuve à poser sur ${cle}`);
      }
    }
    const tachesExclues = taches.filter((t) => t.depot === depot).map((t) => t.numero);
    const en = await travaux({ api, depot, tachesExclues });
    const suite = await suivanteDe({ api, depot, maintenant, exclure: tachesExclues });
    const jules = await julesDe({ api, depot, maintenant, file: suite.brut });
    // Dépôt dont les deux places sont prises et rien à prouver : la fusion n'apprend rien au Coordinateur.
    if (en >= PLACES_PAR_DEPOT && preuves.length === 0) return { action: 'rien', raison: 'dépôt encore occupé', ...dit, ...jules };
    const acceptee = acceptation.statut === 'acceptee' ? `tâche ${depot}#${acceptation.tache} acceptée seule` : '';
    return { action: 'reveiller', motif: construireMotif([signeLibre(depot, en), suite.ligne, ligneJules(jules), `PR #${evt.pr} fusionnée`, acceptee, ...classeB, ...preuves]), sujets: [...tachesExclues, suite.brut?.suivante].filter(Boolean), ...dit, ...jules, ...(suite.file ? { file: suite.file } : {}) };
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
    const quoi =
      evt.evenement === 'pull_request'
        ? `PR rouge ${depot}${evt.pr ? `#${evt.pr}` : ''}, sha ${String(evt.sha).slice(0, 7)}`
        : evt.evenement === 'push'
          ? `branche par défaut rouge sur ${depot}`
          : `contrôle planifié rouge sur ${depot}`;
    return { action: 'reveiller', motif: construireMotif([quoi, `run ${evt.run}`]) };
  }
  return { action: 'rien', raison: `type inconnu : ${type}` };
}

/** Exécute la décision. `journal` reçoit les lignes à afficher ; rend un résumé court. */
export async function traiter({ pilote = null, ...options }) {
  const { api, evt, journal = console.log, maintenant = new Date() } = options;
  // Pilotage des tâches et de Jules (tâche MoKarade/.github#715) AVANT la décision : une tâche acceptée ou réservée ici change ce que la décision voit (place libérée, tâche confiée à Jules).
  const pilotage = pilote ? await pilote({ evt, maintenant }) : null;
  if (pilotage?.lignes.length) journal(`Réacteur : pilotage (${evt.type}) : ${pilotage.lignes.join(' ; ')}.`);
  for (const e of pilotage?.erreurs ?? []) journal(`::warning::Réacteur : pilotage, étape en échec : ${e}.`);
  const commun = { ...options, maintenant };
  const resultat = await traiterDecision(commun);
  // Ce que le suivi de Jules vient de voir (PR hors « Fichiers permis », PR fusionnée non acceptée seule) est dit au Coordinateur dans SON message, pour que la déduplication
  // (même texte déjà sur la boîte depuis moins de `FENETRE_FILET_H` h : rien) joue même si le pilotage n'a aucune mémoire d'un passage à l'autre.
  let signale = false;
  if (pilotage?.signaux.length) {
    const motif = construireMotif(lignesDesSignaux(pilotage.signaux));
    if (evt.forcer === 'true' || !(await dejaSignale({ api, motif, maintenant, depot: evt.depot }))) {
      await traiterDecision({ ...commun, decisionImposee: { action: 'reveiller', motif } });
      signale = true;
    }
  }
  return pilotage ? { ...resultat, pilotage, ...(signale ? { signauxDits: pilotage.signaux.length } : {}) } : resultat;
}

async function traiterDecision({ api, evt, jetonReveil, journal = console.log, maintenant = new Date(), jetonLecture = '', accepterDifferees, boites = BOITES, directes = BOITES_DIRECTES, boitePc = BOITE_PC, decisionImposee = null }) {
  const d = decisionImposee ?? await decider({ api, evt, maintenant, jetonLecture, boitePc, ...(accepterDifferees ? { accepterDifferees } : {}) });
  if (d.differees?.acceptees.length) journal(`Réacteur : preuve différée lue et acceptée automatiquement sur ${d.differees.acceptees.map((n) => `#${n}`).join(', ')} (docs/cycle-de-vie-tache.md §10 quater).`);
  if (d.differees?.erreur) journal(`::warning::Réacteur : preuves différées non lues (${d.differees.erreur}). Un fil prouvera.`);
  if (d.acceptation?.statut === 'acceptee') journal(`Réacteur : tâche #${d.acceptation.tache} acceptée automatiquement (docs/cycle-de-vie-tache.md §10 ter).`);
  else if (d.acceptation?.statut === 'erreur') journal(`::warning::Réacteur : acceptation automatique non faite (${d.acceptation.motifs.join(' ; ')}). Un fil prouvera.`);
  if (d.julesRaison) journal(`Réacteur : Jules n'a rien pris dans ${evt.depot} (${d.julesRaison}).`);
  if (d.jules) journal(`Réacteur : tâche #${d.jules.n} de ${evt.depot} confiée à Jules (docs/cycle-de-vie-tache.md §5 quater).`);
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
    // Aucun réveil ici : le Coordinateur n'est pas dérangé par une PR qui s'ouvre ou qu'on pousse.
    if (!jetonReveil) {
      journal('::warning::Réacteur : balayage impossible, le secret REVEIL_TOKEN est absent (PR d’un fork, ou secret pas encore posé).');
      return { ...d, balayages: [] };
    }
    return { ...d, balayages: await lancerBalayages({ api, jetonReveil, journal, workflows: d.workflows ?? WORKFLOWS_PR_OUVERTE }) };
  }
  if (!jetonReveil) {
    const locale = await reveilLocal({ api, evt, texte: d.motif, journal });
    if (locale) {
      journal(`Réacteur : sans REVEIL_TOKEN, fil de ${evt.depot} réveillé sur sa boîte locale #${locale} (${d.motif})`);
      return { ...d, reveille: true, locale };
    }
    journal('::warning::Réacteur : réveil impossible, le secret REVEIL_TOKEN est absent (PR d’un fork, ou secret pas encore posé) et le dépôt n’a pas de boîte locale.');
    const alerte = await signalerSansJeton({ api, evt, journal });
    return { ...d, reveille: false, ...(alerte ? { alerte } : {}) };
  }
  // Le réveil passe en premier : un balayage qui échoue ne doit jamais le retarder.
  // Une boîte par cible : la #58 (Coordinateur) sans entrée neuve, pour qu'une ancienne version de `boite-reacteur.yml` l'accepte ; la boîte du dépôt avec `boite`.
  // Un échec sur la boîte du dépôt est un avertissement tant que la #58 a reçu le réveil ; si elle est la seule cible, l'échec remonte comme avant.
  let echecReveil = null;
  let cibles = d.cibles ?? boitesDuReveil({ evt, boites, directes });
  // Hubperso : deux fils, donc deux boîtes ; la tâche en jeu dit laquelle réveiller (seulement quand le dépôt est réveillé en direct par sa boîte).
  if (!d.cibles && evt.depot === DEPOT_PAGE_CHANTIER && boites[evt.depot] && directes.has(evt.depot) && TYPES_POUR_LE_FIL.has(evt.type)) {
    const apres = await boitesDuDepotAvecChantier({ sujets: d.sujets, lire: (n) => api('GET', `/repos/${evt.depot}/issues/${n}`), boiteDepot: boites[evt.depot] });
    cibles = apres;
  }
  const reveilles = [];
  for (const numero of cibles) {
    try {
      await api(
        'POST',
        `/repos/${DEPOT_BOITE}/actions/workflows/${WORKFLOW_BOITE}/dispatches`,
        { ref: 'main', inputs: numero === NUMERO_BOITE ? { texte: d.motif } : { texte: d.motif, boite: String(numero) } },
        jetonReveil,
      );
      reveilles.push(numero);
    } catch (e) {
      if (numero !== NUMERO_BOITE && cibles.length > 1) journal(`::warning::Réacteur : boîte #${numero} de ${evt.depot} non réveillée (${e.message}).`);
      else echecReveil = e;
    }
  }
  if (reveilles.includes(NUMERO_BOITE)) journal(`Réacteur : Coordinateur réveillé (${d.motif})`);
  for (const n of reveilles.filter((x) => x !== NUMERO_BOITE)) journal(`Réacteur : fil de ${evt.depot} réveillé sur sa boîte #${n} (${d.motif})`);
  const balayages = TYPES_BALAYAGE.has(evt.type) ? await lancerBalayages({ api, jetonReveil, journal }) : [];
  if (reveilles.length > 0) await leverSansJeton({ api, evt, journal });
  if (echecReveil) throw echecReveil;
  return { ...d, reveille: true, balayages };
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
    // `gh` (CLI du job) lit `GH_TOKEN` : le pilotage des tâches et de Jules écrit avec le jeton du job, jamais avec celui du réveil.
    process.env.GH_TOKEN ||= env.GITHUB_TOKEN;
    const r = await traiter({ api: apiGitHub(env.GITHUB_TOKEN), evt, jetonReveil: env.REVEIL_TOKEN, jetonLecture: env.GITHUB_TOKEN, pilote: piloteDuJob() });
    // Une étape du pilotage en échec rend le run rouge APRÈS le réveil : `signaler-echec.yml` ouvre alors l'issue `boucle:erreur` (rien ne se perd en silence).
    if (r?.pilotage?.erreurs.length) process.exitCode = 1;
  } catch (e) {
    // Jamais de rouge : un échec ici ne doit pas se rejouer. Le filet de 6 h du Coordinateur reprend la main.
    console.log(`::warning::Réacteur : réveil non fait (${e.message}). Le filet de 6 h reprend la main.`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
