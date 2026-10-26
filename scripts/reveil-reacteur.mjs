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

async function filet({ api, evt, maintenant }) {
  const lignes = await lignesDuFiletPour({ api, evt, maintenant });
  if (lignes.length === 0) return { action: 'rien', raison: 'rien à signaler' };
  const motif = construireMotif(lignes);
  // « forcer » (lancement manuel) repose le réveil même si le même signal vient d'être posté : c'est une demande d'essai.
  if (evt.forcer !== 'true' && (await dejaSignale({ api, motif, maintenant }))) {
    return { action: 'rien', raison: `déjà signalé sur la boîte dans les ${FENETRE_FILET_H} dernières heures` };
  }
  return { action: 'reveiller', motif };
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

/** « D libre » sans travail, « D : une place libre » avec un seul ; rien quand les deux places sont prises. */
export function signeLibre(depot, travauxEnCours) {
  if (travauxEnCours <= 0) return `${depot} libre`;
  if (travauxEnCours < PLACES_PAR_DEPOT) return `${depot} : une place libre`;
  return '';
}

/**
 * Décide quoi faire d'un événement. Rend { action: 'reveiller', motif } | { action: 'relance', run } | { action: 'balayer' } | { action: 'rien', raison }.
 * `evt` : { type, depot, pr, issue, raison, evenement, sha, run, brancheRun, brancheDefaut, forcer }.
 */
export async function decider({ api, evt, maintenant = new Date(), accepter = accepterApresFusion }) {
  const { type, depot } = evt;
  if (type === 'filet') return filet({ api, evt, maintenant });
  if (type === 'pr_ouverte') return { action: 'balayer' };
  if (type === 'garde_fou_rouge') return { action: 'balayer', workflows: WORKFLOWS_GARDE_FOU_ROUGE };
  if (type === 'tache_fermee') {
    const abandon = evt.raison === 'not_planned' ? ' (abandonnée : vérifier la raison)' : '';
    const en = await travaux({ api, depot });
    // Un dépôt dont les deux places sont prises n'a rien de neuf à dire, sauf une tâche abandonnée dont il faut vérifier la raison.
    if (en >= PLACES_PAR_DEPOT && !abandon) return { action: 'rien', raison: 'dépôt encore occupé' };
    return { action: 'reveiller', motif: construireMotif([signeLibre(depot, en), `tâche ${depot}#${evt.issue} fermée${abandon}`]) };
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
    for (const t of taches) {
      const cle = `${t.depot}#${t.numero}`;
      const issue = await api('GET', `/repos/${t.depot}/issues/${t.numero}`).catch(() => null);
      if (preuveAPoser({ issue, commentaires: issue ? await commentairesDe(api, t.depot, t.numero).catch(() => []) : [] })) {
        preuves.push(`preuve à poser sur ${cle}`);
      }
    }
    const tachesExclues = taches.filter((t) => t.depot === depot).map((t) => t.numero);
    const en = await travaux({ api, depot, tachesExclues });
    // Dépôt dont les deux places sont prises et rien à prouver : la fusion n'apprend rien au Coordinateur.
    if (en >= PLACES_PAR_DEPOT && preuves.length === 0) return { action: 'rien', raison: 'dépôt encore occupé', ...dit };
    const acceptee = acceptation.statut === 'acceptee' ? `tâche ${depot}#${acceptation.tache} acceptée seule` : '';
    return { action: 'reveiller', motif: construireMotif([signeLibre(depot, en), `PR #${evt.pr} fusionnée`, acceptee, ...preuves]), ...dit };
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
export async function traiter({ api, evt, jetonReveil, journal = console.log, maintenant = new Date() }) {
  const d = await decider({ api, evt, maintenant });
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
    // Aucun réveil ici : le Coordinateur n'est pas dérangé par une PR qui s'ouvre ou qu'on pousse.
    if (!jetonReveil) {
      journal('::warning::Réacteur : balayage impossible, le secret REVEIL_TOKEN est absent (PR d’un fork, ou secret pas encore posé).');
      return { ...d, balayages: [] };
    }
    return { ...d, balayages: await lancerBalayages({ api, jetonReveil, journal, workflows: d.workflows ?? WORKFLOWS_PR_OUVERTE }) };
  }
  if (!jetonReveil) {
    journal('::warning::Réacteur : réveil impossible, le secret REVEIL_TOKEN est absent (PR d’un fork, ou secret pas encore posé).');
    return { ...d, reveille: false };
  }
  // Le réveil passe en premier : un balayage qui échoue ne doit jamais le retarder.
  let echecReveil = null;
  try {
    await api(
      'POST',
      `/repos/${DEPOT_BOITE}/actions/workflows/${WORKFLOW_BOITE}/dispatches`,
      { ref: 'main', inputs: { texte: d.motif } },
      jetonReveil,
    );
    journal(`Réacteur : Coordinateur réveillé (${d.motif})`);
  } catch (e) {
    echecReveil = e;
  }
  const balayages = TYPES_BALAYAGE.has(evt.type) ? await lancerBalayages({ api, jetonReveil, journal }) : [];
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
  };
  try {
    await traiter({ api: apiGitHub(env.GITHUB_TOKEN), evt, jetonReveil: env.REVEIL_TOKEN });
  } catch (e) {
    // Jamais de rouge : un échec ici ne doit pas se rejouer. Le filet de 6 h du Coordinateur reprend la main.
    console.log(`::warning::Réacteur : réveil non fait (${e.message}). Le filet de 6 h reprend la main.`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
