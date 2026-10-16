#!/usr/bin/env node
// Surveillance des apps (plan de standardisation, décision 11) : alerte quand une app tombe.
//
// Rôle : interroge `/api/sante` de chaque app listée dans surveillance/apps.json. Une app qui ne répond
// plus (après plusieurs essais) ouvre UNE issue `panne` dans ce dépôt, donc une notification GitHub ;
// quand elle répond de nouveau, l'issue reçoit un commentaire de retour et se ferme. Une app dont la
// route de santé n'existe pas encore est listée avec `sante: null` et sa raison : elle n'est pas sondée,
// et le résumé du job la dit « à brancher » (jamais un faux vert).
//
// Fonctions pures d'un côté (`decider`, `lireApps`, `tableau`), I/O de l'autre : `gh` est injecté, les tests
// n'ont besoin ni de réseau GitHub ni de jeton. Le jeton n'est jamais lu ici : le CLI `gh` le prend
// dans l'environnement du job.
import { execFile } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { controles, lancer } from './fumee.mjs';

export const LABEL = 'panne';
export const titrePanne = (nom) => `Panne : ${nom}`;

/** Valide la liste des apps ; rend un tableau propre ou lève avec la cause. */
export function lireApps(brut) {
  if (!Array.isArray(brut) || brut.length === 0) throw new Error('surveillance/apps.json doit être une liste non vide');
  const vus = new Set();
  return brut.map((a, i) => {
    if (typeof a?.nom !== 'string' || !/^[a-z0-9-]+$/.test(a.nom)) throw new Error(`app ${i} : nom invalide`);
    if (vus.has(a.nom)) throw new Error(`app ${a.nom} : en double`);
    vus.add(a.nom);
    if (typeof a.depot !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(a.depot)) throw new Error(`app ${a.nom} : depot invalide (propriétaire/nom)`);
    if (a.sante === null) {
      if (typeof a.raison !== 'string' || !a.raison) throw new Error(`app ${a.nom} : sante null sans raison`);
      return { nom: a.nom, depot: a.depot, sante: null, raison: a.raison };
    }
    if (typeof a.sante !== 'string' || !/^https:\/\//.test(a.sante)) throw new Error(`app ${a.nom} : sante doit être une URL https`);
    // `vercel` (facultatif) : nom du projet Vercel, utilisé par le retour en arrière automatique (retour-arriere.mjs).
    if (a.vercel !== undefined && (typeof a.vercel !== 'string' || !/^[a-z0-9-]+$/.test(a.vercel))) throw new Error(`app ${a.nom} : vercel doit être un nom de projet (minuscules, chiffres, tirets)`);
    return { nom: a.nom, depot: a.depot, sante: a.sante, ...(a.vercel ? { vercel: a.vercel } : {}) };
  });
}

/**
 * Les apps à sonder : la liste du dépôt, ou, pour un lancement d'essai, une seule app simulée (nom et URL
 * donnés à la main). `lireListe` rend le texte de surveillance/apps.json.
 */
export function appsAControler(env, lireListe) {
  if (env.SURVEILLANCE_ESSAI_URL) {
    return [{ nom: env.SURVEILLANCE_ESSAI_NOM || 'essai', depot: env.GITHUB_REPOSITORY || 'MoKarade/.github', sante: env.SURVEILLANCE_ESSAI_URL }];
  }
  return JSON.parse(lireListe());
}

/** Sonde la santé d'une app ; rend { nom, ok, cause }. Même contrôle que la fumée (200 et { ok: true }). */
export async function sonder(app, { essais, delaiMs, timeoutMs, appel }) {
  const url = new URL(app.sante);
  const controle = controles({ base: url.origin, sante: `${url.pathname}${url.search}`, summary: '', connexion: '/', appel }).find(
    (c) => c.nom === 'sante',
  );
  const r = await lancer(controle, { essais, delaiMs, timeoutMs });
  return { nom: app.nom, ok: r.ok, cause: r.cause };
}

/**
 * Décide quoi faire de chaque app sondée. `ouvertes` = les issues `panne` ouvertes ({ number, title }).
 * Une app en panne avec une issue déjà ouverte ne déclenche rien de plus (pas de bruit à chaque passage).
 */
export function decider({ resultats, ouvertes }) {
  const actions = [];
  for (const r of resultats) {
    const issue = ouvertes.find((o) => o.title === titrePanne(r.nom));
    if (!r.ok && !issue) actions.push({ type: 'ouvrir', nom: r.nom, cause: r.cause });
    else if (r.ok && issue) actions.push({ type: 'fermer', nom: r.nom, numero: issue.number });
  }
  return actions;
}

const heureQuebec = (date) =>
  new Intl.DateTimeFormat('fr-CA', { timeZone: 'America/Toronto', dateStyle: 'short', timeStyle: 'short' }).format(date);

export const corpsOuverture = (app, cause, date) =>
  [
    `**${app.nom}** ne répond plus à \`/api/sante\` (${cause}), constaté le ${heureQuebec(date)} (heure du Québec).`,
    '',
    `Cible : ${app.sante}`,
    '',
    'Cette issue se ferme toute seule quand l’app répond de nouveau. Aucune action de ta part n’est nécessaire tant que ça dure ; un fil la reprend au passage de la routine.',
  ].join('\n');

export const corpsRetour = (nom, date) => `**${nom}** répond de nouveau (constaté le ${heureQuebec(date)}, heure du Québec). Panne close.`;

/** Applique les actions avec `gh` (une fonction qui prend un tableau d'arguments et rend la sortie). */
export async function appliquer(actions, apps, gh, date = new Date()) {
  for (const a of actions) {
    if (a.type === 'ouvrir') {
      const app = apps.find((x) => x.nom === a.nom);
      await gh(['issue', 'create', '--title', titrePanne(a.nom), '--label', LABEL, '--body', corpsOuverture(app, a.cause, date)]);
    } else if (a.type === 'fermer') {
      await gh(['issue', 'close', String(a.numero), '--reason', 'completed', '--comment', corpsRetour(a.nom, date)]);
    }
  }
}

export function tableau({ resultats, aBrancher, actions }) {
  const fait = (nom) => actions.find((a) => a.nom === nom)?.type;
  const libelle = { ouvrir: 'issue ouverte', fermer: 'issue fermée' };
  const lignes = [
    ...resultats.map((r) => `| ${r.nom} | ${r.ok ? 'répond' : 'PANNE'} | ${r.ok ? '' : r.cause} | ${libelle[fait(r.nom)] ?? ''} |`),
    ...aBrancher.map((a) => `| ${a.nom} | à brancher | ${a.raison} | |`),
  ];
  return ['### Surveillance des apps', '', '| App | État | Détail | Suite |', '|---|---|---|---|', ...lignes, ''].join('\n');
}

const ghReel = (args) =>
  new Promise((resolve, reject) => {
    execFile('gh', args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      // La sortie d'erreur de gh ne contient pas le jeton ; on la garde pour comprendre l'échec.
      if (err) reject(new Error(`gh ${args.slice(0, 2).join(' ')} a échoué : ${String(stderr).trim() || err.message}`));
      else resolve(stdout);
    });
  });

async function main() {
  const env = process.env;
  // Lancement d'essai : une seule app simulée, nommée et pointée à la main (preuve « panne ouvre, retour ferme »).
  const apps = lireApps(appsAControler(env, () => readFileSync(new URL('../surveillance/apps.json', import.meta.url), 'utf8')));
  const config = {
    essais: Number(env.SURVEILLANCE_ESSAIS || 3),
    delaiMs: Number(env.SURVEILLANCE_DELAI_MS || 10_000),
    timeoutMs: Number(env.SURVEILLANCE_TIMEOUT_MS || 10_000),
    appel: (u, init = {}) => fetch(u, { ...init, signal: AbortSignal.timeout(Number(env.SURVEILLANCE_TIMEOUT_MS || 10_000)) }),
  };
  const sondees = apps.filter((a) => a.sante);
  const resultats = [];
  for (const a of sondees) resultats.push(await sonder(a, config));

  // `--force` crée l'étiquette si elle manque et la laisse telle quelle sinon.
  await ghReel(['label', 'create', LABEL, '--color', 'B60205', '--description', 'App en panne (surveillance automatique)', '--force']);
  const ouvertes = JSON.parse(await ghReel(['issue', 'list', '--label', LABEL, '--state', 'open', '--limit', '100', '--json', 'number,title']));
  const actions = decider({ resultats, ouvertes });
  await appliquer(actions, apps, ghReel);

  const texte = tableau({ resultats, aBrancher: apps.filter((a) => !a.sante), actions });
  console.log(texte);
  for (const r of resultats.filter((x) => !x.ok)) console.log(`::warning title=Panne::${r.nom} — ${r.cause}`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${texte}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
