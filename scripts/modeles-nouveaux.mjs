#!/usr/bin/env node
// Comparaison de la liste des modèles Anthropic aux identifiants claude-… trouvés dans le code des apps.
// Ouvre dans chaque app une tâche de migration quand un modèle plus récent existe dans une famille déjà utilisée.

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

export function cleBaseModele(id) {
  if (typeof id !== 'string') return '';
  return id.toLowerCase().replace(/-latest$/, '').replace(/-\d{8}$/, '');
}

function extraireDateOuVersion(id) {
  const matchDate = id.match(/\b(\d{8})\b/);
  if (matchDate) return parseInt(matchDate[1], 10);
  const matchVers = id.match(/(\d+)(?:-(\d+))?/);
  if (matchVers) {
    const maj = parseInt(matchVers[1], 10);
    const min = matchVers[2] ? parseInt(matchVers[2], 10) : 0;
    return maj * 100 + min;
  }
  return 0;
}

export function estPlusRecent(m1, m2) {
  const id1 = typeof m1 === 'string' ? m1 : m1?.id ?? '';
  const id2 = typeof m2 === 'string' ? m2 : m2?.id ?? '';
  if (!id1 || !id2 || cleBaseModele(id1) === cleBaseModele(id2)) return false;

  const d1 = typeof m1 === 'object' && m1?.created_at ? new Date(m1.created_at).getTime() : NaN;
  const d2 = typeof m2 === 'object' && m2?.created_at ? new Date(m2.created_at).getTime() : NaN;
  if (!Number.isNaN(d1) && !Number.isNaN(d2) && d1 !== d2) return d2 > d1;

  const val1 = extraireDateOuVersion(id1);
  const val2 = extraireDateOuVersion(id2);
  if (val1 !== val2 && val1 > 0 && val2 > 0) return val2 > val1;

  return id2.localeCompare(id1) > 0;
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

  const parFamille = { haiku: [], sonnet: [], opus: [] };
  for (const m of modelesRaw) {
    const id = typeof m === 'string' ? m : m?.id;
    const f = familleDuModele(id);
    if (f && parFamille[f]) parFamille[f].push(m);
  }

  const plusRecentParFamille = {};
  for (const [f, liste] of Object.entries(parFamille)) {
    if (liste.length === 0) continue;
    let max = liste[0];
    for (let i = 1; i < liste.length; i++) {
      if (estPlusRecent(max, liste[i])) max = liste[i];
    }
    plusRecentParFamille[f] = max;
  }

  const tachesAOuvrir = [];

  for (const app of apps) {
    const nomApp = app.nom ?? app.app;
    const depotApp = app.depot;
    const utilises = (app.utilises ?? app.modelesUtilises ?? []).filter(estIdentifiantModeleValide);
    const ouvertes = app.ouvertes ?? app.issuesOuvertes ?? [];

    const utilisesParFamille = { haiku: [], sonnet: [], opus: [] };
    for (const u of utilises) {
      const f = familleDuModele(u);
      if (f && utilisesParFamille[f]) utilisesParFamille[f].push(u);
    }

    for (const [famille, candidatsUtilises] of Object.entries(utilisesParFamille)) {
      if (candidatsUtilises.length === 0) continue;
      const candidatAnthropic = plusRecentParFamille[famille];
      if (!candidatAnthropic) continue;

      const nouveauId = typeof candidatAnthropic === 'string' ? candidatAnthropic : candidatAnthropic.id;
      if (!candidatsUtilises.every((u) => estPlusRecent(u, candidatAnthropic))) continue;

      let ancienModele = candidatsUtilises[0];
      for (let i = 1; i < candidatsUtilises.length; i++) {
        if (estPlusRecent(ancienModele, candidatsUtilises[i])) ancienModele = candidatsUtilises[i];
      }
      const ancienId = typeof ancienModele === 'string' ? ancienModele : ancienModele.id;

      const titreDoublon = (titre) => typeof titre === 'string' && titre.includes(nouveauId);
      const dejaOuverte = ouvertes.some((item) => (typeof item === 'string' ? titreDoublon(item) : titreDoublon(item?.title) || titreDoublon(item?.body)));
      if (dejaOuverte) continue;

      const titre = `Migration de ${nomApp} vers le modèle ${nouveauId}`;
      const corps = genererCorpsTache({ app: nomApp, ancien: ancienId, nouveau: nouveauId, famille });

      tachesAOuvrir.push({ app: nomApp, depot: depotApp, ancien: ancienId, nouveau: nouveauId, famille, titre, corps, labels: ['niveau:tâche'] });
    }
  }

  return tachesAOuvrir;
}

export async function lireListeModelesAnthropic({ apiKey = process.env.ANTHROPIC_API_KEY, fetchFn = globalThis.fetch } = {}) {
  const headers = { 'anthropic-version': '2023-06-01' };
  if (apiKey) headers['x-api-key'] = apiKey;

  try {
    const response = await fetchFn('https://api.anthropic.com/v1/models', { headers });
    if (response.ok) {
      const json = await response.json();
      const items = Array.isArray(json) ? json : json?.data;
      if (Array.isArray(items)) return items.filter((m) => estIdentifiantModeleValide(typeof m === 'string' ? m : m?.id));
    }
  } catch {}

  try {
    const resPage = await fetchFn('https://docs.anthropic.com/en/docs/about-claude/models');
    if (resPage.ok) {
      const html = await resPage.text();
      const matches = html.match(/claude-[a-z0-9.-]+/gi) ?? [];
      const vus = new Set();
      const liste = [];
      for (const m of matches) {
        if (estIdentifiantModeleValide(m) && familleDuModele(m) && !vus.has(m)) {
          vus.add(m);
          liste.push({ id: m });
        }
      }
      if (liste.length > 0) return liste;
    }
  } catch (e) {
    throw new Error(`Impossible de lire la liste des modèles Anthropic (API et page publique en échec : ${e.message})`);
  }

  throw new Error('Impossible de lire la liste des modèles Anthropic (clé API absente ou réponse invalide)');
}

export async function rechercherModelesApp({ depot, ghToken = process.env.GH_PAT || process.env.GH_TOKEN, fetchFn = globalThis.fetch } = {}) {
  const headers = { Accept: 'application/vnd.github.v3.text-match+json', 'User-Agent': 'node-script' };
  if (ghToken) headers.Authorization = `Bearer ${ghToken}`;

  const vus = new Set();
  try {
    const response = await fetchFn(`https://api.github.com/search/code?q=claude+repo:${depot}`, { headers });
    if (response.ok) {
      const json = await response.json();
      for (const item of json.items ?? []) {
        for (const match of item.text_matches ?? []) {
          for (const m of (match.fragment ?? '').match(/claude-[a-z0-9.-]+/gi) ?? []) {
            if (familleDuModele(m)) vus.add(m.toLowerCase());
          }
        }
      }
      return Array.from(vus);
    }
  } catch {}

  try {
    const resTree = await fetchFn(`https://api.github.com/repos/${depot}/git/trees/main?recursive=1`, { headers: { 'User-Agent': 'node-script', ...(ghToken ? { Authorization: `Bearer ${ghToken}` } : {}) } });
    if (resTree.ok) {
      const treeData = await resTree.json();
      const candidateFiles = (treeData.tree ?? []).filter((f) => f.type === 'blob' && /\.(js|mjs|ts|tsx|json|env.*|py|md|yml|yaml)$/i.test(f.path));
      for (const file of candidateFiles) {
        const rawRes = await fetchFn(`https://raw.githubusercontent.com/${depot}/main/${file.path}`);
        if (!rawRes.ok) continue;
        const text = await rawRes.text();
        for (const m of text.match(/claude-[a-z0-9.-]+/gi) ?? []) {
          if (familleDuModele(m)) vus.add(m.toLowerCase());
        }
      }
    }
  } catch {}

  return Array.from(vus);
}

export async function lireTachesOuvertesApp({ depot, ghToken = process.env.GH_PAT || process.env.GH_TOKEN, fetchFn = globalThis.fetch } = {}) {
  const headers = { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'node-script' };
  if (ghToken) headers.Authorization = `Bearer ${ghToken}`;

  try {
    const response = await fetchFn(`https://api.github.com/repos/${depot}/issues?state=open&per_page=100`, { headers });
    if (response.ok) {
      const json = await response.json();
      return Array.isArray(json) ? json.map((i) => ({ title: i.title, body: i.body })) : [];
    }
    if (response.status === 404 || response.status === 403) return [];
    throw new Error(`Lecture des issues ouvertes échouée pour ${depot} (statut HTTP ${response.status})`);
  } catch (err) {
    if (err.message.includes('HTTP') || err.message.includes('échouée')) throw err;
    throw new Error(`Erreur réseau lors de la lecture des issues ouvertes dans ${depot} : ${err.message}`);
  }
}

export async function ouvrirTacheMigration({ task, ghToken = process.env.GH_PAT || process.env.GH_TOKEN, fetchFn = globalThis.fetch } = {}) {
  const headers = { Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json', 'User-Agent': 'node-script' };
  if (ghToken) headers.Authorization = `Bearer ${ghToken}`;

  const response = await fetchFn(`https://api.github.com/repos/${task.depot}/issues`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: task.titre, body: task.corps, labels: task.labels }),
  });
  if (!response.ok) throw new Error(`Échec de l'ouverture de la tâche dans ${task.depot} (statut HTTP ${response.status})`);
  return await response.json();
}

export async function executer({ aBlanc = false, apps = APPS_PAR_DEFAUT, apiKey = process.env.ANTHROPIC_API_KEY, ghToken = process.env.GH_PAT || process.env.GH_TOKEN } = {}) {
  const listeModeles = await lireListeModelesAnthropic({ apiKey });
  const idsParApp = [];
  for (const app of apps) {
    idsParApp.push({
      nom: app.nom,
      depot: app.depot,
      utilises: await rechercherModelesApp({ depot: app.depot, ghToken }),
      ouvertes: await lireTachesOuvertesApp({ depot: app.depot, ghToken }),
    });
  }

  const aOuvrir = modelesAMigrer(listeModeles, idsParApp);

  if (aBlanc) {
    console.log(`[Essai à blanc] ${aOuvrir.length} tâche(s) de migration à ouvrir :`);
    for (const t of aOuvrir) {
      console.log(` - App: ${t.app} (${t.depot}) | Ancien modèle: ${t.ancien} | Nouveau modèle: ${t.nouveau} | Titre: "${t.titre}"`);
    }
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
  const aBlanc = process.argv.includes('--a-blanc');
  executer({ aBlanc }).catch((err) => {
    console.error(`ÉCHEC : ${err.message}`);
    process.exit(1);
  });
}
