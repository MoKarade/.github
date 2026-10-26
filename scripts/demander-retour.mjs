#!/usr/bin/env node
// Fumée rouge -> demande de retour en arrière (refonte du workflow, phase 2).
//
// Appelé par le workflow commun `fumee.yml` quand la fumée de production d'une app est rouge. Il envoie
// l'événement `fumee-rouge` à MoKarade/.github (repository_dispatch) : `surveillance.yml` s'y lance et
// `retour-arriere.mjs` ne traite que l'app dont l'URL de production figure dans l'événement. Le jeton
// (HUB_DISPATCH_TOKEN, étroit : ce seul dépôt) ne sort jamais dans un journal ; sans lui, le script le dit
// et ne fait rien (échec fermé : jamais un faux « demandé »).
//
// Fonctions pures d'un côté (`corpsEvenement`), I/O de l'autre : `appel` est injecté, les tests n'ont besoin
// d'aucun réseau.
import { pathToFileURL } from 'node:url';

export const DEPOT_CIBLE = 'MoKarade/.github';
export const TYPE_EVENEMENT = 'fumee-rouge';

/** Corps de l'événement ; lève si l'URL de production n'est pas une URL https. */
export function corpsEvenement({ urlBase, depot, sha }) {
  const u = new URL(urlBase);
  if (u.protocol !== 'https:') throw new Error('url-base doit être une URL https');
  return { event_type: TYPE_EVENEMENT, client_payload: { url_base: u.origin, depot: String(depot ?? ''), sha: String(sha ?? '').slice(0, 40) } };
}

/** Envoie l'événement ; rend { envoye, raison }. N'insère jamais le jeton dans un message. */
export async function demander({ jeton, urlBase, depot, sha, appel = fetch }) {
  if (!jeton) return { envoye: false, raison: 'secret HUB_DISPATCH_TOKEN absent : retour en arrière non demandé (il part au prochain passage de la surveillance)' };
  const r = await appel(`https://api.github.com/repos/${DEPOT_CIBLE}/dispatches`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${jeton}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
    },
    body: JSON.stringify(corpsEvenement({ urlBase, depot, sha })),
    signal: AbortSignal.timeout(15_000),
  });
  if (r.status !== 204) throw new Error(`GitHub a refusé l'événement (HTTP ${r.status})`);
  return { envoye: true, raison: `événement ${TYPE_EVENEMENT} envoyé à ${DEPOT_CIBLE}` };
}

async function main() {
  const env = process.env;
  const r = await demander({ jeton: env.DISPATCH_TOKEN, urlBase: env.FUMEE_BASE, depot: env.GITHUB_REPOSITORY, sha: env.GITHUB_SHA });
  console.log(r.envoye ? r.raison : `::warning title=Retour en arrière::${r.raison}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
