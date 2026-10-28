#!/usr/bin/env node
// Preuve de classe B : lire la page d'une tâche dans GitHub Actions, sans le PC et sans secret (tâche MoKarade/.github#781, mission #703 phase 4).
//
// Après la fusion d'une PR, `preuve-page.yml` (workflow commun, appelé par l'app à la fermeture de la PR) :
//   1. `decider`  : la PR cite UNE tâche ouverte dont le « Fini quand » est de classe B avec ses lignes « Lecture de page » (scripts/fini-quand.mjs) ;
//   2. `lire`     : l'app, lancée avec les DONNÉES FICTIVES des tests comme pour `captures.yml`, est ouverte par un navigateur sans tête qui vérifie
//                   le statut HTTP et le texte attendu de chaque page ;
//   3. `accepter` : `accepterApresFusion` (acceptation-auto.mjs) pose le commentaire « **Acceptée** » et ferme la tâche, APRÈS le déploiement READY
//                   et avec les mêmes garde-fous que l'acceptation automatique de classe A (contrôles verts, aucune attente, aucune autre PR).
// Le commentaire dit que la lecture est FICTIVE (données des tests, jamais la production) : il ne prétend rien d'autre. Si la lecture échoue ou si
// l'acceptation est refusée, la tâche reste ouverte et le Réacteur réveille le fil de l'app (« preuve à poser », type `preuve_page`) : rien ne se perd.
// Aucun minuteur, aucun secret : le jeton du job suffit. Le texte de la page lue n'est jamais recopié (seul le texte ATTENDU, déjà validé, l'est).
//
// Fonctions pures d'un côté (`jugerLecture`, `resumer`), I/O injecté de l'autre (`choisirTache`, `lirePages`, navigateur et API injectés).
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LABELS_ATTENTE, accepterApresFusion } from './acceptation-auto.mjs';
import { jouerEtapes, lireEtapes, lireStockage } from './captures.mjs';
import { controleFiniQuand } from './fini-quand.mjs';
import { LABEL_TACHE } from './preuve.mjs';
import { extraireTachesCompletes } from './tache-liee.mjs';

const noms = (issue) => (issue?.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));

/**
 * La PR fusionnée relève-t-elle de la classe B ? Rend { applicable, motif?, numero?, lectures? }. `api(méthode, chemin, corps)` rend le JSON ou null (404).
 */
export async function choisirTache({ api, depot, numeroPr }) {
  const non = (motif) => ({ applicable: false, motif });
  const pr = await api('GET', `/repos/${depot}/pulls/${numeroPr}`);
  if (!pr?.merged) return non('la PR n’est pas fusionnée');
  const taches = extraireTachesCompletes(pr.body, depot);
  if (taches.length !== 1 || taches[0].depot !== depot) return non('la PR ne cite pas exactement une tâche de ce dépôt');
  const numero = taches[0].numero;
  const issue = await api('GET', `/repos/${depot}/issues/${numero}`);
  if (!issue || issue.state !== 'open' || !noms(issue).includes(LABEL_TACHE)) return non('la tâche n’est pas une tâche ouverte');
  if (noms(issue).some((n) => LABELS_ATTENTE.includes(n))) return non('la tâche attend quelque chose');
  const v = controleFiniQuand(issue.body);
  if (v.classe !== 'B') return non('le « Fini quand » de la tâche n’est pas de classe B');
  if (!v.ok) return non(`classe B mal écrite : ${v.motifs.join(' ; ')}`);
  return { applicable: true, numero, lectures: v.lectures };
}

/** Une page lue est-elle conforme à la lecture demandée ? `lu` : { statut, texteTrouve (booléen), erreur? }. */
export function jugerLecture(lecture, lu) {
  const ligne = `GET ${lecture.chemin} → ${lecture.statut}${lecture.texte ? `, contient « ${lecture.texte} »` : ''}`;
  if (lu.erreur) return { ok: false, detail: `${ligne} : ${lu.erreur}` };
  if (lu.statut !== lecture.statut) return { ok: false, detail: `${ligne} : HTTP ${lu.statut} reçu` };
  if (lecture.texte && !lu.texteTrouve) return { ok: false, detail: `${ligne} : texte absent de la page` };
  return { ok: true, detail: `${ligne} : lu` };
}

/** Le verdict de toutes les lectures : { ok, detail }. Aucune lecture = refus (rien n’a été lu). */
export function resumer(lectures, lus) {
  if (lectures.length === 0 || lus.length !== lectures.length) return { ok: false, detail: 'aucune page lue' };
  const juges = lectures.map((l, i) => jugerLecture(l, lus[i]));
  return { ok: juges.every((j) => j.ok), detail: juges.map((j) => j.detail).join(' ; ') };
}

/**
 * Ouvre chaque page avec un navigateur injecté (Playwright en vrai, une fausse en test). Rend un tableau parallèle à `lectures` :
 * { statut, texteTrouve } ou { erreur }. Une page hors de l'origine de l'app est refusée : le texte d'une tâche est une donnée, pas une adresse libre.
 */
export async function lirePages({ urlBase, lectures, lancerNavigateur, delaiMs = 30_000, etapes = [], stockage = [] }) {
  const origine = new URL(urlBase).origin;
  const navigateur = await lancerNavigateur();
  const lus = [];
  try {
    const contexte = await navigateur.newContext({ viewport: { width: 1280, height: 800 } });
    // Posé avant tout chargement, et seulement sur l'origine de l'app (écran d'accueil déjà passé), comme `captures.yml`.
    if (stockage.length) {
      await contexte.addInitScript(([o, entrees]) => {
        if (location.origin !== o) return;
        for (const [cle, valeur] of entrees) localStorage.setItem(cle, valeur);
      }, [origine, stockage.map((e) => [e.cle, e.valeur])]);
    }
    const page = await contexte.newPage();
    let precedente = null;
    let etapesEnEchec = false;
    if (etapes.length) {
      try {
        precedente = await jouerEtapes({ page, etapes, urlBase });
      } catch {
        // Cause fixe : le message brut d'une erreur de navigateur peut contenir un détail interne.
        etapesEnEchec = true;
      }
    }
    for (const lecture of lectures) {
      const url = new URL(lecture.chemin, urlBase);
      if (url.origin !== origine) {
        lus.push({ erreur: 'page hors de l’app' });
        continue;
      }
      if (etapesEnEchec) {
        lus.push({ erreur: 'étape impossible' });
        continue;
      }
      try {
        const reponse = await page.goto(url.toString(), { waitUntil: 'networkidle', timeout: delaiMs });
        // Une page qui ne change que le fragment (#DEBT) est une navigation dans le même document : pas de réponse HTTP, et l'app dessine après coup.
        const memeDocument = !reponse && precedente !== null && precedente.origin === url.origin && precedente.pathname === url.pathname && precedente.search === url.search;
        if (memeDocument) await page.waitForTimeout?.(800);
        const statut = reponse?.status() ?? (memeDocument ? 200 : 0);
        precedente = url;
        const corps = lecture.texte && statut === lecture.statut ? await page.innerText('body') : '';
        lus.push({ statut, texteTrouve: lecture.texte ? corps.includes(lecture.texte) : true });
      } catch {
        // Cause fixe : le message brut d'une erreur de navigateur peut contenir un détail interne.
        lus.push({ erreur: 'navigation impossible' });
      }
    }
  } finally {
    await navigateur.close();
  }
  return lus;
}

function apiGitHub(jeton) {
  return async function api(methode, chemin, corps) {
    const reponse = await fetch(`https://api.github.com${chemin}`, {
      method: methode,
      headers: {
        authorization: `Bearer ${jeton}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
        'user-agent': 'preuve-page',
      },
      body: corps ? JSON.stringify(corps) : undefined,
    });
    if (reponse.status === 404 && methode === 'GET') return null;
    if (!reponse.ok) throw new Error(`HTTP ${reponse.status} sur ${methode} ${chemin}`);
    return reponse.status === 204 ? null : reponse.json();
  };
}

const sortie = (cle, valeur) => {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${cle}=${valeur}\n`);
  console.log(`${cle}=${valeur}`);
};

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  const env = process.env;
  const depot = env.GITHUB_REPOSITORY;
  const numeroPr = Number(env.PREUVE_PR);
  const dossier = env.PREUVE_DOSSIER || '.';
  const fichierLectures = join(dossier, 'lectures.json');
  const fichierLus = join(dossier, 'lus.json');
  if (!depot || !Number.isInteger(numeroPr) || numeroPr <= 0) throw new Error('GITHUB_REPOSITORY et PREUVE_PR sont requis');
  if (mode === 'decider') {
    const r = await choisirTache({ api: apiGitHub(env.GITHUB_TOKEN), depot, numeroPr });
    console.log(r.applicable ? `Classe B : tâche #${r.numero}, ${r.lectures.length} lecture(s).` : `Classe B : sans objet (${r.motif}).`);
    sortie('applicable', String(r.applicable));
    if (r.applicable) {
      writeFileSync(fichierLectures, JSON.stringify(r.lectures));
      sortie('tache', String(r.numero));
    }
  } else if (mode === 'lire') {
    const [urlBase] = args;
    if (!urlBase) throw new Error('usage : preuve-page.mjs lire <urlBase>');
    const exiger = createRequire(join(env.PREUVE_OUTILS || '.', 'x.js'));
    const { chromium } = exiger('playwright');
    const lectures = JSON.parse(readFileSync(fichierLectures, 'utf8'));
    const lus = await lirePages({ urlBase, lectures, lancerNavigateur: () => chromium.launch(), etapes: lireEtapes(env.PREUVE_ETAPES), stockage: lireStockage(env.PREUVE_STOCKAGE) });
    writeFileSync(fichierLus, JSON.stringify(lus));
    console.log(resumer(lectures, lus).detail);
  } else if (mode === 'accepter') {
    const lectures = JSON.parse(readFileSync(fichierLectures, 'utf8'));
    let lus = [];
    try {
      lus = JSON.parse(readFileSync(fichierLus, 'utf8'));
    } catch {
      // L'app n'a pas démarré ou la lecture a échoué avant d'écrire : aucune page lue, donc refus ci-dessous.
    }
    const pageLue = resumer(lectures, lus);
    console.log(`Lecture : ${pageLue.detail}`);
    let statut = 'refusee';
    if (pageLue.ok) {
      const config = { deploiement: env.PREUVE_DEPLOIEMENT === 'aucun' ? 'aucun' : 'vercel', workflows: String(env.PREUVE_WORKFLOWS ?? '').split(',').map((x) => x.trim()).filter(Boolean) };
      const r = await accepterApresFusion({ api: apiGitHub(env.GITHUB_TOKEN), depot, numeroPr, config, pageLue });
      console.log(r.statut === 'acceptee' ? `Tâche #${r.tache} acceptée.` : `Acceptation refusée : ${r.motifs.join(' ; ')}`);
      if (r.statut === 'acceptee') statut = 'acceptee';
    }
    sortie('statut', statut);
  } else {
    throw new Error('usage : preuve-page.mjs decider|lire|accepter');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (err) {
    // Jamais de rouge qui masque la cause : le workflow réveille le fil si la tâche n'est pas acceptée.
    console.log(`::warning title=Preuve de page::${err.message}`);
    sortie('statut', 'erreur');
  }
}
