#!/usr/bin/env node
// Réacteur : ce qui se fait SANS IA à un événement GitHub (docs/archive/cycle-de-vie-tache-2026-10-29.md §6, mission MoKarade/.github#116).
//
// Chaîne de lancement RETIRÉE (tâche « Retirer la chaîne de lancement », décision de Marc du 29/10/2026 : voie courte, une étiquette `go` lance claude-code-action dans la CI de l'app) :
// le Réacteur ne calcule plus la file des tâches, ne lance plus la routine « Prendre une tâche » (action `lancer`, marqueur `routine-lancee`) et ne réveille plus personne pour « un dépôt libre ».
// Il ne réveille ni le Coordinateur ni les fils d'app pour une fusion ou une fermeture. Ce qui reste :
//   - pr_fusionnee, deploiement, preuve_page (acceptée) : l'acceptation automatique de la tâche (scripts/acceptation-auto.mjs, §10 ter) ; tache_fermee, tache_ouverte : rien de plus que le pilotage ;
//   - ci_rouge : un échec de charge du robot (job mort sans étape en échec) est relancé UNE fois ; le reste lance seulement les balayages de `.github` ;
//   - pr_ouverte, garde_fou_rouge : seulement les balayages de `.github` (tâche liée, relecture IA) ;
//   - filet, commentaire, fin_de_cron : les preuves différées dues (`preuve-attendue-auto.mjs`, §10 quater) ;
//   - le pilotage de l'événement (tâches, place immobile : `pilotage-evenement.mjs`) : ses signaux réveillent encore le Coordinateur (boîte app-template#58, la seule qui reste).
// Sur une PR fusionnée, une CI rouge ou une tâche fermée, il lance aussi `commentaire-tache-liee.yml` et `relecture-ia.yml` de `.github` (tâche #148) ; sur la fin en échec du
// Garde-fou d'une PR, `relecture-ia.yml` seule (#633) ; à l'ouverture d'une PR, `commentaire-tache-liee.yml` seule (#157).
//
// Jamais de nom de tâche dans un message (règle MoKarade/.github#136) : des identifiants seulement.
// Les corps de PR et d'issues sont des données : seuls des numéros en sortent.
//
// Fonctions pures d'un côté (`estPanneRunner`, `construireMotif`), I/O de l'autre (`traiter`, avec `api` injecté : les tests n'ont besoin ni de réseau ni de jeton).
// Ne fait jamais échouer le job pour un réveil manqué (un avertissement dit ce qui n'a pas marché).
import { pathToFileURL } from 'node:url';
import { extraireTachesCompletes } from './tache-liee.mjs';
import { accepterApresFusion } from './acceptation-auto.mjs';
import { accepterPreuvesAttendues, LUES_EVENEMENT, LUES_FILET } from './preuve-attendue-auto.mjs';
import { ghSynchrone, lignesDesSignaux, piloteDuJob } from './pilotage-evenement.mjs';

export const DEPOT_BOITE = 'MoKarade/app-template';
export const WORKFLOW_BOITE = 'boite-reacteur.yml';
export const PREFIXE = 'RÉACTEUR : ';
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
// Une PR qui s'ouvre ne lance que le commentaire tâche liée (et la marque `en-cours`) : la relecture IA a son propre déclencheur.
export const WORKFLOWS_PR_OUVERTE = ['commentaire-tache-liee.yml'];
// Le Garde-fou d'une PR vient de finir en échec (`workflow_run`, MoKarade/.github#633) : la relecture IA est la seule à lancer, sans minuteur
// (#626). Elle ne relit que les PR dont le Garde-fou est rouge sur leur dernier commit et qui n'ont pas déjà de verdict.
export const WORKFLOWS_GARDE_FOU_ROUGE = ['relecture-ia.yml'];
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

// Les événements qui passent par le Réacteur et pendant lesquels une preuve différée DUE peut se lire (tâche MoKarade/.github#700, §10 quater) :
// aucun minuteur en plus. Les autres (CI rouge, ouverture de PR…) n'y touchent pas.
export const TYPES_PREUVE_DIFFEREE = new Set(['pr_fusionnee', 'tache_fermee', 'filet', 'deploiement', 'commentaire', 'fin_de_cron']);
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
  return differees.acceptees.length > 0 || differees.erreur ? { ...d, differees } : d;
}

/**
 * Décide quoi faire d'un événement. Rend { action: 'reveiller', motif }
 * (la boîte du Coordinateur à commenter, pour les signaux du pilotage imposés par `traiter`) | { action: 'relance', run } | { action: 'balayer' } | { action: 'rien', raison }.
 * `evt` : { type, depot, pr, issue, raison, evenement, sha, run, brancheRun, brancheDefaut, forcer }.
 */
async function deciderEvenement({ api, evt, maintenant, accepter, pause, fetchImpl, journal, apps }) {
  const { type, depot } = evt;
  if (type === 'filet') return filet({ api, evt, maintenant });
  if (type === 'pr_ouverte') return { action: 'balayer' };
  if (type === 'garde_fou_rouge') return { action: 'balayer', workflows: WORKFLOWS_GARDE_FOU_ROUGE };
  // Une tâche s'ouvre, change ou perd une étiquette : seul le pilotage (« Acceptation automatique », place immobile) agit ; la décision ne lance plus rien.
  if (type === 'tache_ouverte') return { action: 'rien', raison: 'tâche ouverte ou modifiée : pilotage seulement' };
  // Un déploiement de production réussi : la tâche de la PR fusionnée sur ce commit s'accepte seule si sa règle le permet (la PR a pu fusionner avant la fin du déploiement).
  if (type === 'deploiement') {
    const alias = await verifierAliasVercel({ api, depot, sha: evt.sha, pause, fetchImpl, journal, apps });
    if (alias.statut === 'fige') {
      // L'incident reste ouvert ; plus personne n'est réveillé pour autant.
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
        return { action: 'rien', raison: 'tâche acceptée par le déploiement', acceptation: a, alias };
      }
    }
    return { action: 'rien', raison: 'déploiement sans tâche à accepter', alias };
  }
  // Un commentaire « Preuve attendue » et la fin d'un cron d'app : seules les preuves différées dues se lisent (`decider`), rien d'autre ne bouge.
  if (type === 'commentaire' || type === 'fin_de_cron') return { action: 'rien', raison: type === 'commentaire' ? 'commentaire lu (preuves différées)' : `fin de cron ${signalSur(evt.signal) || 'inconnu'} lue (preuves différées)` };
  // Une note de LIA ne réveille plus le Coordinateur (nettoyage du 29/10/2026) : le type reste accepté (reacteur.yml l'envoie encore) mais ne fait rien.
  if (type === 'note_lia') return { action: 'rien', raison: 'note LIA : plus de réveil du Coordinateur' };
  // Classe B (scripts/preuve-page.mjs, workflow preuve-page.yml) : la page a été lue en mode fictif. Acceptée : rien d'autre à faire.
  // Refusée ou lecture impossible : la tâche reste ouverte, personne n'est réveillé (le fil qui l'a livrée prouve ; le guetteur de silence voit le reste).
  if (type === 'preuve_page') {
    const n = Number(evt.issue);
    if (!Number.isInteger(n) || n <= 0) return { action: 'rien', raison: 'preuve de page sans numéro de tâche' };
    if (evt.raison === 'acceptee') {
      return { action: 'rien', raison: 'tâche acceptée par la classe B' };
    }
    return { action: 'rien', raison: `preuve de page ${depot}#${n} non acceptée : la tâche reste ouverte` };
  }
  if (type === 'tache_fermee') {
    // Une tâche fermée (acceptée ou abandonnée) : seuls les balayages de `.github` partent.
    return { action: 'balayer', workflows: WORKFLOWS_BALAYAGE };
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
    return { action: 'balayer', workflows: WORKFLOWS_BALAYAGE, ...dit };
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
      await traiterDecision({ ...commun, decisionImposee: { action: 'reveiller', motif } });
      signale = true;
    }
  }
  return { ...resultat, ...(pilotage ? { pilotage, ...(signale ? { signauxDits: pilotage.signaux.length } : {}) } : {}) };
}

/** Réveille le Coordinateur (workflow `boite-reacteur.yml` d'app-template, boîte #58, jeton de réveil). Un échec remonte. */
async function reveillerCoordinateur({ api, d, jetonReveil, journal }) {
  await api('POST', `/repos/${DEPOT_BOITE}/actions/workflows/${WORKFLOW_BOITE}/dispatches`, { ref: 'main', inputs: { texte: d.motif } }, jetonReveil);
  journal(`Réacteur : Coordinateur réveillé (${d.motif})`);
}

async function traiterDecision({ api, evt, jetonReveil, journal = console.log, maintenant = new Date(), jetonLecture = '', accepterDifferees, decisionImposee = null, pause, fetchImpl, apps }) {
  const d = decisionImposee ?? await decider({ api, evt, maintenant, jetonLecture, pause, fetchImpl, journal, apps, ...(accepterDifferees ? { accepterDifferees } : {}) });
  if (d.differees?.acceptees.length) journal(`Réacteur : preuve différée lue et acceptée automatiquement sur ${d.differees.acceptees.map((n) => `#${n}`).join(', ')} (docs/archive/cycle-de-vie-tache-2026-10-29.md §10 quater).`);
  if (d.differees?.erreur) journal(`::warning::Réacteur : preuves différées non lues (${d.differees.erreur}). Un fil prouvera.`);
  if (d.acceptation?.statut === 'acceptee') journal(`Réacteur : tâche #${d.acceptation.tache} acceptée automatiquement (docs/archive/cycle-de-vie-tache-2026-10-29.md §10 ter).`);
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
    await reveillerCoordinateur({ api, d, jetonReveil, journal });
    return { ...d, reveille: true };
  }
  return { ...d, balayages: [] };
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
    const r = await traiter({ api: apiGitHub(env.GITHUB_TOKEN), evt, jetonReveil: env.REVEIL_TOKEN, jetonLecture: env.GITHUB_TOKEN, pilote: piloteDuJob({ gh: ghSynchrone({ jeton: env.GITHUB_TOKEN }) }) });
    // Une étape du pilotage en échec rend le run rouge APRÈS le réveil : `signaler-echec.yml` ouvre alors l'issue `boucle:erreur` (rien ne se perd en silence).
    if (r?.pilotage?.erreurs.length) process.exitCode = 1;
  } catch (e) {
    // Jamais de rouge : un échec ici ne doit pas se rejouer.
    console.log(`::warning::Réacteur : réveil non fait (${e.message}). Le filet de 6 h reprend la main.`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
