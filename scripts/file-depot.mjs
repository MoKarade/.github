#!/usr/bin/env node
// La file d'UN dépôt, calculée à l'instant d'un événement (docs/cycle-de-vie-tache.md §5 quinquies, mission MoKarade/.github#703, tâche #711).
//
// Avant : la file était `prochaines.json`, écrit par le relevé du PC toutes les 10 minutes ; PC éteint ou tour raté, plus de file, donc plus de départ.
// Maintenant : ce module lit les issues et les PR OUVERTES d'un seul dépôt avec le jeton du job (1 000 appels/h par dépôt, pas les 5 000 partagés de Marc),
// en fait le même relevé à un seul dépôt que `fetch.py` et le passe à `calculer` de `prochaine-tache.mjs` : UN seul calcul de la file, deux sources de données.
//
// Ce que ce module sait de moins que le relevé du PC (dit, jamais caché) :
//   - la hiérarchie (mission, chantier) : les préférences « même mission » et « même chantier » (rangs 4 à 6) ne s'appliquent pas, l'ordre est preuve due, prio:1,
//     sécurité, puis prio puis numéro. La tâche rendue est une tâche PRENABLE ; le rang exact reste celui du Gantt ;
//   - les PR fusionnées sans tâche acceptée (rang 1) : la preuve due est déjà signalée par le Réacteur (« preuve à poser ») ;
//   - le frein de quota : `frein` est passé par l'appelant (la source du quota n'a pas changé) ; sans lui, palier normal.
// Une dépendance « Attend : dépôt#n » est lue sur son dépôt ; une lecture qui échoue (dépôt privé, panne) vaut « dépendance inconnue » : la tâche n'est PAS lancée,
// jamais comptée libre. Un dépôt à l'état `incident` ne rend aucune suivante.
//
// Fonctions pures (`champ`, `lireAttend`, `construireReleve`), I/O de l'autre (`fileDuDepot`, avec `api` injecté : les tests n'ont besoin ni de réseau ni de jeton).
import { pathToFileURL } from 'node:url';
import { prAttendantMarc } from './attend-marc.mjs';
import { fichiersDeclares } from './capacite.mjs';
import { calculer } from './prochaine-tache.mjs';
import { dispense, extraireTachesCompletes } from './tache-liee.mjs';

export const PROPRIETAIRE = 'MoKarade';
export const LABEL_TACHE = 'niveau:tâche';
const PAGES_MAX = 5;
const NOMS_DEPOTS = ['.github', 'financeai', 'jobai', 'batchchef-', 'batchchef', 'driveai', 'hubperso', 'carai', 'memoryai', 'app-template', 'hub-contract', 'lia-ui'];
const ALIAS_DEPOTS = { batchchef: 'batchchef-' };
const echapper = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const REF_ATTEND = new RegExp(`(?:${PROPRIETAIRE}/([\\w.-]+)|(?<![\\w./-])(${[...NOMS_DEPOTS].sort((a, b) => b.length - a.length).map(echapper).join('|')}))?#(\\d+)`, 'gi');
const LIGNE_ATTEND = /^\*\*Attend\s*(?::\s*\*\*|\*\*\s*:?)\s*(.*)$/;
const AUCUNE = /^[\s:*]*(?:rien|aucune?|néant)\b/i;
const FT_LIGNE = /^\s*\*\*\s*Fichiers (?:permis|touchés)\s*\*\*/im;

/** Le texte d'un champ `**Nom** : …` (même grammaire que `champ` de fetch.py), ou null. */
export function champ(corps, nom) {
  const motif = new RegExp(`^\\s*\\*\\*\\s*${echapper(nom)}\\s*(?:\\*\\*\\s*(?:\\([^)\\n]{0,160}\\)\\s*)?:|:\\s*\\*\\*)\\s*(.*?)(?=^\\s*\\*\\*[^*\\n]{1,40}?(?:\\*\\*\\s*:|:\\s*\\*\\*)|(?![\\s\\S]))`, 'ims');
  const m = motif.exec(corps ?? '');
  if (!m) return null;
  return m[1].replace(/\s+/g, ' ').trim();
}

/** Ce qui suit « **Attend** » sur la ligne, ou null si ce n'est pas une ligne Attend. */
function resteAttend(ligne) {
  const m = LIGNE_ATTEND.exec(ligne);
  return m ? m[1] : null;
}

/** Les dépendances écrites sur la ligne `**Attend**` : « dépôt#n » en minuscules (comme `lire_attend` de deps.py). `aucune` n'attend rien. */
export function lireAttend(corps, depot) {
  const deps = [];
  for (const ligne of String(corps ?? '').split('\n')) {
    const reste = resteAttend(ligne);
    if (reste === null) continue;
    const avant = reste.split('—')[0];
    if (AUCUNE.test(avant)) continue;
    for (const m of avant.matchAll(REF_ATTEND)) {
      const nom = (m[1] || m[2] || depot).toLowerCase();
      deps.push(`${ALIAS_DEPOTS[nom] ?? nom}#${m[3]}`);
    }
  }
  return deps;
}

const noms = (issue) => (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
const plusTard = (...dates) => dates.filter(Boolean).map((d) => new Date(d)).filter((d) => !Number.isNaN(d.getTime())).sort((a, b) => a - b).pop()?.toISOString() ?? null;

async function lister(api, chemin) {
  const sortie = [];
  for (let page = 1; page <= PAGES_MAX; page += 1) {
    const lot = await api('GET', `${chemin}${chemin.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (!Array.isArray(lot)) return page === 1 ? null : sortie;
    sortie.push(...lot);
    if (lot.length < 100) break;
  }
  return sortie;
}

/** Les fichiers RÉELS d'une PR ouverte ; null = liste tronquée (100 entrées) ou illisible : elle ne prouve rien. */
async function fichiersReels(api, depot, pr) {
  try {
    const fs = await api('GET', `/repos/${depot}/pulls/${pr}/files?per_page=100`);
    if (!Array.isArray(fs) || fs.length >= 100) return null;
    return [...new Set(fs.flatMap((f) => [f.filename, f.previous_filename]).filter(Boolean))].sort();
  } catch {
    return null;
  }
}

/**
 * Le relevé à un seul dépôt que lit `calculer` : les tâches ouvertes avec leurs étiquettes, leurs fichiers, leur « Fini quand », leurs dépendances et leur PR
 * ouverte. Les dépendances connues d'un AUTRE dépôt (ou fermées) y sont ajoutées comme noeuds : `lecturesDeps` dit lesquelles ont pu être lues.
 * Pure : `issues`, `prs`, `attendMarc`, `fichiersPr` (n PR -> fichiers réels ou null) et `deps` (« dépôt#n » -> issue ou null) sont déjà lus.
 */
export function construireReleve({ depot, issues, prs, attendMarc = [], fichiersPr = new Map(), deps = new Map(), maintenant = new Date() }) {
  const nom = depot.split('/').pop();
  const taches = issues.filter((i) => !i.pull_request && noms(i).includes(LABEL_TACHE) && i.state === 'open');
  const prDe = new Map();
  for (const pr of prs) {
    for (const t of extraireTachesCompletes(pr.body, depot)) {
      if (t.depot.toLowerCase() === depot.toLowerCase() && !prDe.has(t.numero)) prDe.set(t.numero, pr);
    }
  }
  const nodes = {};
  for (const i of taches) {
    const corps = i.body ?? '';
    const pr = prDe.get(i.number);
    nodes[i.number] = {
      n: i.number, title: i.title, lvl: 'tâche', labels: noms(i), state: 'open', created: i.created_at, url: i.html_url, kids: [], start: null,
      pr: pr ? { n: pr.number, repo: nom, state: 'open', draft: !!pr.draft, merged: null, ff: fichiersPr.get(pr.number) ?? null } : null,
      fq: champ(corps, 'Fini quand') ?? '',
      fpl: fichiersDeclares(corps),
      ft_ligne: FT_LIGNE.test(corps),
      attend_ligne: corps.split('\n').some((l) => resteAttend(l) !== null),
      deps: [...new Set(lireAttend(corps, nom).filter((d) => d !== `${nom.toLowerCase()}#${i.number}`))].sort(),
      deps_natives: [], upd: i.updated_at,
    };
  }
  const incidents = issues.filter((i) => !i.pull_request && noms(i).includes('incident') && i.state === 'open').map((i) => ({ n: i.number, t: i.title, url: i.html_url }));
  const repos = [{ repo: nom, key: nom.toLowerCase(), name: nom, nodes, hors: [], incidents, pr_attend_marc: [...attendMarc] }];
  // Les dépendances qui ne sont pas des tâches ouvertes de ce dépôt : un noeud par dépendance lue, fermée ou ouverte. Illisible = absente = « dépendance inconnue ».
  const parDepot = new Map();
  for (const [cle, issue] of deps) {
    if (!issue) continue;
    const [d, n] = cle.split('#');
    if (d === nom.toLowerCase() && nodes[n]) continue;
    const noeud = { n: Number(n), title: issue.title ?? '', lvl: 'tâche', labels: noms(issue), state: issue.state === 'open' ? 'open' : 'closed', created: issue.created_at, closed: issue.closed_at ?? null, url: issue.html_url, kids: [], start: null, pr: null, deps: [], deps_natives: [] };
    if (!parDepot.has(d)) parDepot.set(d, {});
    parDepot.get(d)[n] = noeud;
  }
  for (const [d, ns] of parDepot) {
    if (d === nom.toLowerCase()) Object.assign(nodes, Object.fromEntries(Object.entries(ns).filter(([n]) => !nodes[n])));
    else repos.push({ repo: d, key: d, name: d, nodes: ns, hors: [], incidents: [], pr_attend_marc: [] });
  }
  return { asof: maintenant.toISOString(), repos, prlog: [] };
}

/** L'instant où la tâche est devenue prenable : le plus tard entre sa création, la fermeture de sa dernière dépendance et, si les places étaient pleines, la libération de l'une d'elles. */
export function eligibleDepuis({ tache, deps, places, libereA }) {
  const fermetures = (tache.deps ?? []).map((d) => deps.get(d)?.closed_at ?? null);
  const placeLiberee = libereA && places && places.prises + 1 >= places.total ? libereA : null;
  return plusTard(tache.created, ...fermetures, placeLiberee);
}

/**
 * La file du dépôt à cet instant : { statut, suivante, suivantes, places, eligibleDepuis, illisibles }.
 * `suivante` : le numéro de la tâche à lancer (jamais son titre : règle MoKarade/.github#136), null si aucune. Une lecture qui échoue rend { statut: 'illisible' }.
 * `frein` : le résultat de `calculerFrein` si l'appelant le connaît (absent : palier normal). `libereA` : l'heure de l'événement qui libère une place (ISO).
 * `exclure` : numéros de tâches à ne pas compter (la tâche que la PR fusionnée vient de livrer).
 */
export async function fileDuDepot({ api, depot, frein = null, maintenant = new Date(), libereA = null, exclure = [] }) {
  try {
    const lues = await lister(api, `/repos/${depot}/issues?state=open`);
    // `exclure` : les tâches que la PR qui vient de fusionner citait ; leur étiquette `en-cours` n'est remplacée qu'après la fusion, elles ne tiennent plus de place.
    const issues = lues ? lues.filter((i) => !exclure.includes(i.number)) : lues;
    if (!issues) return { statut: 'illisible', suivante: null, suivantes: [], places: null, eligibleDepuis: null, illisibles: [] };
    const prs = ((await lister(api, `/repos/${depot}/pulls?state=open`)) ?? []).filter((pr) => !dispense(pr));
    const attendMarc = prAttendantMarc(issues.filter((i) => noms(i).includes('qui:marc')));
    const fichiersPr = new Map();
    const citees = new Set(prs.flatMap((pr) => extraireTachesCompletes(pr.body, depot).filter((t) => t.depot.toLowerCase() === depot.toLowerCase()).map(() => pr.number)));
    for (const n of citees) fichiersPr.set(n, await fichiersReels(api, depot, n));
    // Les dépendances à lire : celles des tâches ouvertes qui ne sont pas elles-mêmes des tâches ouvertes de ce dépôt.
    const nom = depot.split('/').pop().toLowerCase();
    const ouvertes = new Set(issues.filter((i) => !i.pull_request).map((i) => i.number));
    const aLire = new Set();
    for (const i of issues) {
      if (i.pull_request || !noms(i).includes(LABEL_TACHE)) continue;
      for (const d of lireAttend(i.body, nom)) {
        const [dd, n] = d.split('#');
        if (!(dd === nom && ouvertes.has(Number(n)))) aLire.add(d);
      }
    }
    const deps = new Map();
    const illisibles = [];
    for (const d of aLire) {
      const [dd, n] = d.split('#');
      try {
        const issue = await api('GET', `/repos/${PROPRIETAIRE}/${dd}/issues/${n}`);
        deps.set(d, issue ?? null);
        if (!issue) illisibles.push(d);
      } catch {
        deps.set(d, null);
        illisibles.push(d);
      }
    }
    const releve = construireReleve({ depot, issues, prs, attendMarc, fichiersPr, deps, maintenant });
    const resultat = calculer(releve, { frein, maintenant });
    const d = resultat.depots.find((x) => x.repo === releve.repos[0].repo);
    const numero = d.suivante?.n ?? null;
    const tache = numero ? releve.repos[0].nodes[numero] : null;
    return {
      statut: d.statut,
      suivante: numero,
      suivantes: d.suivantes.map((s) => s.n),
      places: d.places,
      eligibleDepuis: tache ? eligibleDepuis({ tache, deps, places: d.places, libereA }) : null,
      illisibles,
      occupePar: d.occupe_par,
      incidents: d.incidents,
    };
  } catch (e) {
    return { statut: 'illisible', suivante: null, suivantes: [], places: null, eligibleDepuis: null, illisibles: [], erreur: e.message };
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const depot = process.argv[2] ?? process.env.GITHUB_REPOSITORY;
  const jeton = process.env.GITHUB_TOKEN;
  const api = async (methode, chemin) => {
    const r = await fetch(`https://api.github.com${chemin}`, { method: methode, headers: { authorization: `Bearer ${jeton}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'file-depot' } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`HTTP ${r.status} sur ${methode} ${chemin}`);
    return r.json();
  };
  console.log(JSON.stringify(await fileDuDepot({ api, depot }), null, 1));
}
