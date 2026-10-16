#!/usr/bin/env node
// Alerte quand un déploiement de production échoue (tâche #60, suite de la surveillance #21).
//
// La surveillance (`surveillance.mjs`) voit une app qui ne répond plus ; elle ne voit pas un déploiement
// de production qui échoue tout en laissant l'ancienne version en ligne. Vercel publie chaque déploiement
// comme un « deployment » GitHub avec son état (success, failure, error, ...) : on lit le dernier déploiement
// de l'environnement Production de chaque app, depuis ce dépôt, sans rien ajouter dans les dépôts des apps
// et sans jeton Vercel. Un dernier déploiement en échec ouvre UNE issue `panne` ; le déploiement suivant
// réussi la ferme avec un commentaire.
//
// Limite dite, jamais un faux vert : un dépôt que le jeton du job ne lit pas (privé) est « non mesuré ».
//
// Fonctions pures d'un côté (`etatDeploiement`, `decider`, `tableau`), I/O de l'autre : `gh` est injecté.
import { execFile } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { LABEL, lireApps } from './surveillance.mjs';

export const titreEchec = (nom) => `Déploiement en échec : ${nom}`;

const ECHECS = new Set(['failure', 'error']);
const EN_COURS = new Set(['queued', 'pending', 'in_progress']);

/** État du dernier déploiement d'après son dernier statut : ok, echec, en-cours ou inconnu. */
export function etatDeploiement(statut) {
  if (!statut) return 'en-cours'; // déploiement créé, aucun statut encore
  if (statut.state === 'success') return 'ok';
  if (ECHECS.has(statut.state)) return 'echec';
  if (EN_COURS.has(statut.state)) return 'en-cours';
  return 'inconnu';
}

const estNonTrouve = (err) => /HTTP 404|Not Found/i.test(`${err?.stderr ?? ''} ${err?.message ?? ''}`);

/**
 * Le dernier déploiement de production d'un dépôt : { etat, sha, date, url } ; null si aucun déploiement ;
 * { illisible: true } si le jeton du job ne lit pas ce dépôt (404). Toute autre erreur remonte.
 */
export async function dernierDeploiement(gh, depot) {
  try {
    const liste = JSON.parse(await gh(['api', `repos/${depot}/deployments?environment=Production&per_page=1`]));
    if (!Array.isArray(liste) || liste.length === 0) return null;
    const d = liste[0];
    const statuts = JSON.parse(await gh(['api', `repos/${depot}/deployments/${d.id}/statuses?per_page=1`]));
    const s = Array.isArray(statuts) ? statuts[0] : undefined;
    const url = typeof s?.log_url === 'string' && /^https:\/\//.test(s.log_url) ? s.log_url : null;
    return { etat: etatDeploiement(s), sha: String(d.sha ?? '').slice(0, 7), date: d.created_at ?? null, url };
  } catch (err) {
    if (estNonTrouve(err)) return { illisible: true };
    throw err;
  }
}

/** Un relevé par app : { nom, depot, ...dernierDeploiement }. */
export async function relever(apps, gh) {
  const releves = [];
  for (const a of apps) releves.push({ nom: a.nom, depot: a.depot, ...((await dernierDeploiement(gh, a.depot)) ?? { aucun: true }) });
  return releves;
}

/**
 * Décide quoi faire. `ouvertes` = les issues `panne` ouvertes ({ number, title }). Un échec avec une issue
 * déjà ouverte ne déclenche rien de plus ; un déploiement en cours ou inconnu ne change rien.
 */
export function decider({ releves, ouvertes }) {
  const actions = [];
  for (const r of releves) {
    const issue = ouvertes.find((o) => o.title === titreEchec(r.nom));
    if (r.etat === 'echec' && !issue) actions.push({ type: 'ouvrir', nom: r.nom });
    else if (r.etat === 'ok' && issue) actions.push({ type: 'fermer', nom: r.nom, numero: issue.number });
  }
  return actions;
}

const heureQuebec = (date) =>
  new Intl.DateTimeFormat('fr-CA', { timeZone: 'America/Toronto', dateStyle: 'short', timeStyle: 'short' }).format(date);

export const corpsOuverture = (r, date) =>
  [
    `Le dernier déploiement de production de **${r.nom}** a échoué (commit \`${r.sha}\`), constaté le ${heureQuebec(date)} (heure du Québec).`,
    '',
    `Commit : https://github.com/${r.depot}/commit/${r.sha}`,
    ...(r.url ? [`Journal du déploiement : ${r.url}`] : []),
    '',
    'L’ancienne version reste en ligne tant qu’aucun déploiement ne réussit. Cette issue se ferme toute seule au prochain déploiement de production réussi ; un fil la reprend au passage de la routine.',
  ].join('\n');

export const corpsRetour = (r, date) =>
  `Un déploiement de production de **${r.nom}** a réussi (commit \`${r.sha}\`, constaté le ${heureQuebec(date)}, heure du Québec). Échec clos.`;

export async function appliquer(actions, releves, gh, date = new Date()) {
  for (const a of actions) {
    const r = releves.find((x) => x.nom === a.nom);
    if (a.type === 'ouvrir') {
      await gh(['issue', 'create', '--title', titreEchec(a.nom), '--label', LABEL, '--body', corpsOuverture(r, date)]);
    } else if (a.type === 'fermer') {
      await gh(['issue', 'close', String(a.numero), '--reason', 'completed', '--comment', corpsRetour(r, date)]);
    }
  }
}

export function tableau({ releves, actions }) {
  const libelle = { ouvrir: 'issue ouverte', fermer: 'issue fermée' };
  const etat = (r) => {
    if (r.illisible) return ['non mesuré', 'dépôt non lisible par le jeton du job (privé)'];
    if (r.aucun) return ['aucun déploiement', ''];
    const noms = { ok: 'réussi', echec: 'ÉCHEC', 'en-cours': 'en cours', inconnu: 'état inconnu' };
    return [noms[r.etat], r.sha ? `commit ${r.sha}` : ''];
  };
  const lignes = releves.map((r) => {
    const [e, detail] = etat(r);
    return `| ${r.nom} | ${e} | ${detail} | ${libelle[actions.find((a) => a.nom === r.nom)?.type] ?? ''} |`;
  });
  return ['### Déploiements de production', '', '| App | Dernier déploiement | Détail | Suite |', '|---|---|---|---|', ...lignes, ''].join('\n');
}

const ghReel = (args) =>
  new Promise((resolve, reject) => {
    execFile('gh', args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(new Error(`gh ${args.slice(0, 2).join(' ')} a échoué : ${String(stderr).trim() || err.message}`), { stderr: String(stderr) }));
      else resolve(stdout);
    });
  });

/** Lancement d'essai : une app simulée dont le dernier déploiement est `echec` ou `succes` (rien n'est lu chez Vercel). */
export const releveEssai = (env, date = new Date()) => ({
  nom: env.SURVEILLANCE_ESSAI_NOM || 'essai',
  depot: env.GITHUB_REPOSITORY || 'MoKarade/.github',
  etat: env.DEPLOIEMENT_ESSAI === 'echec' ? 'echec' : 'ok',
  sha: 'essai00',
  date: date.toISOString(),
  url: null,
});

async function main() {
  const env = process.env;
  const essai = env.DEPLOIEMENT_ESSAI === 'echec' || env.DEPLOIEMENT_ESSAI === 'succes';
  const releves = essai
    ? [releveEssai(env)]
    : await relever(lireApps(JSON.parse(readFileSync(new URL('../surveillance/apps.json', import.meta.url), 'utf8'))), ghReel);

  await ghReel(['label', 'create', LABEL, '--color', 'B60205', '--description', 'App en panne (surveillance automatique)', '--force']);
  const ouvertes = JSON.parse(await ghReel(['issue', 'list', '--label', LABEL, '--state', 'open', '--limit', '100', '--json', 'number,title']));
  const actions = decider({ releves, ouvertes });
  await appliquer(actions, releves, ghReel);

  const texte = tableau({ releves, actions });
  console.log(texte);
  for (const r of releves.filter((x) => x.etat === 'echec')) console.log(`::warning title=Déploiement::${r.nom} — dernier déploiement de production en échec`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${texte}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
