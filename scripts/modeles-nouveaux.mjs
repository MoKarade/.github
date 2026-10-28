#!/usr/bin/env node
// Compare la liste des modèles Anthropic aux identifiants claude-… trouvés dans le code des apps.
// Ouvre dans chaque app une tâche de migration quand un modèle plus récent existe dans une famille déjà utilisée.
// Il ne migre rien lui-même. Une liste illisible fait échouer le script avec un message : jamais de tâche inventée.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PARENT_MISSION = 'MoKarade/.github#648';

export const APPS_PAR_DEFAUT = [
  { nom: 'emploi', depot: 'MoKarade/JobAI' },
  { nom: 'batchchef', depot: 'MoKarade/batchchef-' },
  { nom: 'carai', depot: 'MoKarade/CarAI' },
  { nom: 'hubperso', depot: 'MoKarade/Hubperso' },
  { nom: 'memoryai', depot: 'MoKarade/MemoryAI' },
  { nom: 'driveai', depot: 'MoKarade/DriveAI' },
  { nom: 'financeai', depot: 'MoKarade/FinanceAI' },
];

const GABARIT_PATH = fileURLToPath(new URL('../docs/gabarits/migration-modele.md', import.meta.url));
const PAGES_RECHERCHE_MAX = 3;
const PAUSE_RECHERCHE_MS = 7000; // la recherche de code GitHub est plafonnée à 10 appels par minute

export function estIdentifiantModeleValide(id) {
  return typeof id === 'string' && !/system-card|analytics|bedrock|cloud|permissions|legacy|platform|skill|enterprise|amazon|foundry|google/i.test(id);
}

export function familleDuModele(id) {
  if (!estIdentifiantModeleValide(id)) return null;
  const lower = id.toLowerCase();
  if (lower.includes('haiku')) return 'haiku';
  if (lower.includes('sonnet')) return 'sonnet';
  if (lower.includes('opus')) return 'opus';
  return null;
}

/** Alias flottant (-latest) et instantané daté (-AAAAMMJJ) du même modèle ont la même clé. */
export function cleBaseModele(id) {
  if (typeof id !== 'string') return '';
  return id.toLowerCase().replace(/-latest$/, '').replace(/-\d{8}$/, '');
}

/** Numéro de version d'un identifiant : « claude-3-5-sonnet » et « claude-sonnet-5-5 » donnent [3, 5] et [5, 5]. */
export function versionDuModele(id) {
  const sansFamille = cleBaseModele(id).replace(/^claude-/, '').replace(/haiku|sonnet|opus/g, '');
  return (sansFamille.match(/\d+/g) ?? []).map(Number);
}

function comparerVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

const idDe = (m) => (typeof m === 'string' ? m : m?.id ?? '');

/** Vrai si m2 est d'une version strictement plus récente que m1. Une date de sortie ne sert jamais à comparer : les
 * identifiants de la génération 5.5 n'ont pas de suffixe daté, et une date ferait passer 4.5 daté devant 5.5. */
export function estPlusRecent(m1, m2) {
  const id1 = idDe(m1);
  const id2 = idDe(m2);
  if (!id1 || !id2 || cleBaseModele(id1) === cleBaseModele(id2)) return false;
  return comparerVersions(versionDuModele(id2), versionDuModele(id1)) > 0;
}

export function genererCorpsTache({ app, ancien, nouveau, famille }, gabaritContenu = null) {
  const p = gabaritContenu ?? readFileSync(GABARIT_PATH, 'utf8');
  let corps = p
    .replaceAll('{{app}}', app)
    .replaceAll('{{ancien}}', ancien)
    .replaceAll('{{nouveau}}', nouveau)
    .replaceAll('{{famille}}', famille);

  if (!corps.includes(PARENT_MISSION)) corps += `\n\n**Mission** : ${PARENT_MISSION}\n`;
  return corps;
}

export function modelesAMigrer(listeModeles, idsParApp) {
  const modelesRaw = Array.isArray(listeModeles) ? listeModeles : Array.isArray(listeModeles?.data) ? listeModeles.data : [];
  const apps = Array.isArray(idsParApp) ? idsParApp : Object.entries(idsParApp ?? {}).map(([nom, val]) => ({ nom, ...val }));

  const plusRecentParFamille = {};
  for (const m of modelesRaw) {
    const f = familleDuModele(idDe(m));
    if (!f) continue;
    const courant = plusRecentParFamille[f];
    if (!courant || estPlusRecent(courant, m)) plusRecentParFamille[f] = m;
  }

  const tachesAOuvrir = [];

  for (const app of apps) {
    const nomApp = app.nom ?? app.app;
    const depotApp = app.depot;
    const utilises = (app.utilises ?? app.modelesUtilises ?? []).filter(estIdentifiantModeleValide);
    const dejaTraitees = app.ouvertes ?? app.issuesOuvertes ?? [];

    for (const famille of ['haiku', 'sonnet', 'opus']) {
      const candidatsUtilises = utilises.filter((u) => familleDuModele(u) === famille);
      const candidatAnthropic = plusRecentParFamille[famille];
      if (candidatsUtilises.length === 0 || !candidatAnthropic) continue;
      if (!candidatsUtilises.every((u) => estPlusRecent(u, candidatAnthropic))) continue;

      const ancienId = candidatsUtilises.reduce((a, b) => (estPlusRecent(a, b) ? b : a));
      const nouveauId = idDe(candidatAnthropic);

      const citeLeModele = (texte) => typeof texte === 'string' && texte.includes(nouveauId);
      const dejaFaite = dejaTraitees.some((item) => (typeof item === 'string' ? citeLeModele(item) : citeLeModele(item?.title)));
      if (dejaFaite) continue;

      const titre = `Migration de ${nomApp} vers le modèle ${nouveauId}`;
      const corps = genererCorpsTache({ app: nomApp, ancien: ancienId, nouveau: nouveauId, famille });
      tachesAOuvrir.push({ app: nomApp, depot: depotApp, ancien: ancienId, nouveau: nouveauId, famille, titre, corps, labels: ['niveau:tâche'] });
    }
  }

  return tachesAOuvrir;
}

/** Les mentions dans les tests, les docs et les journaux de changement ne sont pas un usage : elles citent d'anciens
 * identifiants à dessein (tests de refus, historique). */
export function cheminCompte(chemin) {
  return !/(^|\/)(tests?|__tests__|docs|node_modules|graphify-out)\//i.test(chemin)
    && !/\.(md|test\.[a-z]+|spec\.[a-z]+)$/i.test(chemin);
}

export function idsDansTexte(texte) {
  const ids = (texte ?? '').match(/claude-[a-z0-9.-]+/gi) ?? [];
  return ids.map((m) => m.toLowerCase().replace(/[.-]+$/, '')).filter((m) => familleDuModele(m));
}

async function lireJson(response, contexte) {
  if (!response.ok) {
    // Le message de GitHub distingue un jeton sans accès au dépôt d'une limite de débit : les deux rendent 403.
    const corps = await response.json().catch(() => null);
    const detail = typeof corps?.message === 'string' ? ` : ${corps.message}` : '';
    throw new Error(`${contexte} (statut HTTP ${response.status}${detail})`);
  }
  return response.json();
}

export async function lireListeModelesAnthropic({ apiKey = process.env.ANTHROPIC_API_KEY, fetchFn = globalThis.fetch } = {}) {
  if (!apiKey) throw new Error('Impossible de lire la liste des modèles Anthropic (clé API absente : secret ANTHROPIC_API_KEY du dépôt)');
  const json = await lireJson(
    await fetchFn('https://api.anthropic.com/v1/models?limit=1000', { headers: { 'anthropic-version': '2023-06-01', 'x-api-key': apiKey } }),
    'Impossible de lire la liste des modèles Anthropic',
  );
  const items = Array.isArray(json) ? json : json?.data;
  if (!Array.isArray(items)) throw new Error('Impossible de lire la liste des modèles Anthropic (réponse sans liste « data »)');
  return items.filter((m) => estIdentifiantModeleValide(idDe(m)));
}

export async function rechercherModelesApp({ depot, ghToken = process.env.GH_PAT || process.env.GH_TOKEN, fetchFn = globalThis.fetch, pause = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const headers = { Accept: 'application/vnd.github.text-match+json', 'User-Agent': 'modeles-nouveaux' };
  if (ghToken) headers.Authorization = `Bearer ${ghToken}`;

  const vus = new Set();
  for (let page = 1; page <= PAGES_RECHERCHE_MAX; page++) {
    const json = await lireJson(
      await fetchFn(`https://api.github.com/search/code?q=${encodeURIComponent(`claude repo:${depot}`)}&per_page=100&page=${page}`, { headers }),
      `Recherche des identifiants de modèle dans ${depot} échouée`,
    );
    const items = json.items ?? [];
    for (const item of items) {
      if (!cheminCompte(item.path ?? '')) continue;
      for (const match of item.text_matches ?? []) for (const id of idsDansTexte(match.fragment)) vus.add(id);
    }
    if (items.length < 100) break;
    await pause(PAUSE_RECHERCHE_MS);
  }
  return Array.from(vus);
}

/** Toutes les tâches du dépôt, ouvertes ou fermées : une tâche fermée pour ce modèle ne doit pas être rouverte chaque jour. */
export async function lireTachesApp({ depot, ghToken = process.env.GH_PAT || process.env.GH_TOKEN, fetchFn = globalThis.fetch } = {}) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'modeles-nouveaux' };
  if (ghToken) headers.Authorization = `Bearer ${ghToken}`;
  const json = await lireJson(
    await fetchFn(`https://api.github.com/repos/${depot}/issues?state=all&per_page=100`, { headers }),
    `Lecture des issues de ${depot} échouée`,
  );
  return Array.isArray(json) ? json.filter((i) => !i.pull_request).map((i) => ({ title: i.title })) : [];
}

export async function ouvrirTacheMigration({ task, ghToken = process.env.GH_PAT || process.env.GH_TOKEN, fetchFn = globalThis.fetch } = {}) {
  const headers = { Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'modeles-nouveaux' };
  if (ghToken) headers.Authorization = `Bearer ${ghToken}`;
  return lireJson(
    await fetchFn(`https://api.github.com/repos/${task.depot}/issues`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: task.titre, body: task.corps, labels: task.labels }),
    }),
    `Échec de l'ouverture de la tâche dans ${task.depot}`,
  );
}

export async function executer({ aBlanc = false, apps = APPS_PAR_DEFAUT, apiKey = process.env.ANTHROPIC_API_KEY, ghToken = process.env.GH_PAT || process.env.GH_TOKEN, pause = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const listeModeles = await lireListeModelesAnthropic({ apiKey });
  const idsParApp = [];
  for (const app of apps) {
    if (idsParApp.length > 0) await pause(PAUSE_RECHERCHE_MS); // une recherche de code par app : même plafond par minute
    idsParApp.push({
      nom: app.nom,
      depot: app.depot,
      utilises: await rechercherModelesApp({ depot: app.depot, ghToken }),
      ouvertes: await lireTachesApp({ depot: app.depot, ghToken }),
    });
  }

  const aOuvrir = modelesAMigrer(listeModeles, idsParApp);

  if (aBlanc) {
    console.log(`[Essai à blanc] ${aOuvrir.length} tâche(s) de migration à ouvrir :`);
    for (const t of aOuvrir) console.log(` - ${t.app} (${t.depot}) : ${t.ancien} → ${t.nouveau} | « ${t.titre} »`);
    return aOuvrir;
  }

  console.log(`${aOuvrir.length} tâche(s) de migration à ouvrir :`);
  for (const t of aOuvrir) {
    console.log(`Ouverture de la tâche pour ${t.app} (${t.depot}) : ${t.titre}`);
    await ouvrirTacheMigration({ task: t, ghToken });
  }
  return aOuvrir;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  executer({ aBlanc: process.argv.includes('--a-blanc') }).catch((err) => {
    console.error(`ÉCHEC : ${err.message}`);
    process.exit(1);
  });
}
