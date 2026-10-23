#!/usr/bin/env node
// Contrôle automatique de la preuve d'une tâche en `preuve-attendue` (tâche MoKarade/.github#248, demande de Marc du 19/10/2026 :
// « c'est automatiquement que ça doit se faire »). Une preuve n'attend jamais Marc : la tâche porte une ligne `**Contrôle**` dans un format
// FERMÉ (docs/cycle-de-vie-tache.md §10 quater), ce script va voir la production et dit ce qu'il a observé. Il ne pose jamais « Acceptée » :
// le fil de la tâche le fait, avec la PR, le déploiement et le résultat observé ici (le garde-fou de preuve exige la PR fusionnée).
//
// Trois sortes de contrôle, rien d'autre (aucun JavaScript libre, aucune URL hors hubperso.com) :
//   **Contrôle** : http https://<hôte>.hubperso.com/chemin statut 200 [contient "texte"]
//   **Contrôle** : navigateur https://<hôte>.hubperso.com/chemin texte "texte visible"
//   **Contrôle** : actions MoKarade/<dépôt> <workflow>.yml réussi depuis 2026-10-22T23:30:00Z
//
// Fonctions pures d'un côté (`lireControles`, `valider`, `corpsResume`), I/O de l'autre (`executer`, avec `fetch` et `navigateur` injectés :
// les tests n'ont besoin ni de réseau ni de Chromium). Jamais de secret : lecture anonyme, ou le jeton du job pour l'API GitHub.
import { createRequire } from 'node:module';
import { appendFileSync } from 'node:fs';

export const HOTE_PERMIS = /(^|\.)hubperso\.com$/i;
export const DELAI_MS = 15_000;
const LIGNE = /^[\s>*_-]*\*{0,2}\s*Contr[ôo]le\s*\*{0,2}\s*:\s*(.+?)\s*$/gim;
const TEXTE = '"([^"\\n]{1,200})"';

const url = (s) => {
  let u;
  try { u = new URL(s); } catch { return null; }
  return u.protocol === 'https:' && !u.username && !u.password && HOTE_PERMIS.test(u.hostname) ? u : null;
};

/** Lit UNE ligne de contrôle. Rend { type, ... } ou { erreur } (jamais d'exception : une ligne mal écrite est dite, pas ignorée). */
export function lireLigne(texte) {
  const t = String(texte).trim();
  let m = t.match(new RegExp(`^http (\\S+) statut (\\d{3})(?: contient ${TEXTE})?$`, 'i'));
  if (m) return url(m[1]) ? { type: 'http', url: m[1], statut: Number(m[2]), contient: m[3] ?? null } : { erreur: `adresse refusée (https et hubperso.com seulement) : ${m[1]}` };
  m = t.match(new RegExp(`^navigateur (\\S+) texte ${TEXTE}$`, 'i'));
  if (m) return url(m[1]) ? { type: 'navigateur', url: m[1], texte: m[2] } : { erreur: `adresse refusée (https et hubperso.com seulement) : ${m[1]}` };
  m = t.match(/^actions ([\w.-]+\/[\w.-]+) ([\w.-]+\.ya?ml) r[ée]ussi depuis (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z)$/i);
  if (m) return Number.isFinite(Date.parse(m[3])) ? { type: 'actions', depot: m[1], workflow: m[2], depuis: m[3] } : { erreur: `date illisible : ${m[3]}` };
  return { erreur: `format inconnu (http, navigateur ou actions) : ${t.slice(0, 80)}` };
}

/** Toutes les lignes `**Contrôle** : …` d'un texte (corps d'issue ou commentaire). */
export function lireControles(texte) {
  return [...String(texte ?? '').matchAll(LIGNE)].map((m) => ({ ligne: m[1], ...lireLigne(m[1]) }));
}

/** Une tâche peut être contrôlée si elle est ouverte, en `preuve-attendue`, avec au moins un contrôle et aucune ligne illisible. */
export function valider({ issue, controles }) {
  if (!issue || issue.state !== 'open') return { ok: false, raison: 'la tâche est fermée ou introuvable' };
  const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
  if (!labels.includes('preuve-attendue')) return { ok: false, raison: "la tâche n'est pas en preuve-attendue" };
  if (!controles.length) return { ok: false, raison: 'aucune ligne **Contrôle** : la tâche doit dire ce qui se vérifie' };
  const mauvais = controles.find((c) => c.erreur);
  return mauvais ? { ok: false, raison: `ligne illisible : ${mauvais.erreur}` } : { ok: true, raison: '' };
}

const court = (s, n = 160) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));

/** Exécute un contrôle. Rend { ok, observe } : `observe` dit ce qui a VRAIMENT été vu, en une phrase, succès ou échec. */
export async function executer(c, { fetch: f = globalThis.fetch, navigateur = null, jeton = '', maintenant = () => Date.now() } = {}) {
  try {
    if (c.type === 'http') {
      const r = await f(c.url, { redirect: 'manual', signal: AbortSignal.timeout(DELAI_MS), headers: { 'user-agent': 'controle-preuve (MoKarade/.github#248)' } });
      const corps = c.contient ? await r.text() : '';
      const statutOk = r.status === c.statut;
      const contientOk = !c.contient || corps.includes(c.contient);
      const observe = `GET ${c.url} → HTTP ${r.status}${c.contient ? (contientOk ? `, contient « ${c.contient} »` : `, ne contient pas « ${c.contient} »`) : ''}`;
      return { ok: statutOk && contientOk, observe };
    }
    if (c.type === 'navigateur') {
      if (!navigateur) return { ok: false, observe: "aucun navigateur disponible : le contrôle n'a pas pu être fait" };
      const vu = await navigateur(c.url, c.texte);
      return { ok: vu.ok, observe: `navigateur ${c.url} → ${vu.ok ? `texte « ${c.texte} » visible` : `texte « ${c.texte} » absent (${court(vu.detail ?? '')})`}` };
    }
    if (c.type === 'actions') {
      const en = { accept: 'application/vnd.github+json', ...(jeton ? { authorization: `Bearer ${jeton}` } : {}) };
      const r = await f(`https://api.github.com/repos/${c.depot}/actions/workflows/${c.workflow}/runs?per_page=30&created=%3E%3D${encodeURIComponent(c.depuis)}`, { headers: en, signal: AbortSignal.timeout(DELAI_MS) });
      if (!r.ok) return { ok: false, observe: `API GitHub : HTTP ${r.status} pour ${c.depot}/${c.workflow}` };
      const runs = ((await r.json()).workflow_runs ?? []).filter((x) => x.status === 'completed');
      const bon = runs.find((x) => x.conclusion === 'success');
      if (bon) return { ok: true, observe: `${c.depot}/${c.workflow} : run ${bon.id} réussi (${bon.event}, ${bon.created_at}) ${bon.html_url}` };
      const dernier = runs[0];
      return { ok: false, observe: dernier ? `${c.depot}/${c.workflow} : aucun succès depuis ${c.depuis}, dernier run ${dernier.id} « ${dernier.conclusion} »` : `${c.depot}/${c.workflow} : aucun run terminé depuis ${c.depuis}` };
    }
    return { ok: false, observe: `type inconnu : ${c.type}` };
  } catch (e) {
    return { ok: false, observe: `${c.type ?? 'contrôle'} impossible : ${court(e?.message ?? e)}` };
  }
}

/** Le texte à reprendre dans « preuve : » de l'Acceptée, ou le refus. `resultats` : [{ ligne, ok, observe }]. */
export function corpsResume(resultats) {
  const ok = resultats.length > 0 && resultats.every((r) => r.ok);
  const lignes = resultats.map((r) => `- ${r.ok ? 'OK' : 'ÉCHEC'} : ${r.observe}`);
  return { ok, texte: `${ok ? 'Contrôle automatique : tout est vu.' : 'Contrôle automatique : la preuve est REFUSÉE, rien ne se ferme.'}\n${lignes.join('\n')}` };
}

/** Navigateur réel : Chromium de Playwright installé à part (dossier d'outils), jamais une dépendance du dépôt. */
export function navigateurPlaywright(dossierOutils) {
  return async (adresse, texte) => {
    const { chromium } = createRequire(`${dossierOutils}/`)('playwright');
    const b = await chromium.launch();
    try {
      const page = await b.newPage();
      await page.goto(adresse, { timeout: DELAI_MS, waitUntil: 'domcontentloaded' });
      await page.getByText(texte, { exact: false }).first().waitFor({ state: 'visible', timeout: DELAI_MS });
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: e?.message ?? String(e) };
    } finally {
      await b.close();
    }
  };
}

async function gh(chemin, jeton) {
  const r = await fetch(`https://api.github.com${chemin}`, { headers: { accept: 'application/vnd.github+json', ...(jeton ? { authorization: `Bearer ${jeton}` } : {}) }, signal: AbortSignal.timeout(DELAI_MS) });
  if (!r.ok) throw new Error(`API GitHub ${chemin} : HTTP ${r.status}`);
  return r.json();
}

async function principal() {
  const [, , ref, ...opts] = process.argv;
  const m = String(ref ?? '').match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  if (!m) { console.error('usage : node scripts/controle-preuve.mjs <propriétaire/dépôt>#<numéro>'); process.exit(2); }
  const jeton = process.env.GITHUB_TOKEN ?? '';
  const [depot, numero] = [m[1], Number(m[2])];
  const issue = await gh(`/repos/${depot}/issues/${numero}`, jeton);
  // Le corps de la tâche, plus les commentaires de son propriétaire : un commentaire d'un tiers ne choisit pas ce qu'on va voir.
  const commentaires = (await gh(`/repos/${depot}/issues/${numero}/comments?per_page=100`, jeton)).filter((c) => c.author_association === 'OWNER');
  const controles = [issue.body, ...commentaires.map((c) => c.body)].flatMap(lireControles);
  const v = valider({ issue, controles });
  let resultats = [];
  if (v.ok) {
    const outils = process.env.CONTROLE_OUTILS;
    const nav = controles.some((c) => c.type === 'navigateur') && outils ? navigateurPlaywright(outils) : null;
    resultats = [];
    for (const c of controles) resultats.push({ ligne: c.ligne, ...(await executer(c, { navigateur: nav, jeton })) });
  }
  const resume = v.ok ? corpsResume(resultats) : { ok: false, texte: `Contrôle impossible : ${v.raison}.` };
  const sortie = { tache: `${depot}#${numero}`, ok: resume.ok, resultats, texte: resume.texte };
  console.log(JSON.stringify(sortie, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${sortie.tache}\n${resume.texte}\n`);
  if (opts.includes('--strict') && !resume.ok) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) principal().catch((e) => { console.error(e); process.exit(1); });
