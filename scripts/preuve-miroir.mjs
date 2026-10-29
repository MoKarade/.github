#!/usr/bin/env node
// Preuve automatique, MODE MIROIR (option C de Marc, 29/10/2026, étape 3 ; mission MoKarade/.github#703).
//
// Sur un déploiement de production réussi, lit l'adresse du « Fini quand » de la tâche livrée par la PR fusionnée, la GET une fois, et écrit UN commentaire
// « Lecture miroir » sur la tâche : « lu : ok » ou « lu : écart ». Il ne ferme rien, n'étiquette rien, n'écrit jamais « **Acceptée** » : la preuve actuelle reste
// seule juge. L'étape 6 ne bascule qu'après 3 déploiements où le miroir et la preuve actuelle disent la même chose.
//
// Sûreté : seules les adresses de *.hubperso.com sont lues (jamais une adresse écrite dans une issue au hasard), GET sans suivre les redirections,
// aucun corps de réponse recopié (code HTTP et nom d'hôte seulement). Une panne du miroir n'est jamais un rouge.
// Fonctions pures d'un côté, I/O de l'autre (`api` et `lire` injectés : les tests n'ont besoin ni de réseau ni de jeton).
import { pathToFileURL } from 'node:url';

export const marqueur = (sha) => `<!-- preuve-miroir:${sha} -->`;
const HOTE_PERMIS = /^(?:[a-z0-9-]+\.)*hubperso\.com$/;

/** « Tâche : #12 » ou « Tâche : MoKarade/Depot#12 » dans le corps de la PR. */
export function tacheDePr(corps) {
  const m = /T[âa]che\s*:\s*(?:(?:https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+)(?:#|\/issues\/))?#?(\d+)/i.exec(corps ?? '');
  return m ? { depot: m[1] ?? null, numero: Number(m[2]) } : null;
}

/** Le texte de la ligne « Fini quand » de l'issue (jusqu'à la ligne en gras suivante). */
export function finiQuand(corps) {
  const m = /\*\*Fini quand\*\*([^\n]*)((?:\n(?!\*\*[^\n*]+\*\*)[^\n]*)*)/i.exec(corps ?? '');
  return m ? `${m[1]}${m[2]}` : '';
}

/** Les adresses de production à lire, avec le code attendu quand le texte le dit juste après (« répond 200 »). */
export function cibles(texte) {
  const trouvees = [];
  for (const m of String(texte ?? '').matchAll(/https:\/\/[^\s)`'"<>]+/g)) {
    let url;
    try {
      url = new URL(m[0].replace(/[.,;]+$/, ''));
    } catch {
      continue;
    }
    if (!HOTE_PERMIS.test(url.hostname) || url.username || url.password) continue;
    const apres = texte.slice(m.index + m[0].length, m.index + m[0].length + 40);
    const attendu = /r[ée]pond\s+(\d{3})/i.exec(apres)?.[1];
    if (!trouvees.some((t) => t.url === url.toString())) trouvees.push({ url: url.toString(), attendu: attendu ? Number(attendu) : null });
  }
  return trouvees;
}

/** Verdict d'une lecture : le code attendu s'il est écrit, sinon « répond, sans 5xx » (une redirection vers la connexion du hub est une réponse). */
export function verdict({ code, attendu }) {
  if (!Number.isInteger(code)) return { ok: false, motif: 'aucune réponse' };
  if (attendu) return code === attendu ? { ok: true } : { ok: false, motif: `HTTP ${code} au lieu de ${attendu}` };
  return code < 500 ? { ok: true } : { ok: false, motif: `HTTP ${code}` };
}

export function commentaire({ sha, pr, lectures }) {
  const court = sha.slice(0, 7);
  const lignes = lectures.map((l) => `- ${new URL(l.url).hostname}${new URL(l.url).pathname} → ${l.code ?? 'aucune réponse'} : ${l.ok ? 'ok' : `écart (${l.motif})`}`);
  const ok = lectures.length > 0 && lectures.every((l) => l.ok);
  return [
    marqueur(sha),
    `**Lecture miroir** — PR #${pr} déployée (${court}) : lu : ${ok ? 'ok' : 'écart'}`,
    ...lignes,
    '',
    'Mode miroir (option C, étape 3) : rien n’est fermé ni accepté par cette lecture ; la preuve reste celle du fil.',
  ].join('\n');
}

/**
 * @param api (chemin, { method, body }) -> JSON
 * @param lire (url) -> code HTTP (nombre), sans suivre les redirections ; rend null si la requête échoue
 * Rend { statut: 'ecrit'|'ignore', raison?, ok? }.
 */
export async function miroir({ api, lire, depot, sha }) {
  const prs = await api(`/repos/${depot}/commits/${sha}/pulls`);
  const pr = prs.find((p) => p.merged_at && p.merge_commit_sha === sha);
  if (!pr) return { statut: 'ignore', raison: 'aucune PR fusionnée pour ce commit' };
  const tache = tacheDePr(pr.body);
  if (!tache) return { statut: 'ignore', raison: 'la PR ne cite pas de tâche' };
  const depotTache = tache.depot ?? depot;
  const issue = await api(`/repos/${depotTache}/issues/${tache.numero}`);
  if (issue.pull_request || !(issue.labels ?? []).some((l) => (typeof l === 'string' ? l : l.name) === 'niveau:tâche')) return { statut: 'ignore', raison: 'pas une tâche' };
  const aLire = cibles(finiQuand(issue.body));
  if (aLire.length === 0) return { statut: 'ignore', raison: 'aucune adresse hubperso.com dans le « Fini quand »' };
  const deja = await api(`/repos/${depotTache}/issues/${tache.numero}/comments?per_page=100`);
  if (deja.some((c) => String(c.body ?? '').includes(marqueur(sha)))) return { statut: 'ignore', raison: 'déjà écrit' };

  const lectures = [];
  for (const c of aLire.slice(0, 3)) {
    const code = await lire(c.url);
    lectures.push({ url: c.url, code, ...verdict({ code, attendu: c.attendu }) });
  }
  await api(`/repos/${depotTache}/issues/${tache.numero}/comments`, { method: 'POST', body: { body: commentaire({ sha, pr: pr.number, lectures }) } });
  return { statut: 'ecrit', ok: lectures.every((l) => l.ok) };
}

const apiReelle = (jeton) => async (chemin, { method = 'GET', body } = {}) => {
  const r = await fetch(`https://api.github.com${chemin}`, {
    method,
    headers: { Authorization: `Bearer ${jeton}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`GitHub ${method} ${chemin.split('?')[0]} : HTTP ${r.status}`);
  return r.status === 204 ? null : r.json();
};

const lireReelle = async (url) => {
  for (let essai = 0; essai < 3; essai += 1) {
    try {
      return (await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20_000) })).status;
    } catch {
      await new Promise((r) => setTimeout(r, 3000 * (essai + 1)));
    }
  }
  return null;
};

async function main() {
  const { GITHUB_TOKEN, GITHUB_REPOSITORY, DEPLOY_SHA } = process.env;
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !/^[0-9a-f]{40}$/.test(DEPLOY_SHA ?? '')) throw new Error('GITHUB_TOKEN, GITHUB_REPOSITORY et DEPLOY_SHA (40 hexadécimaux) sont requis');
  const r = await miroir({ api: apiReelle(GITHUB_TOKEN), lire: lireReelle, depot: GITHUB_REPOSITORY, sha: DEPLOY_SHA });
  console.log(`Preuve miroir — ${GITHUB_REPOSITORY}@${DEPLOY_SHA.slice(0, 7)} : ${r.statut}${r.raison ? ` (${r.raison})` : ''}${r.ok === undefined ? '' : r.ok ? ' lu : ok' : ' lu : écart'}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((e) => {
    console.log(`::warning::Preuve miroir non faite (${e.message}). La preuve actuelle reste le juge.`);
  });
}
