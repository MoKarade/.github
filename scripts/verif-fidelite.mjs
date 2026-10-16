#!/usr/bin/env node
// Fidélité du Gantt (plan commun/plans/2026-10-16_gantt-source-de-verite.md, §6) : compare le relevé `backlog.json` à une
// relecture directe de GitHub et écrit `fiabilite.json`, avec son historique. Quatre mesures :
//   I1 cohérence : défauts de la pastille (donnés par l'appelant, `--defauts N`)
//   I2 fidélité : écarts entre le relevé et GitHub (état, étiquettes, PR liée) sur les tâches ouvertes et les fermées
//      depuis 48 h ; une tâche modifiée APRÈS le relevé n'est pas un écart (comptée à part)
//   I3 prise tracée : PR de tâche dont l'issue a reçu `en-cours` au plus 10 min après l'ouverture (posé par le balayage) ; PR fusionnées sans tâche (hors
//      robots) ; branches `claude/*` sans tâche ; `en-cours` posé depuis des heures sans PR. Mesuré depuis `--depuis`
//      (par défaut la fusion du contrôle « tâche liée »), pour ne pas juger l'avant-règle
//   I4 accord file/agents (mesuré depuis `--depuis-i4`, par défaut `--depuis` : la date où la boucle du Gantt est fiable ; un lancement sur
//      une file de plus de 40 min est listé dans `perimes`) : une tâche lancée était-elle la `suivante` de `prochaines.json` au dernier calcul avant son
//      lancement ? Les `suivante` de chaque calcul sont gardées dans `snapshots` (à chaque tour de 10 min par `--snapshot-seulement`, sans refaire la mesure).
// L'historique n'est JAMAIS remis à zéro : `consecutifs_a_zero` compte les relevés de queue avec I1 = I2 = 0.
// Fonctions pures d'un côté (`mesurer`, `ajouterAHistorique`), I/O de l'autre (`lireVivant`, `main` avec `gh api`).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dispense, extraireTaches } from './tache-liee.mjs';

export const VERSION = 1;
export const DEPUIS_DEFAUT = '2026-10-16T18:00:13Z'; // fusion de .github#125 (règle « tâche liée »)
export const FENETRE_H = 48;
export const BORNE_RELEVE = '2026-10-15T00:00:00Z'; // fetch.py ne lit que les issues modifiées depuis ce jour
export const SEUIL_PRISE_H = 3;
export const TOLERANCE_PRISE_MIN = 10; // `en-cours` peut être posé jusqu'à 10 min après l'ouverture de la PR (balayage par événement, MoKarade/.github#157)
export const CIBLE_RELEVES = 20;
const FENETRE_LANCEMENT_MIN = 60;
export const SEUIL_PERIME_MIN = 40; // au-delà, la file qui a servi au lancement était périmée (la routine l'ignore aussi)
const BRANCHES_IGNOREES = new Set(['claude/boite-reacteur']);
// Ancienne forme que le relevé accepte encore : la PR est nommée dans le corps de l'issue, sans lien depuis la PR.
const PR_DANS_LE_CORPS = /PR déjà ouverte\*\*\s*:\s*#(\d+)/;
const CLOSES = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:MoKarade\/([\w.-]+))?#(\d+)\b/gi;

const minuscule = (s) => String(s).toLowerCase();
const ref = (depot, n) => `${minuscule(depot)}#${n}`;
const heures = (a, b) => (Date.parse(a) - Date.parse(b)) / 3600000;
const noms = (labels) => (labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)).sort();
/** Début de la fenêtre des tâches fermées : 48 h avant le relevé, jamais avant la borne que lit fetch.py. */
const debutFenetre = (asof) => new Date(Math.max(Date.parse(asof) - FENETRE_H * 3600000, Date.parse(BORNE_RELEVE))).toISOString().replace('.000Z', 'Z');
const etatPr = (p) => (p.merged_at || p.merged ? 'fusionnée' : p.state === 'open' ? 'ouverte' : 'fermée');

/** Les tâches citées par une PR vivante (ligne « Tâche : » ou Closes), en références « dépôt#n ». */
function citations(pull, depot) {
  const refs = new Set(extraireTaches(pull.body, depot).map((t) => ref(t.depot, t.numero)));
  for (const [, d, n] of String(pull.body ?? '').matchAll(CLOSES)) refs.add(ref(d ?? depot, n));
  return refs;
}

/** La PR qui compte pour une tâche : ouverte d'abord, sinon la dernière fusionnée, sinon la dernière fermée. */
function prVivante(refTache, parTache) {
  const liste = parTache.get(refTache) ?? [];
  const rang = (p) => [p.state === 'open' ? 2 : p.merged_at ? 1 : 0, p.merged_at ?? p.created_at];
  return [...liste].sort((a, b) => { const [x, y] = [rang(a), rang(b)]; return y[0] - x[0] || (y[1] > x[1] ? 1 : y[1] < x[1] ? -1 : 0); })[0] ?? null;
}

function indexerPulls(vivant) {
  const parTache = new Map();
  const toutes = [];
  for (const [depot, v] of Object.entries(vivant)) {
    for (const p of v.pulls ?? []) {
      toutes.push({ depot, p });
      for (const r of citations(p, depot)) parTache.set(r, [...(parTache.get(r) ?? []), p]);
    }
  }
  return { parTache, toutes };
}

/** I2 : le relevé contre GitHub. */
function mesurerI2(releve, vivant, parTache) {
  const asof = releve.asof;
  const debut = debutFenetre(asof);
  const ecarts = [];
  const posterieurs = [];
  let verifiees = 0;
  for (const depot of releve.repos) {
    const live = new Map((vivant[depot.repo]?.issues ?? []).map((i) => [i.number, i]));
    const dansPerimetre = (n) => n.lvl === 'tâche' && (n.state === 'open' || (n.closed && n.closed >= debut));
    const connues = new Set();
    for (const n of Object.values(depot.nodes).filter(dansPerimetre)) {
      const r = ref(depot.repo, n.n);
      connues.add(n.n);
      const i = live.get(n.n);
      if (!i) { ecarts.push({ ref: r, champ: 'introuvable', releve: n.state, vivant: 'absente de GitHub (ouvertes et fermées récentes)' }); verifiees += 1; continue; }
      if (i.updated_at > asof) { posterieurs.push(r); continue; }
      verifiees += 1;
      if (i.state !== n.state) ecarts.push({ ref: r, champ: 'état', releve: n.state, vivant: i.state });
      const [a, b] = [noms(n.labels).join(','), noms(i.labels).join(',')];
      if (a !== b) ecarts.push({ ref: r, champ: 'étiquettes', releve: a, vivant: b });
      let p = prVivante(r, parTache);
      const ancienne = PR_DANS_LE_CORPS.exec(i.body ?? '');
      if (!p && ancienne) p = (vivant[depot.repo]?.pulls ?? []).find((x) => x.number === Number(ancienne[1])) ?? null;
      if (p && (p.updated_at ?? '') > asof) { posterieurs.push(`${r} (PR)`); continue; }
      const attendu = p ? `PR ${p.number} ${etatPr(p)}` : 'aucune PR';
      const lu = n.pr ? `PR ${n.pr.n} ${n.pr.state === 'open' ? 'ouverte' : n.pr.merged ? 'fusionnée' : 'fermée'}` : 'aucune PR';
      if (attendu !== lu) ecarts.push({ ref: r, champ: 'PR liée', releve: lu, vivant: attendu });
    }
    // Une tâche vivante que le relevé ne montre pas du tout.
    for (const i of live.values()) {
      const recente = i.state === 'open' || (i.closed_at && i.closed_at >= debut);
      if (!recente || connues.has(i.number) || i.created_at > asof || i.updated_at > asof) continue;
      verifiees += 1;
      ecarts.push({ ref: ref(depot.repo, i.number), champ: 'absente du relevé', releve: 'absente', vivant: i.state });
    }
  }
  return { verifiees, ecarts, posterieurs };
}

/** I3 : la prise est tracée avant la PR, et aucune PR ni branche n'échappe au backlog. */
function mesurerI3(releve, vivant, toutes, depuis, seuilPriseH) {
  const nonTracees = [];
  let total = 0;
  const prises = [];
  for (const depot of releve.repos) {
    for (const n of Object.values(depot.nodes).filter((x) => x.lvl === 'tâche')) {
      const r = ref(depot.repo, n.n);
      if (n.pr && n.pr.created >= depuis) {
        total += 1;
        if (!n.start || (Date.parse(n.start) - Date.parse(n.pr.created)) / 60000 > TOLERANCE_PRISE_MIN) nonTracees.push(r);
      }
      const sansPr = !n.pr || n.pr.state !== 'open';
      if (n.state === 'open' && n.labels.includes('en-cours') && !n.labels.includes('jules') && sansPr && n.start && heures(releve.asof, n.start) > seuilPriseH) prises.push(r);
    }
  }
  const sansTache = toutes
    .filter(({ p }) => p.merged_at && p.merged_at >= depuis && !dispense(p) && extraireTaches(p.body, '').length === 0)
    .map(({ depot, p }) => `${minuscule(depot)}#${p.number}`);
  const branches = [];
  for (const [depot, v] of Object.entries(vivant)) {
    for (const b of v.branches ?? []) {
      if (BRANCHES_IGNOREES.has(b.name) || b.date < depuis) continue;
      const liee = (v.pulls ?? []).some((p) => p.head?.ref === b.name && extraireTaches(p.body, depot).length > 0);
      if (!liee) branches.push(`${minuscule(depot)}:${b.name}`);
    }
  }
  return {
    prise: { total, tracees: total - nonTracees.length, non_tracees: nonTracees, taux: total ? (total - nonTracees.length) / total : null },
    sans_tache: sansTache, branches_sans_tache: branches, prises_sans_pr: prises,
  };
}

/** I4 : chaque tâche lancée depuis `depuis` était-elle la suivante annoncée juste avant ? */
function mesurerI4(releve, snapshots, depuis) {
  const ecarts = [];
  let accords = 0;
  let nonEvaluables = 0;
  const perimes = [];
  for (const depot of releve.repos) {
    const vus = (snapshots[minuscule(depot.repo)] ?? []).slice().sort((a, b) => (a.asof < b.asof ? -1 : 1));
    for (const n of Object.values(depot.nodes).filter((x) => x.lvl === 'tâche' && x.start && x.start >= depuis && x.start <= releve.asof)) {
      const avant = vus.filter((s) => s.asof <= n.start && heures(n.start, s.asof) * 60 <= FENETRE_LANCEMENT_MIN).pop();
      const r = ref(depot.repo, n.n);
      if (!avant) { nonEvaluables += 1; continue; }
      const age = Math.round(heures(n.start, avant.asof) * 60);
      if (age > SEUIL_PERIME_MIN) perimes.push({ ref: r, lance: n.start, calcul: avant.asof, age_min: age });
      if (avant.suivante === r) accords += 1;
      else ecarts.push({ ref: r, lance: n.start, annoncee: avant.suivante ?? `(${avant.statut})`, calcul: avant.asof });
    }
  }
  const lancements = accords + ecarts.length;
  return { lancements, accords, taux: lancements ? accords / lancements : null, ecarts, non_evaluables: nonEvaluables, perimes };
}

/** Garde la `suivante` de ce calcul de prochaines.json, 72 h au plus, par dépôt. */
function majSnapshots(anciens, prochaines) {
  const sortie = { ...anciens };
  const asof = prochaines?.calcule_le ?? prochaines?.source_asof;
  if (!asof) return sortie;
  const limite = new Date(Date.parse(asof) - 72 * 3600000).toISOString();
  for (const d of prochaines.depots ?? []) {
    const cle = minuscule(d.repo);
    const liste = (sortie[cle] ?? []).filter((s) => s.asof >= limite && s.asof !== asof);
    liste.push({ asof, statut: d.statut, suivante: d.suivante?.ref ?? null });
    sortie[cle] = liste;
  }
  return sortie;
}

/**
 * Les quatre mesures d'un relevé.
 * @param entree { releve, vivant, prochaines, snapshots, depuis, depuisI4, defauts, seuilPriseH } ; `depuisI4` (défaut `depuis`) : début de la mesure I4
 */
export function mesurer({ releve, vivant, prochaines = null, snapshots = {}, depuis = DEPUIS_DEFAUT, defauts = null, seuilPriseH = SEUIL_PRISE_H, depuisI4 = depuis }) {
  const { parTache, toutes } = indexerPulls(vivant);
  const i2 = mesurerI2(releve, vivant, parTache);
  const i3 = mesurerI3(releve, vivant, toutes, depuis, seuilPriseH);
  const i4 = mesurerI4(releve, snapshots, depuisI4);
  const alertes = [];
  if (defauts === null) alertes.push('I1 non fourni (--defauts N) : le relevé ne compte pas pour la preuve');
  if (!prochaines) alertes.push('prochaines.json absent : I4 non mesurable sur ce relevé');
  if (i3.prises_sans_pr.length) alertes.push(`${i3.prises_sans_pr.length} tâche(s) en-cours sans PR depuis plus de ${seuilPriseH} h`);
  if (i4.perimes.length) alertes.push(`${i4.perimes.length} lancement(s) sur une file de plus de ${SEUIL_PERIME_MIN} min : ${i4.perimes.map((x) => x.ref).join(', ')}`);
  return { releve_asof: releve.asof, depuis, depuis_i4: depuisI4, i1: { defauts }, i2, i3, i4, alertes, snapshots: majSnapshots(snapshots, prochaines) };
}

/**
 * Garde la file de CE calcul sans refaire la mesure (appelé à chaque tour de 10 minutes) : I4 juge ainsi un lancement contre le
 * dernier calcul réel avant lui, pas contre celui de la mesure horaire précédente. Ne touche à rien d'autre dans le fichier.
 */
export function ajouterSnapshot(fichier, prochaines) {
  return { ...fichier, snapshots: majSnapshots(fichier.snapshots ?? {}, prochaines) };
}

const nul = (m) => m.i1.defauts === 0 && m.i2.ecarts.length === 0;
const i3propre = (m) => m.i3.prise.non_tracees.length + m.i3.sans_tache.length + m.i3.branches_sans_tache.length === 0;

/** Ajoute le relevé à l'historique (une ligne par relevé, jamais effacée) et rend le fichier complet. */
export function ajouterAHistorique(precedent, mesure, calculeLe) {
  const ligne = {
    releve: mesure.releve_asof, mesure: calculeLe, i1: mesure.i1.defauts, i2: mesure.i2.ecarts.length, i2_verifiees: mesure.i2.verifiees,
    i3_non_tracees: mesure.i3.prise.non_tracees.length, i3_sans_tache: mesure.i3.sans_tache.length, i3_branches: mesure.i3.branches_sans_tache.length,
    i3_prises_sans_pr: mesure.i3.prises_sans_pr.length, i4_lancements: mesure.i4.lancements, i4_accords: mesure.i4.accords, a_zero: nul(mesure),
  };
  const historique = [...(precedent?.historique ?? []).filter((l) => l.releve !== ligne.releve), ligne].sort((a, b) => (a.releve < b.releve ? -1 : 1)).slice(-2000);
  let consecutifs = 0;
  for (let k = historique.length - 1; k >= 0 && historique[k].a_zero; k -= 1) consecutifs += 1;
  const { snapshots, ...reste } = mesure;
  return {
    version: VERSION, calcule_le: calculeLe, ...reste, consecutifs_a_zero: consecutifs, cible_releves: CIBLE_RELEVES,
    preuve: { i1_i2: consecutifs >= CIBLE_RELEVES, i3: i3propre(mesure) && mesure.i3.prise.taux !== 0, i4: mesure.i4.taux === 1 && mesure.i4.lancements >= 5 },
    historique, snapshots,
  };
}

// ── Entrées/sorties : GitHub par `gh api` (le relais refuse les liens de pagination : page=N à la main) ──────────

export function apiGh(chemin) {
  return JSON.parse(execFileSync('gh', ['api', chemin], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
}

function pages(api, chemin, { max = 10, arret = () => false } = {}) {
  const sortie = [];
  for (let page = 1; page <= max; page += 1) {
    const lot = api(`${chemin}${chemin.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    sortie.push(...lot);
    if (lot.length < 100 || arret(lot)) break;
  }
  return sortie;
}

/** Ce que GitHub dit MAINTENANT, par dépôt : tâches ouvertes et fermées récentes, PR récentes, branches claude/*. */
export function lireVivant(api, depots, { asof, depuis }) {
  const debut = debutFenetre(asof);
  const etiquette = `labels=${encodeURIComponent('niveau:tâche')}`;
  const vivant = {};
  for (const depot of depots) {
    const base = `/repos/MoKarade/${depot}`;
    const sansPr = (i) => !i.pull_request;
    const issues = [
      ...pages(api, `${base}/issues?state=open&${etiquette}`).filter(sansPr),
      ...pages(api, `${base}/issues?state=closed&${etiquette}&since=${debut}`).filter(sansPr),
    ];
    const limite = depuis < debut ? depuis : debut;
    const pulls = [
      ...pages(api, `${base}/pulls?state=open`),
      ...pages(api, `${base}/pulls?state=closed&sort=updated&direction=desc`, { max: 5, arret: (lot) => lot[lot.length - 1].updated_at < limite }),
    ];
    const branches = [];
    for (const b of pages(api, `${base}/branches`).filter((x) => x.name.startsWith('claude/'))) {
      const detail = api(`${base}/branches/${encodeURI(b.name)}`);
      branches.push({ name: b.name, date: detail.commit?.commit?.committer?.date ?? '' });
    }
    vivant[depot] = { issues, pulls, branches };
  }
  return vivant;
}

function lireArguments(argv) {
  const o = { snapshotSeulement: false, releve: null, prochaines: null, sortie: null, defauts: null, depuis: DEPUIS_DEFAUT, depuisI4: null, seuilPriseH: SEUIL_PRISE_H };
  for (let k = 0; k < argv.length; k += 1) {
    if (argv[k] === '--snapshot-seulement') o.snapshotSeulement = true;
    else if (argv[k] === '--sortie') o.sortie = argv[++k];
    else if (argv[k] === '--defauts') o.defauts = Number(argv[++k]);
    else if (argv[k] === '--depuis') o.depuis = argv[++k];
    else if (argv[k] === '--depuis-i4') o.depuisI4 = argv[++k];
    else if (argv[k] === '--seuil-prise-h') o.seuilPriseH = Number(argv[++k]);
    else if (!o.releve) o.releve = argv[k];
    else if (!o.prochaines) o.prochaines = argv[k];
  }
  return o;
}

/** `--snapshot-seulement prochaines.json --sortie fiabilite.json` : la date du fichier reste celle de la dernière MESURE (la boucle du Gantt la lit pour décider quand remesurer). */
function mainSnapshot(o) {
  const chemin = o.releve; // premier argument positionnel : prochaines.json
  if (!chemin || !o.sortie) {
    console.error('usage : node scripts/verif-fidelite.mjs --snapshot-seulement prochaines.json --sortie fiabilite.json');
    process.exit(2);
  }
  if (!existsSync(o.sortie)) { console.log('Aucun fiabilite.json : rien à compléter.'); return; }
  const fichier = ajouterSnapshot(JSON.parse(readFileSync(o.sortie, 'utf8')), JSON.parse(readFileSync(chemin, 'utf8')));
  const date = statSync(o.sortie);
  writeFileSync(`${o.sortie}.tmp`, `${JSON.stringify(fichier, null, 1)}\n`);
  utimesSync(`${o.sortie}.tmp`, date.atime, date.mtime);
  renameSync(`${o.sortie}.tmp`, o.sortie);
  console.log(`Instantané de file gardé (${Object.keys(fichier.snapshots).length} dépôts).`);
}

function main() {
  const o = lireArguments(process.argv.slice(2));
  if (o.snapshotSeulement) return mainSnapshot(o);
  if (!o.releve || !o.sortie) {
    console.error('usage : node scripts/verif-fidelite.mjs backlog.json [prochaines.json] --sortie fiabilite.json [--defauts N] [--depuis ISO] [--depuis-i4 ISO] [--seuil-prise-h H]');
    process.exit(2);
  }
  const releve = JSON.parse(readFileSync(o.releve, 'utf8'));
  const prochaines = o.prochaines && existsSync(o.prochaines) ? JSON.parse(readFileSync(o.prochaines, 'utf8')) : null;
  const precedent = existsSync(o.sortie) ? JSON.parse(readFileSync(o.sortie, 'utf8')) : null;
  const vivant = lireVivant(apiGh, releve.repos.map((d) => d.repo), { asof: releve.asof, depuis: o.depuis });
  const mesure = mesurer({ releve, vivant, prochaines, snapshots: precedent?.snapshots ?? {}, depuis: o.depuis, depuisI4: o.depuisI4 ?? o.depuis, defauts: Number.isFinite(o.defauts) ? o.defauts : null, seuilPriseH: o.seuilPriseH });
  const fichier = ajouterAHistorique(precedent, mesure, new Date().toISOString());
  writeFileSync(`${o.sortie}.tmp`, `${JSON.stringify(fichier, null, 1)}\n`);
  renameSync(`${o.sortie}.tmp`, o.sortie);
  console.log(`I2 : ${mesure.i2.ecarts.length} écart(s) sur ${mesure.i2.verifiees} · I3 : ${mesure.i3.prise.non_tracees.length} non tracée(s), ${mesure.i3.sans_tache.length} sans tâche, ${mesure.i3.branches_sans_tache.length} branche(s) · I4 : ${mesure.i4.accords}/${mesure.i4.lancements} · à zéro de suite : ${fichier.consecutifs_a_zero}/${CIBLE_RELEVES}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
