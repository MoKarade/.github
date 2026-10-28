#!/usr/bin/env node
// Un échec de pilotage devient une issue `boucle:erreur`, donc une barre dans les graphes du chantier (docs/boucle-erreur.md, mission MoKarade/.github#703, tâche #714).
//
// Demande de Marc (28/10/2026) : « rien ne se perd, aucun oubli, aucune erreur inconnue, tout dans les graphes de chantier, tout à jour tout le temps ».
// Un workflow de pilotage (Réacteur, preuve, relecture, acceptation…) peut échouer sans que personne le voie : la ligne rouge reste dans Actions.
// `signaler-echec.yml` écoute la fin de ces workflows et appelle ce script avec l'issue du dépôt qui l'a vu :
//   - premier échec  : ouvre UNE issue `boucle:erreur` « Échec : <workflow> dans <dépôt> » (lien du run, job et étape en échec, jamais un secret) ;
//   - échec suivant  : un commentaire sur l'issue ouverte, jamais une seconde issue ;
//   - succès suivant : un commentaire, puis l'issue est fermée.
// Le signalement ne se signale pas lui-même, et un signalement qui échoue ne fait rien d'autre qu'un avertissement : il ne fait jamais échouer le job.
//
// Fonctions pures d'un côté (`nettoyer`, `titreDe`, `choisirAction`, `corpsDeLEchec`), I/O de l'autre (`signaler`, avec `api` injecté).
import { pathToFileURL } from 'node:url';

export const LABEL = 'boucle:erreur';
export const NOM_DU_SIGNALEMENT = 'Signaler un échec';
export const CONCLUSIONS_ECHEC = new Set(['failure', 'timed_out']);
const LONGUEUR_MAX = 160;
// Tout ce qui ressemble à un jeton ou à un secret est remplacé AVANT d'écrire dans une issue (publique) : le texte d'un échec vient d'un job, pas de nous.
const SECRETS = [
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\b(?:sk|pk|xox[abprs])-[A-Za-z0-9-]{16,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b(?:token|secret|password|mot de passe|apikey|api_key|authorization)\s*[:=]\s*\S+/gi,
  /\b[A-Fa-f0-9]{32,}\b/g,
  /\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g,
];

/** Une ligne courte, sans secret ni retour à la ligne : ce qu'on peut écrire dans une issue publique. */
export function nettoyer(texte, max = LONGUEUR_MAX) {
  let t = String(texte ?? '').replace(/[\r\n\t]+/g, ' ');
  for (const motif of SECRETS) t = t.replace(motif, '[retiré]');
  t = t.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Le titre de l'issue : une par couple (dépôt, workflow). */
export function titreDe({ depot, workflow }) {
  return `Échec : ${nettoyer(workflow, 80)} dans ${nettoyer(depot, 80)}`;
}

/**
 * Que faire d'une fin de workflow ? `ouverte` : l'issue `boucle:erreur` ouverte de ce titre, ou null.
 * Rend 'ouvrir' | 'commenter' | 'fermer' | 'rien'. Un run annulé, ignoré ou neutre ne dit rien ; le signalement lui-même est ignoré.
 */
export function choisirAction({ workflow, conclusion, ouverte }) {
  if (workflow === NOM_DU_SIGNALEMENT) return 'rien';
  if (CONCLUSIONS_ECHEC.has(conclusion)) return ouverte ? 'commenter' : 'ouvrir';
  if (conclusion === 'success') return ouverte ? 'fermer' : 'rien';
  return 'rien';
}

/** « job X, étape Y » du premier job en échec, ou vide : des noms, pas des journaux (un journal peut porter un secret). */
export function ligneDEchec(jobs) {
  const rouge = (jobs ?? []).find((j) => CONCLUSIONS_ECHEC.has(j.conclusion));
  if (!rouge) return '';
  const etape = (rouge.steps ?? []).find((s) => CONCLUSIONS_ECHEC.has(s.conclusion));
  return nettoyer(etape ? `job « ${rouge.name} », étape « ${etape.name} »` : `job « ${rouge.name} »`);
}

/** Le corps d'un échec (issue ou commentaire) : le run, le commit, la ligne d'échec. Aucun texte libre d'un tiers. */
export function corpsDeLEchec({ depot, workflow, runId, runUrl, sha, ligne, conclusion }) {
  const lien = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+/.test(String(runUrl)) ? runUrl : `https://github.com/${depot}/actions/runs/${runId}`;
  return [
    `**${nettoyer(workflow, 80)}** a fini en échec (${nettoyer(conclusion, 20)}) dans ${nettoyer(depot, 80)}.`,
    '',
    `- Run : ${lien}`,
    /^[0-9a-f]{7,64}$/i.test(String(sha ?? '')) ? `- Commit : \`${String(sha).slice(0, 7)}\`` : '',
    ligne ? `- Où : ${ligne}` : '',
    '',
    `Cette issue se referme toute seule au prochain succès de ce workflow (docs/boucle-erreur.md). Étiquette \`${LABEL}\`.`,
  ].filter((l, i, tab) => !(l === '' && tab[i - 1] === '')).join('\n');
}

/** Exécute l'action pour une fin de workflow. Rend { action, issue? }. Ne lève jamais : l'échec du signalement est un avertissement. */
export async function signaler({ api, depot, workflow, conclusion, runId, runUrl, sha, journal = console.log }) {
  try {
    const titre = titreDe({ depot, workflow });
    const lot = (await api('GET', `/repos/${depot}/issues?labels=${encodeURIComponent(LABEL)}&state=open&per_page=100`)) ?? [];
    const ouverte = lot.find((i) => !i.pull_request && i.title === titre) ?? null;
    const action = choisirAction({ workflow, conclusion, ouverte });
    if (action === 'rien') return { action };
    if (action === 'fermer') {
      await api('POST', `/repos/${depot}/issues/${ouverte.number}/comments`, { body: `Le prochain run de **${nettoyer(workflow, 80)}** a réussi (${runUrl ?? `run ${runId}`}). Fermée.` });
      await api('PATCH', `/repos/${depot}/issues/${ouverte.number}`, { state: 'closed', state_reason: 'completed' });
      journal(`Boucle : #${ouverte.number} fermée (${workflow} a réussi).`);
      return { action, issue: ouverte.number };
    }
    const jobs = await api('GET', `/repos/${depot}/actions/runs/${runId}/jobs?filter=latest&per_page=100`).catch(() => null);
    const corps = corpsDeLEchec({ depot, workflow, runId, runUrl, sha, conclusion, ligne: ligneDEchec(jobs?.jobs) });
    if (action === 'commenter') {
      await api('POST', `/repos/${depot}/issues/${ouverte.number}/comments`, { body: corps });
      journal(`Boucle : nouvel échec de ${workflow} noté sur #${ouverte.number}.`);
      return { action, issue: ouverte.number };
    }
    const cree = await api('POST', `/repos/${depot}/issues`, { title: titre, body: corps, labels: [LABEL] });
    journal(`Boucle : issue #${cree?.number} ouverte pour l'échec de ${workflow}.`);
    return { action, issue: cree?.number ?? null };
  } catch (e) {
    journal(`::warning::Boucle : échec non signalé (${nettoyer(e.message)}). Le run reste rouge dans Actions.`);
    return { action: 'rien', erreur: e.message };
  }
}

function apiGitHub(jeton) {
  return async function api(methode, chemin, corps) {
    const r = await fetch(`https://api.github.com${chemin}`, {
      method: methode,
      headers: { authorization: `Bearer ${jeton}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json', 'user-agent': 'boucle-erreur' },
      body: corps ? JSON.stringify(corps) : undefined,
    });
    if (r.status === 404 && methode === 'GET') return null;
    if (!r.ok) throw new Error(`HTTP ${r.status} sur ${methode} ${chemin}`);
    return r.status === 204 ? null : r.json();
  };
}

export async function main(env = process.env) {
  await signaler({
    api: apiGitHub(env.GITHUB_TOKEN),
    depot: env.BOUCLE_DEPOT,
    workflow: env.BOUCLE_WORKFLOW,
    conclusion: env.BOUCLE_CONCLUSION,
    runId: env.BOUCLE_RUN_ID,
    runUrl: env.BOUCLE_RUN_URL,
    sha: env.BOUCLE_SHA,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
