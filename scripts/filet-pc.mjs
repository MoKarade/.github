#!/usr/bin/env node
// Filet porté par le PC (tâche MoKarade/.github#196, plan corrections du bilan P1-C) : réveiller le Coordinateur quand un
// dépôt reste LIBRE avec une tâche prenable sans qu'aucun lancement n'ait eu lieu. Appelé par `tour.py` (relevé du PC,
// toutes les 10 min) juste après le calcul de `prochaines.json`, sans IA et sans jeton par le chat.
//
// Pourquoi ici : si le Coordinateur n'est pas réveillé (abonnement perdu, filet GitHub en retard ou sauté), un dépôt libre
// reste inactif et rien ne le dit. Le PC voit pourtant l'état frais toutes les 10 min.
//
// Le réveil passe par `boite-reacteur.yml` (même route que `reveil-reacteur.mjs`), PAS par un commentaire du compte de Marc :
// GitHub ne notifie pas l'auteur de ses propres commentaires, donc un `gh pr comment` du PC ne réveillerait personne.
// Le workflow commente app-template#58 en `github-actions[bot]`, ce qui réveille.
//
// Règles (fonctions pures, voir les tests) :
//   - un dépôt compte s'il est `libre` avec une suivante dans `prochaines.json`, depuis plus de 30 min d'observations continues ;
//   - un seul réveil par couple (dépôt, tâche) et par 2 h, et un seul message par tour pour tous les dépôts ;
//   - `prochaines.json` périmé (plus de 30 min) = rien. Le frein de quota n'a pas besoin d'un test à part : `suivante` ne contient que les tâches
//     qu'il laisse passer (un dépôt dont tout est retenu est `frein`, pas `libre`) ; décision du Coordinateur, 17/10/2026 17:58 UTC ;
//   - une observation plus ancienne que 40 min (PC éteint, tour sauté) casse la continuité : le compte repart de zéro ;
//   - le message ne contient que des dépôts et des minutes, jamais le nom de la tâche suivante (règle MoKarade/.github#136).
// Second rôle (tâche MoKarade/.github#143, incident du 18/10/2026) : le passage QUOTIDIEN du Réacteur. Les crons de `reacteur.yml`
// (best-effort chez GitHub) ne sont pas partis le 18/10 à 6 h 11 (Québec) dans les dix dépôts, comme le 17/10 où ils étaient arrivés
// avec 3 h de retard. Le PC, qui voit l'heure du Québec, lance donc `reacteur.yml` (workflow_dispatch, mode filet, `forcer`) une
// fois par jour et par dépôt dès 6 h 00 ; les crons de GitHub restent en renfort et ne reposteront pas un signal déjà posté.
// Troisième rôle (demande de Marc du 19/10/2026, « tâches oubliées ») : réveiller le Coordinateur pour chaque tâche OUBLIÉE que
// `prochaine-tache.mjs` liste dans `oubliees` (personne ne peut lever l'obstacle, geste de Marc qui dort, fil silencieux), une fois par racine
// et par 24 h tant que ça dure. Sans cela une tâche retenue par un geste de Marc, un « bloqué » sans raison ou une dépendance illisible ne
// revient jamais dans la file et rien ne le dit. Message à part (`RÉACTEUR : oubli : …`) : il nomme les tâches, puisque c'est son objet.
// Un échec du réveil ne fait JAMAIS échouer le tour (il se dit sur la ligne imprimée) et n'enregistre pas le signalement :
// le tour suivant réessaie.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DEPOT_BOITE, WORKFLOW_BOITE, construireMotif } from './reveil-reacteur.mjs';
import { lierTout, ghCli } from './lier-taches.mjs';

export const SEUIL_LIBRE_MIN = 30;
export const FENETRE_SIGNALEMENT_H = 2;
export const CONTINUITE_MAX_MIN = 40;
export const PROCHAINES_PERIME_MIN = 30;

const minutesEntre = (depuis, maintenant) => (maintenant.getTime() - Date.parse(depuis)) / 60_000;

/**
 * Décide quoi réveiller. Ne modifie pas son entrée.
 * @param prochaines contenu de `prochaines.json`
 * @param etat       état gardé d'un tour à l'autre : { [depot]: { libre_depuis, vu, signale: { [ref]: iso } } }
 * @returns { etat, reveils: [{ depot, ref, minutes }], raison }  `raison` dit pourquoi rien n'est parti (vide si réveil)
 */
export function evaluerFilet({ prochaines, etat = {}, maintenant = new Date() }) {
  const suivant = {};
  const limite = FENETRE_SIGNALEMENT_H * 60;
  // Les signalements récents sont gardés même quand le dépôt n'est plus libre : un dépôt qui oscille ne réveille pas deux fois.
  for (const [depot, e] of Object.entries(etat ?? {})) {
    const signale = Object.fromEntries(Object.entries(e?.signale ?? {}).filter(([, t]) => minutesEntre(t, maintenant) < limite));
    if (Object.keys(signale).length) suivant[depot] = { signale };
  }

  const age = minutesEntre(prochaines?.calcule_le ?? '', maintenant);
  if (!Number.isFinite(age) || age > PROCHAINES_PERIME_MIN) return { etat: suivant, reveils: [], raison: 'prochaines.json périmé' };

  const reveils = [];
  for (const d of prochaines.depots ?? []) {
    const depot = d.repo;
    const ref = d.statut === 'libre' ? d.suivante?.ref : null;
    if (!depot || !ref) continue; // occupé, incident, frein, rien : le compte de ce dépôt repart de zéro
    const avant = etat?.[depot] ?? {};
    const continu = avant.libre_depuis && avant.vu && minutesEntre(avant.vu, maintenant) <= CONTINUITE_MAX_MIN;
    const e = { ...(suivant[depot] ?? {}), libre_depuis: continu ? avant.libre_depuis : maintenant.toISOString(), vu: maintenant.toISOString() };
    suivant[depot] = e;
    const minutes = Math.floor(minutesEntre(e.libre_depuis, maintenant));
    const deja = e.signale?.[ref];
    if (minutes > SEUIL_LIBRE_MIN && !deja) {
      e.signale = { ...(e.signale ?? {}), [ref]: maintenant.toISOString() };
      reveils.push({ depot, ref, minutes });
    }
  }
  return { etat: suivant, reveils, raison: reveils.length ? '' : 'aucun dépôt libre depuis plus de 30 min' };
}

/** Le texte du réveil : dépôts et minutes seulement (règle #136), au format `RÉACTEUR : …` du bot. */
export function motifDuFilet(reveils) {
  return construireMotif(reveils.map((r) => `filet PC : ${r.depot} libre depuis ${r.minutes} min sans lancement`));
}

/** Après un réveil raté, on oublie le signalement pour que le tour suivant réessaie. */
export function annulerSignalements(etat, reveils) {
  const copie = JSON.parse(JSON.stringify(etat));
  for (const r of reveils) delete copie[r.depot]?.signale?.[r.ref];
  return copie;
}

export const FENETRE_OUBLI_H = 24;
export const OUBLIS_PAR_MESSAGE = 4;

/** Regroupe les tâches oubliées par racine (ce qui les retient vraiment) : un signal par racine, pas un par tâche retenue derrière. */
export function grouperOublis(oubliees) {
  const groupes = new Map();
  for (const o of oubliees ?? []) {
    const g = groupes.get(o.racine) ?? { racine: o.racine, proprietaire: o.proprietaire, cause: o.cause, heures: null, refs: [] };
    g.refs.push(o.ref);
    if (o.ref === o.racine) g.cause = o.cause;
    g.heures = Math.max(g.heures ?? 0, o.heures ?? 0);
    groupes.set(o.racine, g);
  }
  const rang = { marc: 0, personne: 1, fil: 2 };
  return [...groupes.values()].sort((a, b) => (rang[a.proprietaire] ?? 3) - (rang[b.proprietaire] ?? 3) || b.refs.length - a.refs.length || a.racine.localeCompare(b.racine));
}

const jours = (h) => Math.max(1, Math.round((h ?? 0) / 24));

/** Une ligne par groupe : ce qui retient, depuis quand, et combien d'autres tâches attendent derrière. */
export function ligneOubli(g) {
  const derriere = g.refs.filter((r) => r !== g.racine).length;
  const suite = derriere ? ` (retient ${derriere} autre${derriere > 1 ? 's' : ''})` : '';
  if (g.proprietaire === 'marc') return `geste de Marc en retard depuis ${jours(g.heures)} j : ${g.racine}${suite}`;
  if (g.proprietaire === 'fil') return `fil silencieux depuis ${Math.round(g.heures ?? 0)} h : ${g.racine}${suite}`;
  return `sans responsable (${g.cause}) : ${g.racine}${suite}`;
}

/**
 * Décide quels oublis signaler. Ne modifie pas son entrée.
 * @param etat { signale: { [racine]: iso } } gardé d'un tour à l'autre (une racine déjà signalée depuis moins de 24 h ne se répète pas)
 * @returns { etat, reveils: [groupe], raison }
 */
export function evaluerOublis({ prochaines, etat = {}, maintenant = new Date() }) {
  const limite = FENETRE_OUBLI_H * 60;
  const signale = Object.fromEntries(Object.entries(etat?.signale ?? {}).filter(([, t]) => minutesEntre(t, maintenant) < limite));
  const age = minutesEntre(prochaines?.calcule_le ?? '', maintenant);
  if (!Number.isFinite(age) || age > PROCHAINES_PERIME_MIN) return { etat: { signale }, reveils: [], raison: 'prochaines.json périmé' };
  const reveils = grouperOublis(prochaines.oubliees).filter((g) => !signale[g.racine]);
  for (const g of reveils.slice(0, OUBLIS_PAR_MESSAGE)) signale[g.racine] = maintenant.toISOString();
  return { etat: { signale }, reveils: reveils.slice(0, OUBLIS_PAR_MESSAGE), reste: Math.max(0, reveils.length - OUBLIS_PAR_MESSAGE), raison: reveils.length ? '' : 'aucune tâche oubliée à signaler' };
}

/** Le texte du réveil d'oubli, au format `RÉACTEUR : oubli : …` ; `reste` : racines non signalées ce tour-ci (elles le seront aux tours suivants). */
export function motifDesOublis(reveils, reste = 0) {
  return construireMotif([`oubli : ${reveils.map(ligneOubli).join(' ; ')}${reste ? ` ; +${reste} autre(s) au prochain tour` : ''}`]);
}

export const DEPOTS_FILET = ['MoKarade/.github', 'MoKarade/app-template', 'MoKarade/batchchef-', 'MoKarade/CarAI', 'MoKarade/DriveAI', 'MoKarade/FinanceAI', 'MoKarade/hub-contract', 'MoKarade/Hubperso', 'MoKarade/JobAI', 'MoKarade/MemoryAI'];
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

/** Un tour du filet. Rend la ligne à afficher ; ne lève jamais. `aBlanc` : décide et imprime, n'envoie ni n'enregistre rien. */
export function tour({ fichierProchaines, fichierEtat, executer = false, aBlanc = false, maintenant = new Date(), lancer = execFileSync }) {
  try {
    const prochaines = lireJson(fichierProchaines, null);
    if (!prochaines) return 'filet PC : prochaines.json illisible';
    const etat = lireJson(fichierEtat, {});
    const r = evaluerFilet({ prochaines, etat, maintenant });
    if (r.reveils.length === 0) {
      if (!aBlanc) ecrireJson(fichierEtat, r.etat);
      return `filet PC : rien (${r.raison})`;
    }
    const motif = motifDuFilet(r.reveils);
    if (aBlanc) return `filet PC : à blanc, réveil prévu : ${motif}`;
    if (!executer) { ecrireJson(fichierEtat, r.etat); return `filet PC : réveil décidé, non envoyé : ${motif}`; }
    try {
      reveiller(motif, lancer);
      ecrireJson(fichierEtat, r.etat);
      return `filet PC : réveil envoyé (${r.reveils.map((x) => x.depot).join(', ')})`;
    } catch (e) {
      ecrireJson(fichierEtat, annulerSignalements(r.etat, r.reveils));
      return `filet PC : ÉCHEC du réveil (${String(e.stderr || e.message).replace(/\s+/g, ' ').slice(0, 160)})`;
    }
  } catch (e) {
    return `filet PC : ÉCHEC (${String(e.message).slice(0, 160)})`;
  }
}

/** Un tour des oublis : réveille le Coordinateur pour les tâches oubliées pas encore signalées. Rend la ligne à afficher ; ne lève jamais. */
export function tourOublis({ fichierProchaines, fichierEtat, executer = false, aBlanc = false, maintenant = new Date(), lancer = execFileSync }) {
  try {
    const prochaines = lireJson(fichierProchaines, null);
    if (!prochaines) return 'filet oublis : prochaines.json illisible';
    const r = evaluerOublis({ prochaines, etat: lireJson(fichierEtat, {}), maintenant });
    if (r.reveils.length === 0) {
      if (!aBlanc) ecrireJson(fichierEtat, r.etat);
      return `filet oublis : rien (${r.raison})`;
    }
    const motif = motifDesOublis(r.reveils, r.reste);
    if (aBlanc) return `filet oublis : à blanc, réveil prévu : ${motif}`;
    if (!executer) { ecrireJson(fichierEtat, r.etat); return `filet oublis : réveil décidé, non envoyé : ${motif}`; }
    try {
      reveiller(motif, lancer);
      ecrireJson(fichierEtat, r.etat);
      return `filet oublis : réveil envoyé (${r.reveils.length} racine(s))`;
    } catch (e) {
      // Un réveil raté n'enregistre rien : le tour suivant réessaie.
      const signale = { ...r.etat.signale };
      for (const g of r.reveils) delete signale[g.racine];
      ecrireJson(fichierEtat, { signale });
      return `filet oublis : ÉCHEC du réveil (${String(e.stderr || e.message).replace(/\s+/g, ' ').slice(0, 160)})`;
    }
  } catch (e) {
    return `filet oublis : ÉCHEC (${String(e.message).slice(0, 160)})`;
  }
}

/** Combien de liens un tour pose au plus : un dépôt qui sort d'un gros retard se rattrape en quelques tours, sans rafale sur l'API. */
export const LIENS_PAR_TOUR = 20;

/**
 * Un tour des liens : pose sur GitHub les dépendances que les tâches écrivent en `**Attend**` sans lien natif (`liens_manquants`).
 * Idempotent, jamais destructif. `prochaines.json` périmé (plus de 30 min) : rien. Rend la ligne à afficher ; ne lève jamais.
 * @param gh (methode, chemin, corps) -> objet JSON ; par défaut `gh api` du PC
 */
export function tourLiens({ fichierProchaines, aBlanc = false, executer = false, maintenant = new Date(), gh = null }) {
  try {
    const prochaines = lireJson(fichierProchaines, null);
    if (!prochaines) return 'liens : prochaines.json illisible';
    const age = (maintenant.getTime() - Date.parse(prochaines.calcule_le)) / 60_000;
    if (!(age <= 30)) return 'liens : prochaines.json périmé, rien';
    const manquants = prochaines.liens_manquants ?? [];
    if (manquants.length === 0) return 'liens : tous posés';
    if (aBlanc || !executer) return `liens : ${manquants.length} à poser${aBlanc ? ' (à blanc)' : ', non posés'}`;
    const r = lierTout(manquants.slice(0, LIENS_PAR_TOUR), gh ?? ghCli);
    const reste = manquants.length - Math.min(manquants.length, LIENS_PAR_TOUR);
    const echec = r.echecs.length ? `, ÉCHEC ${r.echecs.length} (${r.echecs[0].raison.replace(/\s+/g, ' ').slice(0, 100)})` : '';
    return `liens : ${r.faits.length} posé(s), ${r.deja.length} déjà là${echec}${reste ? `, ${reste} au prochain tour` : ''}`;
  } catch (e) {
    return `liens : ÉCHEC (${String(e.message).slice(0, 160)})`;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = (nom) => { const i = process.argv.indexOf(nom); return i > 0 ? process.argv[i + 1] : null; };
  const fichierProchaines = process.argv[2];
  if (!fichierProchaines || fichierProchaines.startsWith('--')) {
    console.log('usage : filet-pc.mjs prochaines.json --etat filet-pc-etat.json [--executer | --a-blanc]');
  } else {
    const fichierEtat = arg('--etat') ?? 'filet-pc-etat.json';
    const options = { executer: process.argv.includes('--executer'), aBlanc: process.argv.includes('--a-blanc') };
    // Une seule ligne sur la sortie : la tâche du PC la reprend telle quelle dans etat.json. Le passage quotidien a son propre fichier d'état.
    const reveil = tour({ fichierProchaines, fichierEtat, ...options });
    const quotidien = tourQuotidien({ fichierEtat: fichierEtat.replace(/(\.json)?$/, '-quotidien.json'), ...options });
    const oublis = tourOublis({ fichierProchaines, fichierEtat: fichierEtat.replace(/(\.json)?$/, '-oublis.json'), ...options });
    const liens = tourLiens({ fichierProchaines, ...options });
    console.log(`${reveil} · ${quotidien} · ${oublis} · ${liens}`);
  }
}
