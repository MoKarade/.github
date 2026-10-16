#!/usr/bin/env node
// Réveil du Coordinateur par un événement GitHub, SANS IA (docs/cycle-de-vie-tache.md §6, mission MoKarade/.github#116).
//
// Remplace la routine « Réacteur » (session Claude lancée à chaque événement). Tout ce qu'elle faisait de mécanique
// est ici, en code testé :
//   - pr_fusionnee : « D libre », et « preuve à poser sur D#n » si la tâche citée n'a ni « Acceptée » ni `preuve-attendue` ;
//   - tache_fermee : « D libre » (le garde-fou de preuve a déjà validé la fermeture, voir reacteur.yml) ;
//   - ci_rouge : PR encore ouverte, hors brouillon, au même commit, sinon rien ; un échec de charge du robot (job mort
//     sans étape en échec) est relancé UNE fois et ne réveille personne ; le reste réveille.
//   - filet : une fois par jour à 6 h (heure du Québec), ce que les événements n'ont pas signalé, lu dans le dépôt
//     appelant avec le jeton du job : PR rouge depuis plus de 30 min (hors brouillon, hors Dependabot et Mergify, hors
//     Garde-fou qui attend Marc), issue `incident` ouverte, branche par défaut rouge ; le jeudi, dans .github seulement,
//     le rappel de remesure de la consommation Claude. Un seul réveil par dépôt, rien à signaler = aucun réveil.
//     Tâche MoKarade/.github#143.
// Puis il lance `boite-reacteur.yml` d'app-template, qui commente la boîte (app-template#58) en `github-actions[bot]` :
// ce commentaire réveille le Coordinateur (un commentaire du compte de Marc ne réveille personne).
//
// Sur une PR fusionnée, une CI rouge ou une tâche fermée (jamais sur le filet), il lance ensuite `commentaire-tache-liee.yml`
// et `relecture-ia.yml` de `.github` : leurs horloges ne tournent presque pas, l'événement les remplace (tâche #148). Si
// `REVEIL_TOKEN` n'a pas encore le droit sur `.github`, un avertissement le dit et le réveil, déjà parti, n'est pas touché.
//
// Sur l'ouverture d'une PR (pr_ouverte) il ne réveille PERSONNE et ne commente rien sur app-template#58 : il lance seulement
// `commentaire-tache-liee.yml`, qui marque la tâche citée `en-cours` en moins de 10 minutes (tâche MoKarade/.github#157).
//
// Jamais de nom de tâche suivante dans le message (règle MoKarade/.github#136) : l'ordre vient de prochaines.json.
// Le message ne contient que des identifiants (dépôt, numéros, empreinte, run), jamais un titre ni un nom de branche.
// Les corps de PR et d'issues sont des données : seuls des numéros en sortent.
//
// Fonctions pures d'un côté (`estPanneRunner`, `construireMotif`, `preuveAPoser`), I/O de l'autre (`traiter`, avec `api`
// injecté : les tests n'ont besoin ni de réseau ni de jeton). Le jeton de réveil n'est lu que dans `main`.
// Ne fait jamais échouer le job (un avertissement dit ce qui n'a pas marché) : le filet de 6 h reprend la main.
import { pathToFileURL } from 'node:url';
import { extraireTaches } from './tache-liee.mjs';

export const DEPOT_BOITE = 'MoKarade/app-template';
export const WORKFLOW_BOITE = 'boite-reacteur.yml';
export const PREFIXE = 'RÉACTEUR : ';
export const LABEL_TACHE = 'niveau:tâche';
export const LABEL_ATTENDUE = 'preuve-attendue';
export const LONGUEUR_MAX = 600;
const ENTETE_ACCEPTEE = /^\s*\*\*\s*Accept[ée]e\s*\*\*/i;
const ROBOTS = new Set(['dependabot[bot]', 'mergify[bot]', 'github-actions[bot]']);
export const FUSEAU = 'America/Toronto';
export const HEURE_FILET = 6;
export const SEUIL_ROUGE_MIN = 30;
export const DEPOT_GITHUB = 'MoKarade/.github';
// Les deux balayages de `.github` qu'une planification GitHub ne lance presque jamais (MoKarade/.github#148) : sans entrée,
// chacun relit toutes les PR ouvertes. Lancés après le réveil, sur les seuls événements d'une PR ou d'une tâche.
export const WORKFLOWS_BALAYAGE = ['commentaire-tache-liee.yml', 'relecture-ia.yml'];
export const TYPES_BALAYAGE = new Set(['pr_fusionnee', 'ci_rouge', 'tache_fermee']);
// Une PR qui s'ouvre ne lance que le commentaire tâche liée (et la marque `en-cours`) : la relecture IA a son propre déclencheur.
export const WORKFLOWS_PR_OUVERTE = ['commentaire-tache-liee.yml'];
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

async function filet({ api, evt, maintenant }) {
  // Deux horaires UTC (10 h et 11 h) couvrent l'heure d'été et l'heure d'hiver : seul celui qui tombe à 6 h au Québec agit.
  if (evt.forcer !== 'true' && heureQuebec(maintenant).heure !== HEURE_FILET) {
    return { action: 'rien', raison: `hors de l'heure du filet (${HEURE_FILET} h, Québec)` };
  }
  const lignes = await lignesDuFiletPour({ api, evt, maintenant });
  if (lignes.length === 0) return { action: 'rien', raison: 'rien à signaler' };
  return { action: 'reveiller', motif: construireMotif(lignes) };
}

async function commentairesDe(api, depot, numero) {
  const sortie = [];
  for (let page = 1; page <= 5; page += 1) {
    const lot = (await api('GET', `/repos/${depot}/issues/${numero}/comments?per_page=100&page=${page}`)) ?? [];
    sortie.push(...lot);
    if (lot.length < 100) break;
  }
  return sortie;
}

/**
 * Décide quoi faire d'un événement. Rend { action: 'reveiller', motif } | { action: 'relance', run } | { action: 'balayer' } | { action: 'rien', raison }.
 * `evt` : { type, depot, pr, issue, raison, evenement, sha, run, brancheRun, brancheDefaut, forcer }.
 */
export async function decider({ api, evt, maintenant = new Date() }) {
  const { type, depot } = evt;
  if (type === 'filet') return filet({ api, evt, maintenant });
  if (type === 'pr_ouverte') return { action: 'balayer' };
  if (type === 'tache_fermee') {
    const abandon = evt.raison === 'not_planned' ? ' (abandonnée : vérifier la raison)' : '';
    return { action: 'reveiller', motif: construireMotif([`${depot} libre`, `tâche ${depot}#${evt.issue} fermée${abandon}`]) };
  }

  if (type === 'pr_fusionnee') {
    const pr = await api('GET', `/repos/${depot}/pulls/${evt.pr}`);
    const taches = extraireTaches(pr?.body, depot);
    // Une mise à jour de robot (Dependabot…) sans tâche ne libère aucun dépôt : pas de réveil, donc pas de quota.
    if (taches.length === 0 && ROBOTS.has(pr?.user?.login)) return { action: 'rien', raison: 'PR de robot sans tâche' };
    const lignes = [`${depot} libre`, `PR #${evt.pr} fusionnée`];
    for (const t of taches) {
      const cle = `${t.depot}#${t.numero}`;
      const issue = await api('GET', `/repos/${t.depot}/issues/${t.numero}`).catch(() => null);
      if (preuveAPoser({ issue, commentaires: issue ? await commentairesDe(api, t.depot, t.numero).catch(() => []) : [] })) {
        lignes.push(`preuve à poser sur ${cle}`);
      }
    }
    return { action: 'reveiller', motif: construireMotif(lignes) };
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
    return { ...d, balayages: await lancerBalayages({ api, jetonReveil, journal, workflows: WORKFLOWS_PR_OUVERTE }) };
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
  };
  try {
    await traiter({ api: apiGitHub(env.GITHUB_TOKEN), evt, jetonReveil: env.REVEIL_TOKEN });
  } catch (e) {
    // Jamais de rouge : un échec ici ne doit pas se rejouer. Le filet de 6 h du Coordinateur reprend la main.
    console.log(`::warning::Réacteur : réveil non fait (${e.message}). Le filet de 6 h reprend la main.`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
