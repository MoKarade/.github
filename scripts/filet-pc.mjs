#!/usr/bin/env node
// Filet porté par le PC (tâche MoKarade/.github#196 à l'origine). Appelé par `tour.py` (relevé du PC, toutes les 10 min), sans IA et sans jeton par le chat.
//
// Chaîne de lancement RETIRÉE (tâche « Retirer la chaîne de lancement », décision de Marc du 29/10/2026, voie courte : une étiquette `go` lance claude-code-action) : plus de réveil
// « dépôt libre depuis 30 min », plus de rappel des tâches oubliées, du quota Claude non mesuré ni de liens « Bloquée par » : ils lisaient tous `prochaines.json`, la file calculée qui n'existe plus.
//
// Ce qui reste, tout indépendant de la file :
//   - le passage QUOTIDIEN du Réacteur (tâche #143, incident du 18/10/2026) : le PC lance `reacteur.yml` (workflow_dispatch, mode filet, `forcer`) une fois par jour et par dépôt dès 6 h 00 (Québec) ;
//   - la file Mergify (tâche #285) : remettre en file toute PR verte sortie de la file (étiquette `dequeued`) en mettant sa branche à jour, sans jamais taper de commande `@mergifyio` ;
//   - les preuves en retard (tâche #513, `scripts/preuves-retard.mjs`, `defauts-preuve.json` du relevé) : redire, toutes les 4 h, chaque preuve en retard ;
//   - les fonctions `tourJulesSuivi` et `tourAcceptationMarquee`, testées, que `main` ne lance plus (DÉPLACÉES vers le Réacteur le 29/10/2026, tâche #715, `scripts/pilotage-evenement.mjs`).
// Le réveil passe par `boite-reacteur.yml` (même route que `reveil-reacteur.mjs`), PAS par un commentaire du compte de Marc : GitHub ne notifie pas l'auteur de ses propres commentaires.
// Le message ne contient que des dépôts, des PR et des minutes, jamais le nom d'une tâche (règle MoKarade/.github#136).
// Un échec du réveil ne fait JAMAIS échouer le tour (il se dit sur la ligne imprimée) et n'enregistre pas le signalement : le tour suivant réessaie.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEPOT_BOITE, WORKFLOW_BOITE, construireMotif } from './reveil-reacteur.mjs';
import { ghCli, compteursGh } from './lier-taches.mjs';
import { suivreDepot, menageFermees, marquerParJules } from './jules-suivi.mjs';
import { completerDepot as marquerAcceptation, PAR_TOUR_MAX as MARQUAGES_PAR_TOUR } from './acceptation-marquage.mjs';
import { annulerPreuves, evaluerPreuvesRetard, motifDesPreuves } from './preuves-retard.mjs';

export const MODULES_VERSION = ['filet-pc', 'jules-suivi', 'acceptation-marquage', 'preuves-retard'];

/**
 * La version du code que ce tour exécute : le sha git (7 caractères) de chaque fichier, calculé comme `git hash-object` (le PC n'a pas de dépôt,
 * il reçoit les scripts un par un). Se compare à `git rev-parse origin/main:scripts/<nom>.mjs` : « sans ÉCHEC » seul ne prouve pas qu'une fonction
 * fusionnée tourne (limite relevée par le fil .github, 19/10/2026).
 * @param lire (nom) -> Buffer, ou lève si le fichier manque
 */
export function versionDuCode(lire = (nom) => readFileSync(fileURLToPath(new URL(`./${nom}.mjs`, import.meta.url)))) {
  const parties = MODULES_VERSION.map((nom) => {
    try {
      const contenu = lire(nom);
      return `${nom} ${createHash('sha1').update(`blob ${contenu.length}\0`).update(contenu).digest('hex').slice(0, 7)}`;
    } catch {
      return `${nom} absent`;
    }
  });
  return `code : ${parties.join(', ')}`;
}

const minutesEntre = (depuis, maintenant) => (maintenant.getTime() - Date.parse(depuis)) / 60_000;

export const DEPOTS_FILET = ['MoKarade/.github', 'MoKarade/app-template', 'MoKarade/batchchef-', 'MoKarade/CarAI', 'MoKarade/DriveAI', 'MoKarade/FinanceAI', 'MoKarade/hub-contract', 'MoKarade/Hubperso', 'MoKarade/JobAI', 'MoKarade/lia-ui', 'MoKarade/MemoryAI'];
export const WORKFLOW_FILET = 'reacteur.yml';
export const HEURE_FILET_MIN = 6 * 60; // 6 h 00, heure du Québec (America/Toronto : même fuseau, heure d'été comprise)
export const ESSAIS_MAX = 3;

/** Jour (AAAA-MM-JJ) et minute du jour à Québec. */
export function dateQuebec(maintenant) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(maintenant).map((x) => [x.type, x.value]));
  return { jour: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

/** Quels dépôts lancer maintenant. Pure. `etat` : { jour, faits: [dépôt], essais: { [dépôt]: n } } ; repart de zéro à chaque jour du Québec. */
export function evaluerQuotidien({ etat = {}, maintenant = new Date(), depots = DEPOTS_FILET }) {
  const { jour, minutes } = dateQuebec(maintenant);
  const du_jour = etat?.jour === jour ? etat : { jour, faits: [], essais: {} };
  const suivant = { jour, faits: [...(du_jour.faits ?? [])], essais: { ...(du_jour.essais ?? {}) } };
  if (minutes < HEURE_FILET_MIN) return { etat: suivant, a_lancer: [], raison: 'avant 6 h (heure du Québec)' };
  const a_lancer = depots.filter((d) => !suivant.faits.includes(d) && (suivant.essais[d] ?? 0) < ESSAIS_MAX);
  return { etat: suivant, a_lancer, raison: a_lancer.length ? '' : 'passage du jour déjà fait' };
}

/** Lance `reacteur.yml` d'un dépôt (branche par défaut) avec le jeton `gh` du PC. Lève si `gh` échoue. */
export function lancerFilet(depot, lancer = execFileSync) {
  lancer('gh', ['workflow', 'run', WORKFLOW_FILET, '--repo', depot], { stdio: 'pipe', timeout: 60_000 });
}

/** Le passage quotidien : lance `reacteur.yml` dans chaque dépôt une fois par jour. Rend la ligne à afficher ; ne lève jamais. */
export function tourQuotidien({ fichierEtat, executer = false, aBlanc = false, maintenant = new Date(), lancer = execFileSync, depots = DEPOTS_FILET }) {
  try {
    const r = evaluerQuotidien({ etat: lireJson(fichierEtat, {}), maintenant, depots });
    if (r.a_lancer.length === 0) {
      if (!aBlanc) ecrireJson(fichierEtat, r.etat);
      return `filet quotidien : rien (${r.raison})`;
    }
    if (aBlanc) return `filet quotidien : à blanc, lancerait ${r.a_lancer.length} dépôt(s)`;
    if (!executer) { ecrireJson(fichierEtat, r.etat); return `filet quotidien : ${r.a_lancer.length} dépôt(s) décidés, non lancés`; }
    const echecs = [];
    for (const depot of r.a_lancer) {
      try { lancerFilet(depot, lancer); r.etat.faits.push(depot); } catch (e) {
        r.etat.essais[depot] = (r.etat.essais[depot] ?? 0) + 1;
        echecs.push(`${depot} : ${String(e.stderr || e.message).replace(/\s+/g, ' ').slice(0, 100)}`);
      }
    }
    ecrireJson(fichierEtat, r.etat);
    const ok = r.a_lancer.length - echecs.length;
    return `filet quotidien : ${ok} lancé(s) sur ${r.a_lancer.length}, ${r.etat.faits.length}/${depots.length} faits aujourd'hui` + (echecs.length ? ` · ÉCHEC (${echecs.join(' ; ')})` : '');
  } catch (e) {
    return `filet quotidien : ÉCHEC (${String(e.message).slice(0, 160)})`;
  }
}

function lireJson(f, parDefaut) {
  if (!existsSync(f)) return parDefaut;
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return parDefaut; }
}

function ecrireJson(f, v) {
  writeFileSync(`${f}.tmp`, JSON.stringify(v));
  renameSync(`${f}.tmp`, f);
}

/** Lance `boite-reacteur.yml` d'app-template avec le jeton `gh` du PC. Lève si `gh` échoue. */
export function reveiller(motif, lancer = execFileSync) {
  lancer('gh', ['workflow', 'run', WORKFLOW_BOITE, '--repo', DEPOT_BOITE, '--ref', 'main', '-f', `texte=${motif}`], { stdio: 'pipe', timeout: 60_000 });
}

/** Un tour des preuves en retard : redit au Coordinateur les tâches fusionnées sans preuve ou à preuve dépassée. Rend la ligne à afficher ; ne lève jamais. */
export function tourPreuvesRetard({ fichierDefauts, fichierEtat, executer = false, aBlanc = false, maintenant = new Date(), lancer = execFileSync }) {
  try {
    const defauts = lireJson(fichierDefauts, null);
    if (!defauts) return 'preuves-retard : defauts-preuve.json illisible';
    const r = evaluerPreuvesRetard({ defauts, etat: lireJson(fichierEtat, {}), maintenant });
    if (r.reveils.length === 0) {
      if (!aBlanc) ecrireJson(fichierEtat, r.etat);
      return `preuves-retard : rien (${r.raison})`;
    }
    const motif = motifDesPreuves(r.reveils, r.reste);
    if (aBlanc) return `preuves-retard : à blanc, réveil prévu : ${motif}`;
    if (!executer) { ecrireJson(fichierEtat, r.etat); return `preuves-retard : réveil décidé, non envoyé : ${motif}`; }
    try {
      reveiller(motif, lancer);
      ecrireJson(fichierEtat, r.etat);
      return `preuves-retard : réveil envoyé (${r.reveils.length} tâche(s))`;
    } catch (e) {
      // Un réveil raté n'enregistre rien : le tour suivant réessaie.
      ecrireJson(fichierEtat, annulerPreuves(r.etat, r.reveils));
      return `preuves-retard : ÉCHEC du réveil (${String(e.stderr || e.message).replace(/\s+/g, ' ').slice(0, 160)})`;
    }
  } catch (e) {
    return `preuves-retard : ÉCHEC (${String(e.message).slice(0, 160)})`;
  }
}

export const FILE_ATTENTE_MIN = 10;
export const FILE_ESSAI_H = 1;
export const FILE_SIGNAL_H = 2;

/**
 * Décide quoi faire de chaque PR sortie de la file Mergify. Fonction pure : ne modifie pas son entrée.
 * @param prs   [{ ref, draft, labels, etat_fusion }] PR ouvertes ; `etat_fusion` = `mergeable_state` de GitHub
 * @param etat  { prs: { [ref]: { vu, essai, signale } } } gardé d'un tour à l'autre
 * @returns { etat, actions: [{ ref, faire: 'mettre-a-jour' | 'signaler', raison }] }
 */
export function evaluerFile({ prs, etat = {}, maintenant = new Date() }) {
  const suivi = {};
  const actions = [];
  const horodatage = maintenant.toISOString();
  for (const p of prs) {
    const labels = p.labels ?? [];
    if (p.draft || !labels.includes('dequeued') || labels.includes('hold')) continue;
    const ancien = etat.prs?.[p.ref] ?? {};
    const note = { ...ancien, vu: ancien.vu ?? horodatage };
    suivi[p.ref] = note;
    if (minutesEntre(note.vu, maintenant) < FILE_ATTENTE_MIN) continue;
    const signalable = !note.signale || minutesEntre(note.signale, maintenant) >= FILE_SIGNAL_H * 60;
    if (p.etat_fusion === 'dirty') {
      if (signalable) actions.push({ ref: p.ref, faire: 'signaler', raison: 'conflit de fusion' });
      continue;
    }
    const essaiPossible = !note.essai || minutesEntre(note.essai, maintenant) >= FILE_ESSAI_H * 60;
    if (essaiPossible) actions.push({ ref: p.ref, faire: 'mettre-a-jour', raison: '' });
    else if (signalable) actions.push({ ref: p.ref, faire: 'signaler', raison: 'mise à jour déjà tentée, toujours hors file' });
  }
  return { etat: { prs: suivi }, actions };
}

/** Le message d'une PR hors file qu'aucune mise à jour ne remet : le nom de la PR, jamais d'ordre à un fil. */
export function motifDeLaFile(signaux) {
  return construireMotif(signaux.map((x) => `file Mergify : ${x.ref} hors file (${x.raison})`));
}

const branche_a_jour = (e) => /422|already up to date|no new commits|mergeable/i.test(String(e?.stderr ?? e?.message ?? ''));

/**
 * Un tour de la file : remet en file les PR vertes sorties de la file Mergify. Rend la ligne à afficher ; ne lève jamais.
 * @param gh (methode, chemin, corps) -> objet JSON ; par défaut `gh api` du PC
 */
export function tourFile({ fichierEtat, executer = false, aBlanc = false, maintenant = new Date(), gh = null, lancer = execFileSync, depots = DEPOTS_FILET }) {
  try {
    const appel = gh ?? ghCli;
    const etat = lireJson(fichierEtat, { prs: {} });
    const prs = [];
    for (const depot of depots) {
      for (const p of appel('GET', `repos/${depot}/pulls?state=open&per_page=50`)) {
        const labels = (p.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
        if (p.draft || !labels.includes('dequeued')) continue;
        const detail = appel('GET', `repos/${depot}/pulls/${p.number}`);
        prs.push({ ref: `${depot.replace('MoKarade/', '')}#${p.number}`, depot, n: p.number, draft: p.draft, labels, etat_fusion: detail.mergeable_state });
      }
    }
    const r = evaluerFile({ prs, etat, maintenant });
    if (r.actions.length === 0) {
      if (!aBlanc) ecrireJson(fichierEtat, r.etat);
      return `file : ${prs.length ? `${prs.length} hors file, rien à faire encore` : 'aucune PR hors file'}`;
    }
    if (aBlanc || !executer) {
      if (!aBlanc) ecrireJson(fichierEtat, r.etat);
      return `file : ${r.actions.map((a) => `${a.ref} ${a.faire}`).join(', ')}${aBlanc ? ' (à blanc)' : ', non faits'}`;
    }
    const signaux = [];
    const faits = [];
    for (const a of r.actions) {
      const p = prs.find((x) => x.ref === a.ref);
      if (a.faire === 'signaler') { signaux.push(a); continue; }
      try {
        appel('PUT', `repos/${p.depot}/pulls/${p.n}/update-branch`);
        faits.push(a.ref);
        r.etat.prs[a.ref].essai = maintenant.toISOString();
      } catch (e) {
        if (!branche_a_jour(e)) throw e;
        // Rien de neuf sur la base : aucune mise à jour possible, seul un geste de Marc remet la PR en file.
        r.etat.prs[a.ref].essai = maintenant.toISOString();
        signaux.push({ ref: a.ref, faire: 'signaler', raison: 'branche déjà à jour, Mergify ne la remet pas en file' });
      }
    }
    let envoi = '';
    if (signaux.length) {
      try {
        reveiller(motifDeLaFile(signaux), lancer);
        for (const x of signaux) r.etat.prs[x.ref].signale = maintenant.toISOString();
        envoi = `, réveil envoyé (${signaux.map((x) => x.ref).join(', ')})`;
      } catch (e) {
        envoi = `, ÉCHEC du réveil (${String(e.stderr || e.message).replace(/\s+/g, ' ').slice(0, 120)})`;
      }
    }
    ecrireJson(fichierEtat, r.etat);
    return `file : ${faits.length} mise(s) à jour${faits.length ? ` (${faits.join(', ')})` : ''}${envoi}`;
  } catch (e) {
    return `file : ÉCHEC (${String(e.message).slice(0, 160)})`;
  }
}

/**
 * Un tour du suivi des PR de Jules : voir `scripts/jules-suivi.mjs`. Rend la ligne à afficher ; ne lève jamais (un dépôt illisible est dit, les autres passent).
 * @param gh (methode, chemin, corps) -> objet JSON ; par défaut `gh api` du PC
 */
export function tourJulesSuivi({ fichierEtat, executer = false, aBlanc = false, maintenant = new Date(), gh = null, lancer = execFileSync, depots = DEPOTS_FILET }) {
  try {
    const appel = gh ?? ghCli;
    const etat = lireJson(fichierEtat, {});
    const total = { acceptees: [], nettoyees: [], holds: [], signaux: [], menage: [], parJules: [], vu: 0 };
    const echecs = [];
    for (const depot of depots) {
      try {
        const r = suivreDepot({ depot, gh: appel, etat, maintenant, aBlanc: aBlanc || !executer });
        for (const k of ['acceptees', 'nettoyees', 'holds', 'signaux']) total[k].push(...r[k]);
        total.vu += r.vu;
        try { total.parJules.push(...marquerParJules({ depot, gh: appel, aBlanc: aBlanc || !executer, etat, maintenant }).marquees); } catch (e) { echecs.push(`${depot.replace('MoKarade/', '')} par-jules (${String(e.message).replace(/\s+/g, ' ').slice(0, 60)})`); } // un échec ici ne coupe pas le reste du dépôt
        total.menage.push(...menageFermees({ depot, gh: appel, aBlanc: aBlanc || !executer }));
      } catch (e) {
        echecs.push(`${depot.replace('MoKarade/', '')} (${String(e.message).replace(/\s+/g, ' ').slice(0, 60)})`);
      }
    }
    let envoi = '';
    if (total.signaux.length && executer && !aBlanc) {
      try {
        reveiller(construireMotif(total.signaux.slice(0, 4).map((x) => `jules : ${x.ref} ${x.raison}`)), lancer);
        for (const x of total.signaux) etat[x.ref] = { ...etat[x.ref], signale: maintenant.toISOString() };
        envoi = `, réveil envoyé (${total.signaux.length})`;
      } catch (e) {
        envoi = `, ÉCHEC du réveil (${String(e.stderr || e.message).replace(/\s+/g, ' ').slice(0, 100)})`;
      }
    }
    if (executer && !aBlanc) ecrireJson(fichierEtat, etat);
    const seul = !executer || aBlanc ? ' (non appliqué)' : '';
    return `jules-suivi : ${total.vu} tâche(s) jules, ${total.acceptees.length} acceptée(s)${total.acceptees.length ? ` (${total.acceptees.join(', ')})` : ''}, ${total.nettoyees.length} PR nettoyée(s), ${total.holds.length} hold${total.menage.length ? `, ${total.menage.length} étiquette(s) retirée(s) sur tâches fermées` : ''}${total.parJules.length ? `, ${total.parJules.length} PR marquée(s) par-jules (${total.parJules.slice(0, 6).join(', ')}${total.parJules.length > 6 ? ', …' : ''})` : ''}${seul}${envoi}${echecs.length ? `, ÉCHEC ${echecs.join(' ; ')}` : ''}`;
  } catch (e) {
    return `jules-suivi : ÉCHEC (${String(e.message).slice(0, 160)})`;
  }
}

/**
 * Un tour du marquage « Acceptation automatique » : voir `scripts/acceptation-marquage.mjs`. Rend la ligne à afficher ; ne lève jamais.
 * @param gh (methode, chemin, corps) -> objet JSON ; par défaut `gh api` du PC
 */
export function tourAcceptationMarquee({ executer = false, aBlanc = false, gh = null, depots = DEPOTS_FILET, parTour = MARQUAGES_PAR_TOUR }) {
  try {
    const appel = gh ?? ghCli;
    const budget = { restant: parTour };
    const ecrites = [];
    const retirees = [];
    const echecs = [];
    for (const depot of depots) {
      try {
        const r = marquerAcceptation({ depot, gh: appel, budget, aBlanc: aBlanc || !executer });
        ecrites.push(...r.ecrites);
        retirees.push(...r.retirees);
      } catch (e) {
        echecs.push(`${depot.replace('MoKarade/', '')} (${String(e.message).replace(/\s+/g, ' ').slice(0, 60)})`);
      }
    }
    const seul = !executer || aBlanc ? ' (non appliqué)' : '';
    return `acceptation-marquage : ${ecrites.length} écrite(s)${ecrites.length ? ` (${ecrites.slice(0, 6).join(', ')}${ecrites.length > 6 ? ', …' : ''})` : ''}${retirees.length ? `, ${retirees.length} retirée(s) (${retirees.slice(0, 4).join(', ')})` : ''}${seul}${echecs.length ? `, ÉCHEC ${echecs.join(' ; ')}` : ''}`;
  } catch (e) {
    return `acceptation-marquage : ÉCHEC (${String(e.message).slice(0, 160)})`;
  }
}

/** « appels filet : N comptés (M en 304 gratuits sur R) [rôle n, …] » : seuls les rôles qui ont coûté quelque chose, du plus lourd au plus léger. */
export function ligneAppels(c, roles) {
  const lourds = roles.filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'fr')).map(([nom, n]) => `${nom} ${n}`);
  return `appels filet : ${c.comptees} comptés (${c.n304} en 304 gratuits sur ${c.req})${lourds.length ? ` [${lourds.join(', ')}]` : ''}`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = (nom) => { const i = process.argv.indexOf(nom); return i > 0 ? process.argv[i + 1] : null; };
  // Plus d'argument positionnel : l'ancien appel `filet-pc.mjs prochaines.json --etat …` fonctionne encore, le fichier est ignoré (la file calculée n'existe plus).
  const fichierEtat = arg('--etat') ?? 'filet-pc-etat.json';
  const suffixe = (nom) => fichierEtat.replace(/(\.json)?$/, nom);
  const options = { executer: process.argv.includes('--executer'), aBlanc: process.argv.includes('--a-blanc') };
  // Une seule ligne sur la sortie : la tâche du PC la reprend telle quelle dans etat.json. Le passage quotidien a son propre fichier d'état.
  // .github#741 : appels GitHub COMPTÉS par rôle (les 304 du cache ETag sont gratuits), dits sur la même ligne ; le tour du PC ne les voyait pas (267 appels cachés le 28/10/2026).
  const roles = [];
  const mesure = (nom, f) => { const avant = compteursGh().comptees; const r = f(); roles.push([nom, compteursGh().comptees - avant]); return r; };
  const quotidien = mesure('quotidien', () => tourQuotidien({ fichierEtat: suffixe('-quotidien.json'), ...options }));
  // .github#715 : le suivi des PR de Jules et « Acceptation automatique » partent à l'événement (`scripts/pilotage-evenement.mjs`, appelé par le Réacteur). Le tour du PC garde la file Mergify
  // (`tourFile`) : mettre une branche à jour AVEC un jeton qui relance la CI est le seul geste que le jeton du job ne sait pas faire (GitHub ne lance aucun workflow sur un push du jeton du job).
  const file = mesure('file', () => tourFile({ fichierEtat: suffixe('-file.json'), ...options }));
  const preuves = mesure('preuves', () => tourPreuvesRetard({ fichierDefauts: join(dirname(fichierEtat), 'defauts-preuve.json'), fichierEtat: suffixe('-preuves.json'), ...options }));
  console.log(`${quotidien} · ${file} · ${preuves} · ${versionDuCode()} · ${ligneAppels(compteursGh(), roles)}`);
}
