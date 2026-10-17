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
// Un échec du réveil ne fait JAMAIS échouer le tour (il se dit sur la ligne imprimée) et n'enregistre pas le signalement :
// le tour suivant réessaie.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DEPOT_BOITE, WORKFLOW_BOITE, construireMotif } from './reveil-reacteur.mjs';

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

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = (nom) => { const i = process.argv.indexOf(nom); return i > 0 ? process.argv[i + 1] : null; };
  const fichierProchaines = process.argv[2];
  if (!fichierProchaines || fichierProchaines.startsWith('--')) {
    console.log('usage : filet-pc.mjs prochaines.json --etat filet-pc-etat.json [--executer | --a-blanc]');
  } else {
    console.log(tour({
      fichierProchaines,
      fichierEtat: arg('--etat') ?? 'filet-pc-etat.json',
      executer: process.argv.includes('--executer'),
      aBlanc: process.argv.includes('--a-blanc'),
    }));
  }
}
