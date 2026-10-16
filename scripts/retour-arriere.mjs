#!/usr/bin/env node
// Retour en arrière automatique quand une app tombe juste après un déploiement (tâche #30, §11 de
// docs/cycle-de-vie-tache.md).
//
// Pourquoi ici et pas dans le workflow de fumée : le retour en arrière demande un jeton Vercel. Il est rangé
// UNE seule fois, dans les secrets de ce dépôt (secret VERCEL_TOKEN), jamais dans les dix dépôts d'apps.
// La surveillance tourne déjà ici toutes les 15 minutes et sonde la santé de chaque app : c'est elle qui déclenche.
//
// Pour chaque app qui a un projet Vercel déclaré (`vercel` dans surveillance/apps.json) et dont la sonde est ROUGE :
//   1. lire chez Vercel le déploiement de production courant et les versions précédentes (état READY) ;
//   2. ne rien faire sauf si la panne suit un déploiement RÉCENT (la panne d'une base de données n'est pas un
//      déploiement fautif), si ce déploiement est bien celui en ligne (pas déjà retiré), et s'il existe une
//      version précédente ;
//   3. remettre en ligne la version précédente (Vercel « instant rollback ») ;
//   4. refaire la sonde sur la version remise et le dire ;
//   5. ouvrir une issue `incident` dans ce dépôt, avec le commit fautif et sa tâche d'origine.
//
// Échec fermé : sans jeton, rien n'est lu ni changé, et le résumé dit « inactif ». Un seul retour en arrière par
// déploiement fautif : une fois retiré, le fautif n'est plus le déploiement en ligne, donc on ne remonte pas plus loin.
//
// Limite dite : la PR d'annulation (revert) du commit fautif n'est pas ouverte ici. Le jeton d'un job de ce dépôt
// n'écrit pas dans les dépôts des apps, et une PR ouverte avec ce jeton ne déclenche aucun contrôle (donc ne
// fusionne pas). L'issue `incident` porte le commit ; la routine ouvre l'annulation.
//
// Fonctions pures d'un côté (`choisirCible`, `titreIncident`, `corpsIncident`, `tableau`), I/O de l'autre : l'API
// Vercel, la sonde et `gh` sont injectés. Le jeton ne sort jamais dans un journal.
import { execFile } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { lireApps, sonder } from './surveillance.mjs';

export const LABEL_INCIDENT = 'incident';
const AGE_MAX_MIN = 120;

export const titreIncident = (nom, sha) => `Incident : ${nom} remis sur la version précédente (${sha})`;

const court = (sha) => String(sha ?? '').slice(0, 7);

/** Un déploiement Vercel normalisé : { id, cree (ms), sha, message }. */
export const normaliser = (d) => ({
  id: d.uid ?? d.id,
  cree: d.created ?? d.createdAt ?? 0,
  sha: String(d.meta?.githubCommitSha ?? ''),
  message: String(d.meta?.githubCommitMessage ?? '').split('\n')[0].slice(0, 120),
});

/**
 * Décide si on remet la version précédente. `courantId` = déploiement de production en ligne ; `deploiements` =
 * les déploiements de production READY, du plus récent au plus ancien. Rend { action: 'retour', fautif, precedent }
 * ou { action: 'rien', raison }.
 */
export function choisirCible({ courantId, deploiements, maintenant, ageMaxMin = AGE_MAX_MIN }) {
  if (!courantId) return { action: 'rien', raison: 'déploiement en ligne introuvable parmi les derniers prêts (domaine de production sans alias)' };
  const liste = deploiements.map(normaliser);
  if (liste.length === 0) return { action: 'rien', raison: 'aucun déploiement de production prêt' };
  const [recent, precedent] = liste;
  if (recent.id !== courantId) return { action: 'rien', raison: 'le déploiement le plus récent n’est pas en ligne (déjà retiré, annulé ou pas encore promu)' };
  const ageMin = (maintenant - recent.cree) / 60_000;
  if (!(ageMin <= ageMaxMin)) return { action: 'rien', raison: `déploiement vieux de plus de ${ageMaxMin} min : la panne n’en vient probablement pas` };
  if (!precedent) return { action: 'rien', raison: 'aucune version précédente à remettre' };
  return { action: 'retour', fautif: recent, precedent };
}

/** Client minimal de l'API Vercel (fetch injecté). Le message d'erreur ne contient jamais le jeton. */
export const clientVercel = ({ jeton, equipe, appel = fetch }) =>
  async function api(methode, chemin, params = {}) {
    const url = new URL(`https://api.vercel.com${chemin}`);
    if (equipe) url.searchParams.set('slug', equipe);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const r = await appel(url, { method: methode, headers: { authorization: `Bearer ${jeton}` }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`Vercel ${methode} ${chemin} : HTTP ${r.status}`);
    // Le retour en arrière (POST .../rollback/...) rend un corps VIDE : constaté sur essai-retour le 16/10 (run 38905043516),
    // où le retour avait réussi mais le script a échoué avant de refaire la sonde et d'ouvrir l'issue.
    const texte = await r.text();
    return texte.trim() ? JSON.parse(texte) : {};
  };

/**
 * Ce que Vercel sait d'un projet : { projetId, courantId, deploiements }. Le déploiement EN LIGNE est celui dont les
 * alias portent le domaine de production de l'app (`hote`), pas `targets.production` du projet : celui-ci rend le
 * dernier déploiement créé, même annulé ou en échec (constaté sur batchchef le 16/10), et il ne bouge pas après un
 * retour en arrière.
 */
export async function lireProjet(api, nomProjet, hote) {
  const projet = await api('GET', `/v9/projects/${encodeURIComponent(nomProjet)}`);
  const liste = await api('GET', '/v6/deployments', { projectId: projet.id, target: 'production', state: 'READY', limit: 5 });
  const deploiements = liste.deployments ?? [];
  let courantId = null;
  for (const d of deploiements) {
    const id = normaliser(d).id;
    const detail = await api('GET', `/v13/deployments/${encodeURIComponent(id)}`);
    if (Array.isArray(detail.alias) && detail.alias.includes(hote)) {
      courantId = id;
      break;
    }
  }
  return { projetId: projet.id, courantId, deploiements };
}

const tacheOrigine = (message, depot) => {
  const m = /\(#(\d+)\)\s*$/.exec(message);
  return m ? `https://github.com/${depot}/pull/${m[1]}` : null;
};

export const corpsIncident = ({ app, fautif, precedent, probeApres, date }) =>
  [
    `**${app.nom}** a cessé de répondre après son déploiement de production \`${court(fautif.sha)}\`. La version précédente (\`${court(precedent.sha)}\`) a été remise en ligne.`,
    '',
    `Commit fautif : https://github.com/${app.depot}/commit/${fautif.sha} — \`${fautif.message.replaceAll('`', "'")}\``,
    ...(tacheOrigine(fautif.message, app.depot) ? [`Tâche d’origine (PR) : ${tacheOrigine(fautif.message, app.depot)}`] : []),
    `Version remise : \`${court(precedent.sha)}\``,
    `Sonde de santé sur la version remise : ${probeApres.ok ? 'verte, la production répond de nouveau' : `**toujours rouge** (${probeApres.cause}) — la cause n’est peut-être pas le déploiement`}.`,
    `Constaté le ${new Intl.DateTimeFormat('fr-CA', { timeZone: 'America/Toronto', dateStyle: 'short', timeStyle: 'short' }).format(date)} (heure du Québec).`,
    '',
    'À faire : annuler le commit fautif (revert) puis refaire la tâche proprement. La routine voit cette issue (priorité 1).',
  ].join('\n');

/** Traite une app dont la sonde est rouge. Rend une ligne de résumé { nom, issue }. */
export async function traiter(app, { api, sondeApres, gh, maintenant, controle = false }) {
  const { projetId, courantId, deploiements } = await lireProjet(api, app.vercel, new URL(app.sante).hostname);
  const cible = choisirCible({ courantId, deploiements, maintenant: maintenant.getTime() });
  if (controle) return { nom: app.nom, etat: cible.action === 'retour' ? `prêt (précédente ${court(cible.precedent.sha)})` : `rien à faire : ${cible.raison}` };
  if (cible.action !== 'retour') return { nom: app.nom, etat: `rien fait : ${cible.raison}` };

  await api('POST', `/v1/projects/${projetId}/rollback/${cible.precedent.id}`, { description: 'Retour en arrière automatique : sonde de santé rouge après déploiement' });
  const probeApres = await sondeApres(app);
  const titre = titreIncident(app.nom, court(cible.fautif.sha));
  await gh(['label', 'create', LABEL_INCIDENT, '--color', 'D93F0B', '--description', 'Retour en arrière automatique', '--force']);
  const deja = JSON.parse(await gh(['issue', 'list', '--label', LABEL_INCIDENT, '--state', 'all', '--search', `"${titre}" in:title`, '--json', 'title', '--limit', '20']));
  if (!deja.some((i) => i.title === titre)) {
    await gh(['issue', 'create', '--title', titre, '--label', LABEL_INCIDENT, '--body', corpsIncident({ app, ...cible, probeApres, date: maintenant })]);
  }
  return { nom: app.nom, etat: `retour en arrière fait vers ${court(cible.precedent.sha)} ; sonde ${probeApres.ok ? 'verte' : 'ROUGE'}` };
}

export function tableau(lignes, { actif, controle }) {
  const titre = controle ? '### Retour en arrière : contrôle (lecture seule)' : '### Retour en arrière automatique';
  if (!actif) return [titre, '', 'Inactif : le secret VERCEL_TOKEN n’est pas posé dans ce dépôt (rien n’est lu ni changé).', ''].join('\n');
  if (lignes.length === 0) return [titre, '', 'Aucune app en panne : rien à faire.', ''].join('\n');
  return [titre, '', '| App | Résultat |', '|---|---|', ...lignes.map((l) => `| ${l.nom} | ${l.etat} |`), ''].join('\n');
}

const ghReel = (args) =>
  new Promise((resolve, reject) => {
    execFile('gh', args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`gh ${args.slice(0, 2).join(' ')} a échoué : ${String(stderr).trim() || err.message}`));
      else resolve(stdout);
    });
  });

/**
 * Les apps à traiter : celles de surveillance/apps.json qui ont une sonde et un projet Vercel, ou, pour un
 * lancement d'essai, une seule app simulée (nom, URL de santé et projet Vercel donnés à la main). Une URL
 * d'essai sans projet Vercel d'essai ne touche à rien : la preuve du retour ne passe jamais par une vraie app.
 */
export function appsRetour(env, liste) {
  if (env.SURVEILLANCE_ESSAI_URL) {
    const vercel = env.RETOUR_ESSAI_VERCEL || '';
    if (!/^[a-z0-9-]+$/.test(vercel)) return [];
    return [{ nom: env.SURVEILLANCE_ESSAI_NOM || 'essai', depot: env.GITHUB_REPOSITORY || 'MoKarade/.github', sante: env.SURVEILLANCE_ESSAI_URL, vercel }];
  }
  return liste.filter((a) => a.sante && a.vercel);
}

async function main() {
  const env = process.env;
  const controle = env.RETOUR_CONTROLE === 'true';
  const jeton = env.VERCEL_TOKEN || '';
  const texteInactif = tableau([], { actif: false, controle });
  if (!jeton) {
    console.log(texteInactif);
    console.log('::notice title=Retour en arrière::inactif, secret VERCEL_TOKEN absent');
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${texteInactif}\n`);
    return;
  }
  const apps = appsRetour(env, lireApps(JSON.parse(readFileSync(new URL('../surveillance/apps.json', import.meta.url), 'utf8'))));
  const timeoutMs = Number(env.SURVEILLANCE_TIMEOUT_MS || 10_000);
  const appel = (u, init = {}) => fetch(u, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const api = clientVercel({ jeton, equipe: env.VERCEL_EQUIPE || '' });
  const config = { essais: 3, delaiMs: Number(env.SURVEILLANCE_DELAI_MS || 10_000), timeoutMs, appel };
  const lignes = [];
  for (const app of apps) {
    const sonde = await sonder(app, config);
    // En contrôle, on lit Vercel pour toutes les apps (preuve que le branchement marche) sans rien changer.
    if (sonde.ok && !controle) continue;
    try {
      lignes.push(await traiter(app, { api, sondeApres: (a) => sonder(a, { ...config, essais: 5 }), gh: ghReel, maintenant: new Date(), controle }));
    } catch (err) {
      // Une erreur Vercel ne doit jamais passer pour « rien à faire » : elle est dite et fait échouer le job.
      lignes.push({ nom: app.nom, etat: `ERREUR : ${err.message}` });
      process.exitCode = 1;
    }
  }
  const texte = tableau(lignes, { actif: true, controle });
  console.log(texte);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${texte}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
