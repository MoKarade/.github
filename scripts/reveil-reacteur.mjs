#!/usr/bin/env node
// Réveil du Coordinateur par un événement GitHub, SANS IA (docs/cycle-de-vie-tache.md §6, mission MoKarade/.github#116).
//
// Remplace la routine « Réacteur » (session Claude lancée à chaque événement). Tout ce qu'elle faisait de mécanique
// est ici, en code testé :
//   - pr_fusionnee : « D libre », et « preuve à poser sur D#n » si la tâche citée n'a ni « Acceptée » ni `preuve-attendue` ;
//   - tache_fermee : « D libre » (le garde-fou de preuve a déjà validé la fermeture, voir reacteur.yml) ;
//   - ci_rouge : PR encore ouverte, hors brouillon, au même commit, sinon rien ; un échec de charge du robot (job mort
//     sans étape en échec) est relancé UNE fois et ne réveille personne ; le reste réveille.
// Puis il lance `boite-reacteur.yml` d'app-template, qui commente la boîte (app-template#58) en `github-actions[bot]` :
// ce commentaire réveille le Coordinateur (un commentaire du compte de Marc ne réveille personne).
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
 * Décide quoi faire d'un événement. Rend { action: 'reveiller', motif } | { action: 'relance', run } | { action: 'rien', raison }.
 * `evt` : { type, depot, pr, issue, raison, evenement, sha, run, brancheRun, brancheDefaut }.
 */
export async function decider({ api, evt }) {
  const { type, depot } = evt;
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
export async function traiter({ api, evt, jetonReveil, journal = console.log }) {
  const d = await decider({ api, evt });
  if (d.action === 'rien') {
    journal(`Réacteur : rien à faire (${d.raison}).`);
    return d;
  }
  if (d.action === 'relance') {
    await api('POST', `/repos/${evt.depot}/actions/runs/${d.run}/rerun-failed-jobs`);
    journal(`Réacteur : échec de charge du robot, jobs relancés une fois (run ${d.run}), personne n'est réveillé.`);
    return d;
  }
  if (!jetonReveil) {
    journal('::warning::Réacteur : réveil impossible, le secret REVEIL_TOKEN est absent (PR d’un fork, ou secret pas encore posé).');
    return { ...d, reveille: false };
  }
  await api(
    'POST',
    `/repos/${DEPOT_BOITE}/actions/workflows/${WORKFLOW_BOITE}/dispatches`,
    { ref: 'main', inputs: { texte: d.motif } },
    jetonReveil,
  );
  journal(`Réacteur : Coordinateur réveillé (${d.motif})`);
  return { ...d, reveille: true };
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
  };
  try {
    await traiter({ api: apiGitHub(env.GITHUB_TOKEN), evt, jetonReveil: env.REVEIL_TOKEN });
  } catch (e) {
    // Jamais de rouge : un échec ici ne doit pas se rejouer. Le filet de 6 h du Coordinateur reprend la main.
    console.log(`::warning::Réacteur : réveil non fait (${e.message}). Le filet de 6 h reprend la main.`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
