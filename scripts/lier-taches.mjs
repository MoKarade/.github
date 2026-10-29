#!/usr/bin/env node
// Lecture de GitHub par la CLI `gh` du PC, avec le cache ETag (.github#741). Le calcul des liens « Attend » -> « Bloquée par » (`lierTout`, lu dans `prochaines.json`)
// a été retiré avec la file calculée (chaîne de lancement, nettoyage du 29/10/2026) ; ne restent que `ghCli` et ses compteurs, utilisés par `filet-pc.mjs` et `jules-suivi.mjs`.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const ORG = 'MoKarade';

// Cache ETag des lectures (.github#741), le MÊME que `outils/gantt-pc/ghcache.py` (dossier et nom de fichier identiques, `{ etag, corps }`) : une réponse 304
// ne consomme rien sur la limite REST du jeton du PC, et le tour du PC relit chaque dépôt toutes les 10 min. Actif seulement si GANTT_CACHE_HTTP désigne un dossier
// (posé par tour.py sur le PC) : ailleurs (Actions, tests) rien ne change. Seuls les GET sans corps passent par lui ; jamais une écriture.
export const EXEC = { run: execFileSync };
const STATS = { req: 0, n304: 0, n200: 0, erreurs: 0 };
export const compteursGh = () => ({ ...STATS, comptees: STATS.n200 + STATS.erreurs });
const dossierCache = () => { const d = process.env.GANTT_CACHE_HTTP; return d && d !== 'off' ? d : null; };
const fichierCache = (dossier, chemin) => join(dossier, `${createHash('sha1').update(`${chemin}|`).digest('hex')}.json`);

/** Sortie de `gh api -i` -> { statut, entetes (minuscules), corps }. */
export function analyserReponse(sortie) {
  const m = /^\s*HTTP\/[\d.]+\s+(\d+)/.exec(sortie ?? '');
  if (!m) return { statut: null, entetes: {}, corps: sortie ?? '' };
  const [tete, ...reste] = sortie.split(/\r?\n\r?\n/);
  const entetes = {};
  for (const ligne of tete.split(/\r?\n/).slice(1)) { const i = ligne.indexOf(':'); if (i > 0) entetes[ligne.slice(0, i).trim().toLowerCase()] = ligne.slice(i + 1).trim(); }
  return { statut: Number(m[1]), entetes, corps: reste.join('\n\n') };
}

function lireAvecCache(dossier, chemin) {
  const f = fichierCache(dossier, chemin);
  let cache = null;
  try { cache = JSON.parse(readFileSync(f, 'utf8')); } catch { /* pas de cache : première lecture */ }
  const args = ['api', '-i', chemin, ...(cache?.etag && cache.corps != null ? ['-H', `If-None-Match: ${cache.etag}`] : [])];
  let sortie;
  let echec = null;
  STATS.req += 1;
  try {
    sortie = EXEC.run('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    sortie = String(e.stdout ?? '');   // gh sort en erreur sur un 304 comme sur un 4xx : le statut est dans la sortie
    echec = e;
  }
  const { statut, entetes, corps } = analyserReponse(sortie);
  if (statut === 304 && cache?.corps != null) {
    STATS.n304 += 1;
    return cache.corps.trim() ? JSON.parse(cache.corps) : {};
  }
  if (statut !== null && statut >= 200 && statut < 300 && !echec) {
    STATS.n200 += 1;
    if (entetes.etag) {
      try { mkdirSync(dossier, { recursive: true }); writeFileSync(`${f}.tmp`, JSON.stringify({ etag: entetes.etag, corps })); renameSync(`${f}.tmp`, f); } catch { /* le cache est une économie, pas une condition */ }
    }
    return corps.trim() ? JSON.parse(corps) : {};
  }
  STATS.erreurs += 1;
  throw echec ?? new Error(`gh api ${chemin} : HTTP ${statut} ${corps.slice(0, 200)}`);
}

export function ghCli(methode, chemin, corps) {
  const dossier = dossierCache();
  if (methode === 'GET' && !corps && dossier) return lireAvecCache(dossier, chemin);
  const args = ['api', '-X', methode, chemin];
  if (corps) for (const [k, v] of Object.entries(corps)) args.push('-F', `${k}=${v}`);
  STATS.req += 1;
  let sortie;
  try { sortie = EXEC.run('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { STATS.erreurs += 1; throw e; }
  STATS.n200 += 1;
  return sortie ? JSON.parse(sortie) : {};
}
