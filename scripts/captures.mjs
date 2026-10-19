#!/usr/bin/env node
// Captures avant/après d'une PR qui change un écran (tâche #31, cycle de vie §8), appelé par
// .github/workflows/captures.yml. Marc juge un changement d'écran en le VOYANT, pas en lisant du texte.
//
// Trois modes :
//   capturer <urlBase> <dossier>   photographie les pages (CAPTURES_PAGES) d'une app déjà lancée ;
//   publier                        range les images dans la branche `captures` puis commente la PR.
// Les images ne viennent JAMAIS de la production : l'app est lancée par le workflow avec les données fictives
// des tests. Le jeton n'est pas lu ici : `gh auth setup-git` (fait par le workflow) et le CLI `gh` le prennent
// dans l'environnement du job.
//
// Fonctions pures d'un côté (`nomsUniques`, `lirePages`, `commentaire`), I/O de l'autre (navigateur, git, gh)
// injectés ou isolés pour les tests.
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MARQUEUR = '<!-- captures-avant-apres -->';
export const MAX_PAGES = 12;
export const MAX_ETAPES = 20;
export const MAX_STOCKAGE = 10;
const DELAI_ETAPE_MS = 15_000;

/** Nom de fichier d'une page : « / » → accueil, « /a/b?x=1 » → a-b-x-1. */
export function nomImage(chemin) {
  const nom = chemin
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return nom || 'accueil';
}

/** Un nom de fichier unique par page (deux chemins qui donnent le même nom sont numérotés). */
export function nomsUniques(pages) {
  const pris = new Map();
  const noms = {};
  for (const p of pages) {
    const base = nomImage(p);
    const n = (pris.get(base) ?? 0) + 1;
    pris.set(base, n);
    noms[p] = n === 1 ? base : `${base}-${n}`;
  }
  return noms;
}

/** Les pages à photographier : un chemin par ligne, `#` pour un commentaire. Refuse tout ce qui sort de l'app. */
export function lirePages(texte) {
  const pages = [];
  for (const brut of String(texte ?? '').split('\n')) {
    const l = brut.trim();
    if (!l || l.startsWith('#')) continue;
    if (!/^\/[\w\-./%~:@!$&'()*+,;=?#]*$/.test(l) || l.startsWith('//') || l.includes('..')) throw new Error(`page invalide : ${l} (un chemin de l'app, sans « .. »)`);
    if (!pages.includes(l)) pages.push(l);
  }
  if (pages.length === 0) throw new Error('aucune page à photographier (CAPTURES_PAGES vide)');
  if (pages.length > MAX_PAGES) throw new Error(`trop de pages (${pages.length} > ${MAX_PAGES})`);
  return pages;
}

/**
 * Les étapes jouées AVANT de photographier (entrée `etapes`, une par ligne, `#` pour un commentaire) : un format FERMÉ, jamais de JavaScript
 * libre. Quatre verbes :
 *   aller <chemin>                         ouvre une page de l'app ;
 *   cliquer-bouton <nom accessible exact>  clique le bouton de ce nom ;
 *   attendre-texte <texte>                 attend ce texte à l'écran (15 s au plus) ;
 *   pointeur <x> <y>                       place la souris (une navigation qui s'ouvre au survol ne masque plus le contenu).
 * Demandé par le fil Jules pour FinanceAI (mode test à activer par l'écran), 19/10/2026 ; aucune porte d'authentification n'est ajoutée aux apps.
 */
export function lireEtapes(texte) {
  const etapes = [];
  for (const brut of String(texte ?? '').split('\n')) {
    const l = brut.trim();
    if (!l || l.startsWith('#')) continue;
    const m = /^(aller|cliquer-bouton|attendre-texte|pointeur)\s+(.+)$/.exec(l);
    if (!m) throw new Error(`étape invalide : ${l.slice(0, 40)} (verbes : aller, cliquer-bouton, attendre-texte, pointeur)`);
    const [, verbe, arg] = m;
    if (verbe === 'aller') {
      if (!/^\/[\w\-./%~:@!$&'()*+,;=?#]*$/.test(arg) || arg.startsWith('//') || arg.includes('..')) throw new Error(`étape invalide : aller ${arg.slice(0, 40)} (un chemin de l'app, sans « .. »)`);
      etapes.push({ verbe, chemin: arg });
    } else if (verbe === 'pointeur') {
      const xy = /^(\d{1,5})\s+(\d{1,5})$/.exec(arg);
      if (!xy) throw new Error(`étape invalide : pointeur ${arg.slice(0, 20)} (deux nombres : x y)`);
      etapes.push({ verbe, x: Number(xy[1]), y: Number(xy[2]) });
    } else {
      if (arg.length > 80) throw new Error(`étape invalide : ${verbe} (texte de 80 caractères au plus)`);
      etapes.push({ verbe, texte: arg });
    }
  }
  if (etapes.length > MAX_ETAPES) throw new Error(`trop d'étapes (${etapes.length} > ${MAX_ETAPES})`);
  return etapes;
}

/** Les valeurs posées dans le stockage local AVANT le premier chargement (`cle=valeur`, une par ligne) : l'écran d'accueil d'une app se passe ainsi. */
export function lireStockage(texte) {
  const entrees = [];
  for (const brut of String(texte ?? '').split('\n')) {
    const l = brut.trim();
    if (!l || l.startsWith('#')) continue;
    const m = /^([\w.:-]{1,64})=(.{0,200})$/.exec(l);
    if (!m) throw new Error(`stockage-local invalide : ${l.slice(0, 40)} (forme cle=valeur)`);
    entrees.push({ cle: m[1], valeur: m[2] });
  }
  if (entrees.length > MAX_STOCKAGE) throw new Error(`trop d'entrées de stockage local (${entrees.length} > ${MAX_STOCKAGE})`);
  return entrees;
}

/** Joue les étapes sur la page (Playwright en vrai, une fausse en test). Rend la dernière page ouverte (ou null). Une étape qui échoue lève : l'appelant le dit sans détail interne. */
export async function jouerEtapes({ page, etapes, urlBase }) {
  const origine = new URL(urlBase).origin;
  let dernier = null; // la dernière page ouverte par « aller » : le point de départ des pages à photographier
  for (const e of etapes) {
    if (e.verbe === 'aller') {
      const url = new URL(e.chemin, urlBase);
      if (url.origin !== origine) throw new Error(`page hors de l'app : ${e.chemin}`);
      await page.goto(url.toString(), { waitUntil: 'networkidle', timeout: 30_000 });
      dernier = url;
    } else if (e.verbe === 'cliquer-bouton') {
      await page.getByRole('button', { name: e.texte, exact: true }).click({ timeout: DELAI_ETAPE_MS });
    } else if (e.verbe === 'attendre-texte') {
      await page.getByText(e.texte).first().waitFor({ timeout: DELAI_ETAPE_MS });
    } else {
      await page.mouse.move(e.x, e.y);
    }
  }
  return dernier;
}

/**
 * Photographie chaque page avec un navigateur injecté (Playwright en vrai, une fausse en test).
 * Rend et écrit `meta.json` : { [chemin]: { fichier | null, statut, sha256?, erreur? } }. Une page qui répond
 * en erreur ou qui n'existe pas encore (page ajoutée par la PR, côté « avant ») n'a pas d'image : on le dit.
 */
export async function capturer({ urlBase, pages, sortie, largeur = 1280, hauteur = 800, lancerNavigateur, etapes = [], stockage = [] }) {
  mkdirSync(sortie, { recursive: true });
  const origine = new URL(urlBase).origin;
  const noms = nomsUniques(pages);
  const meta = {};
  const navigateur = await lancerNavigateur();
  try {
    const contexte = await navigateur.newContext({ viewport: { width: largeur, height: hauteur } });
    // Posé avant tout chargement, et seulement sur l'origine de l'app.
    if (stockage.length) {
      await contexte.addInitScript(([o, entrees]) => {
        if (location.origin !== o) return;
        for (const [cle, valeur] of entrees) localStorage.setItem(cle, valeur);
      }, [origine, stockage.map((e) => [e.cle, e.valeur])]);
    }
    const page = await contexte.newPage();
    let etapesEnEchec = false;
    let precedente = null;
    if (etapes.length) {
      try {
        precedente = await jouerEtapes({ page, etapes, urlBase });
      } catch {
        // Cause fixe : le message brut d'une erreur de navigateur peut contenir un détail interne.
        etapesEnEchec = true;
      }
    }
    for (const chemin of pages) {
      const url = new URL(chemin, urlBase);
      if (url.origin !== origine) throw new Error(`page hors de l'app : ${chemin}`);
      if (etapesEnEchec) {
        meta[chemin] = { fichier: null, statut: 0, erreur: 'étape impossible' };
        continue;
      }
      try {
        const reponse = await page.goto(url.toString(), { waitUntil: 'networkidle', timeout: 30_000 });
        // Une page qui ne change que le fragment (#DEBT) est une navigation dans le même document : pas de réponse HTTP, et l'app dessine après coup.
        const memeDocument = !reponse && precedente !== null && precedente.origin === url.origin && precedente.pathname === url.pathname && precedente.search === url.search;
        if (memeDocument) await page.waitForTimeout?.(800);
        const statut = reponse?.status() ?? (memeDocument ? 200 : 0);
        precedente = url;
        if (statut === 0 || statut >= 400) {
          meta[chemin] = { fichier: null, statut };
          continue;
        }
        const fichier = `${noms[chemin]}.png`;
        const chemin_png = join(sortie, fichier);
        await page.screenshot({ path: chemin_png, fullPage: true });
        meta[chemin] = { fichier, statut, sha256: createHash('sha256').update(readFileSync(chemin_png)).digest('hex') };
      } catch {
        // Cause fixe : le message brut d'une erreur de navigateur peut contenir un détail interne.
        meta[chemin] = { fichier: null, statut: 0, erreur: 'navigation impossible' };
      }
    }
  } finally {
    await navigateur.close();
  }
  writeFileSync(join(sortie, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  return meta;
}

const lienImage = ({ depot, branche, pr, cote, fichier }) => `https://github.com/${depot}/blob/${branche}/pr-${pr}/${cote}/${fichier}?raw=true`;

/** Le commentaire de la PR : deux images côte à côte par page. `avant`/`apres` = les meta.json (ou null). */
export function commentaire({ depot, pr, sha, pages, avant, apres, branche = 'captures' }) {
  const cellule = (cote, meta, chemin) => {
    const m = meta?.[chemin];
    if (!m) return '_non capturée_';
    if (!m.fichier) return m.erreur ? `_${m.erreur}_` : `_page absente (HTTP ${m.statut})_`;
    return `<img width="380" alt="${cote}" src="${lienImage({ depot, branche, pr, cote, fichier: m.fichier })}">`;
  };
  const lignes = pages.map((chemin) => {
    const a = avant?.[chemin];
    const b = apres?.[chemin];
    const identique = a?.sha256 && a.sha256 === b?.sha256 ? ' (identique)' : '';
    return `| \`${chemin}\`${identique} | ${cellule('avant', avant, chemin)} | ${cellule('apres', apres, chemin)} |`;
  });
  return [
    MARQUEUR,
    '### Captures avant / après',
    '',
    `Commit \`${String(sha).slice(0, 7)}\`. « Avant » = la branche par défaut, « après » = cette PR ; données fictives des tests uniquement, jamais la production.`,
    '',
    '| Page | Avant | Après |',
    '|---|---|---|',
    ...lignes,
    '',
    `Les images sont rangées dans la branche \`${branche}\`, sous \`pr-${pr}/\`.`,
    '',
    '---',
    '_Generated by [Claude Code](https://claude.ai/code)_',
  ].join('\n');
}

/**
 * Range les images dans la branche `captures`, sous pr-<n>/{avant,apres}. La branche garde l'historique
 * (un commit par push de la PR). `remote` est une URL git ; l'authentification vient de `gh auth setup-git`.
 * Rend { pousse: boolean } ; relance jusqu'à 3 fois si un autre push est passé entre-temps.
 */
export function publier({ remote, pr, sha, avant, apres, branche = 'captures' }) {
  const dir = mkdtempSync(join(tmpdir(), 'captures-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git('init', '-q', '-b', branche);
    git('remote', 'add', 'origin', remote);
    git('config', 'user.name', 'github-actions[bot]');
    git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com');
    for (let essai = 1; essai <= 3; essai += 1) {
      try {
        git('fetch', '-q', '--depth', '1', 'origin', branche);
        git('reset', '-q', '--hard', 'FETCH_HEAD');
      } catch (err) {
        // Première PR : la branche n'existe pas encore, on la crée orpheline. Toute autre erreur remonte.
        if (!/couldn't find remote ref/i.test(String(err.stderr))) throw err;
      }
      const cible = join(dir, `pr-${pr}`);
      rmSync(cible, { recursive: true, force: true });
      if (existsSync(avant)) cpSync(avant, join(cible, 'avant'), { recursive: true });
      if (existsSync(apres)) cpSync(apres, join(cible, 'apres'), { recursive: true });
      git('add', '-A');
      if (git('status', '--porcelain').trim() === '') return { pousse: false };
      git('commit', '-q', '-m', `captures de la PR #${pr} (${String(sha).slice(0, 7)})`);
      try {
        git('push', '-q', 'origin', branche);
        return { pousse: true };
      } catch (err) {
        if (essai === 3) throw err;
      }
    }
    return { pousse: false };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Le commentaire marqué déjà posté sur la PR, ou undefined. */
export const trouverCommentaire = (commentaires) => commentaires.find((c) => typeof c.body === 'string' && c.body.includes(MARQUEUR));

const ghReel = (args, entree) =>
  new Promise((resolve, reject) => {
    const enfant = execFile('gh', args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`gh ${args.slice(0, 2).join(' ')} a échoué : ${String(stderr).trim() || err.message}`));
      else resolve(stdout);
    });
    if (entree !== undefined) enfant.stdin.end(entree);
  });

/** Pose le commentaire, ou met à jour celui qui existe (une seule fois par PR, à chaque push). */
export async function commenter({ gh, depot, pr, corps }) {
  const liste = JSON.parse(await gh(['api', '--paginate', '--slurp', `repos/${depot}/issues/${pr}/comments?per_page=100`])).flat();
  const existant = trouverCommentaire(liste);
  const charge = JSON.stringify({ body: corps });
  if (existant) await gh(['api', '--method', 'PATCH', `repos/${depot}/issues/comments/${existant.id}`, '--input', '-'], charge);
  else await gh(['api', '--method', 'POST', `repos/${depot}/issues/${pr}/comments`, '--input', '-'], charge);
  return existant ? 'mis à jour' : 'posé';
}

const lireMeta = (dossier) => {
  try {
    return JSON.parse(readFileSync(join(dossier, 'meta.json'), 'utf8'));
  } catch {
    return null;
  }
};

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  const env = process.env;
  if (mode === 'capturer') {
    const [urlBase, sortie] = args;
    if (!urlBase || !sortie) throw new Error('usage : captures.mjs capturer <urlBase> <dossier>');
    const exiger = createRequire(join(env.CAPTURES_OUTILS || '.', 'x.js'));
    const { chromium } = exiger('playwright');
    const meta = await capturer({
      urlBase,
      pages: lirePages(env.CAPTURES_PAGES),
      sortie,
      largeur: Number(env.CAPTURES_LARGEUR || 1280),
      hauteur: Number(env.CAPTURES_HAUTEUR || 800),
      lancerNavigateur: () => chromium.launch(),
      etapes: lireEtapes(env.CAPTURES_ETAPES),
      stockage: lireStockage(env.CAPTURES_STOCKAGE),
    });
    for (const [chemin, m] of Object.entries(meta)) console.log(`${chemin} : ${m.fichier ?? 'sans image'} (HTTP ${m.statut})`);
  } else if (mode === 'publier') {
    const depot = env.GITHUB_REPOSITORY;
    const pr = env.CAPTURES_PR;
    const sha = env.CAPTURES_SHA;
    const sortie = env.CAPTURES_SORTIE;
    if (!depot || !/^\d+$/.test(pr ?? '') || !sha || !sortie) throw new Error('GITHUB_REPOSITORY, CAPTURES_PR, CAPTURES_SHA et CAPTURES_SORTIE sont requis');
    const avant = join(sortie, 'avant');
    const apres = join(sortie, 'apres');
    const r = publier({ remote: `https://github.com/${depot}.git`, pr, sha, avant, apres });
    console.log(r.pousse ? 'Images poussées dans la branche captures.' : 'Aucun changement dans la branche captures.');
    const corps = commentaire({ depot, pr, sha, pages: lirePages(env.CAPTURES_PAGES), avant: lireMeta(avant), apres: lireMeta(apres) });
    console.log(`Commentaire ${await commenter({ gh: ghReel, depot, pr, corps })}.`);
  } else {
    throw new Error('usage : captures.mjs capturer|publier');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (err) {
    console.error(`::error title=Captures::${err.message}`);
    process.exit(1);
  }
}
