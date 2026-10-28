#!/usr/bin/env node
// Lie sur GitHub ce que les tâches écrivent déjà dans leur ligne `**Attend**` (MoKarade/.github, demande de Marc du 19/10/2026) :
// « une tâche qui dépend d'une autre doit y être visiblement liée ». GitHub n'affiche « Bloquée par » que pour une dépendance NATIVE ;
// le script de la file (`prochaine-tache.mjs`, `liens_manquants`) liste celles qui manquent, celui-ci les crée.
// Idempotent (un lien déjà posé n'est pas un échec), jamais destructif (il ne retire rien), ne lève jamais : un échec se lit dans le résultat.
// Fonctions pures d'un côté (`analyserLien`, `lierTout`), I/O de l'autre (`main`, `gh`).
//
// Usage : node scripts/lier-taches.mjs prochaines.json [--a-blanc]

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORG = 'MoKarade';

/** « memoryai#93 » ou « .github#16 » -> { depot, n }, ou null si la forme est illisible. */
export function analyserLien(reference) {
  const m = /^([\w.-]+)#(\d+)$/.exec(String(reference ?? '').trim());
  return m ? { depot: m[1], n: Number(m[2]) } : null;
}

/**
 * Pose chaque lien { ref, attend } : `ref` est bloquée par `attend`. `gh(methode, chemin, corps)` rend l'objet JSON de la réponse ou lève une erreur.
 * @returns {{ faits: string[], deja: string[], echecs: { lien: string, raison: string }[] }}
 */
export function lierTout(liens, gh, { aBlanc = false } = {}) {
  const resultat = { faits: [], deja: [], echecs: [] };
  const ids = new Map();
  const identifiant = (cible) => {
    const cle = `${cible.depot}#${cible.n}`;
    if (!ids.has(cle)) ids.set(cle, gh('GET', `repos/${ORG}/${cible.depot}/issues/${cible.n}`).id);
    return ids.get(cle);
  };
  for (const { ref, attend } of liens) {
    const nom = `${ref} <- ${attend}`;
    const tache = analyserLien(ref);
    const bloqueur = analyserLien(attend);
    if (!tache || !bloqueur) { resultat.echecs.push({ lien: nom, raison: 'référence illisible' }); continue; }
    if (aBlanc) { resultat.faits.push(nom); continue; }
    try {
      gh('POST', `repos/${ORG}/${tache.depot}/issues/${tache.n}/dependencies/blocked_by`, { issue_id: identifiant(bloqueur) });
      resultat.faits.push(nom);
    } catch (e) {
      const raison = String(e?.message ?? e);
      // Déjà lié : GitHub répond 422 « already exists » ; le lien est là, c'est le but.
      if (/already|exist|déjà/i.test(raison)) resultat.deja.push(nom);
      else resultat.echecs.push({ lien: nom, raison: raison.slice(0, 200) });
    }
  }
  return resultat;
}

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

function main() {
  const [fichier, ...options] = process.argv.slice(2);
  if (!fichier) { console.error('usage : node scripts/lier-taches.mjs prochaines.json [--a-blanc]'); process.exit(2); }
  const prochaines = JSON.parse(readFileSync(fichier, 'utf8'));
  const r = lierTout(prochaines.liens_manquants ?? [], ghCli, { aBlanc: options.includes('--a-blanc') });
  console.log(`liens : ${r.faits.length} posé(s), ${r.deja.length} déjà là, ${r.echecs.length} échec(s)`);
  for (const e of r.echecs) console.log(`  ÉCHEC ${e.lien} : ${e.raison}`);
  process.exit(r.echecs.length ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
