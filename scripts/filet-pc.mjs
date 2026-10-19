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
// Quatrième rôle (demande de Marc du 19/10/2026, « Jules full auto ») : confier à Jules, sans quota Claude, la première tâche réservée
// (`faisable-jules`) d'un dépôt libre dont le corps est une consigne complète au gabarit (`tourJules`, `scripts/jules-auto.mjs`, docs §5 quater).
// Cinquième rôle (demande du Coordinateur du 19/10/2026, tâche MoKarade/.github#285, après la fusion à la main de #270) : remettre en file toute PR
// verte sortie de la file Mergify (étiquette `dequeued`) en mettant sa branche à jour (`update-branch`, que Mergify requeue seul), sans jamais
// taper de commande `@mergifyio` (seul Marc le peut). Branche déjà à jour ou en conflit : réveil du Coordinateur, une fois par 2 h, avec la raison.
// Sixième rôle (demande de Marc du 19/10/2026 18:31Z, « go full auto », tâche MoKarade/.github#289) : suivre les PR de Jules sans fil (`tourJulesSuivi`,
// `scripts/jules-suivi.mjs`) : nettoyer le corps des PR ouvertes, poser `hold` et réveiller si un fichier sort de « Fichiers permis », et accepter seul
// (« **Acceptée** » au format du garde-fou, étiquettes retirées, tâche fermée) la PR de TESTS SEULS fusionnée.
// Septième ajout au même tour (tâche MoKarade/.github#296) : poser seul `faisable-jules` sur les tâches que `evaluerJules` accepte (`scripts/jules-marquage.mjs`, au plus deux réservées par dépôt).
// Un échec du réveil ne fait JAMAIS échouer le tour (il se dit sur la ligne imprimée) et n'enregistre pas le signalement :
// le tour suivant réessaie.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DEPOT_BOITE, WORKFLOW_BOITE, construireMotif } from './reveil-reacteur.mjs';
import { lierTout, ghCli } from './lier-taches.mjs';
import { choisirPourJules, confierAJules } from './jules-auto.mjs';
import { suivreDepot, menageFermees } from './jules-suivi.mjs';
import { marquerFaisables } from './jules-marquage.mjs';

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

/** Lit une issue EN DIRECT pour `choisirPourJules` : l'état, les étiquettes et le corps (la consigne de Jules). */
function lireIssueGh(gh) {
  return (depot, n) => {
    const i = gh('GET', `repos/MoKarade/${depot}/issues/${n}`);
    return { state: i.state, labels: (i.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)), body: i.body ?? '' };
  };
}

/**
 * Un tour de Jules (demande de Marc du 19/10/2026) : confier à Jules la première tâche réservée (`faisable-jules`) de chaque dépôt libre dont le
 * corps est une consigne complète au gabarit (`scripts/jules-auto.mjs`, docs/cycle-de-vie-tache.md §5 quater). Trois Jules en même temps au plus.
 * `prochaines.json` périmé (plus de 30 min) : rien. Rend la ligne à afficher ; ne lève jamais.
 * @param gh (methode, chemin, corps) -> objet JSON ; par défaut `gh api` du PC
 */
export function tourJules({ fichierProchaines, fichierEtat, aBlanc = false, executer = false, maintenant = new Date(), gh = null }) {
  try {
    const prochaines = lireJson(fichierProchaines, null);
    if (!prochaines) return 'jules : prochaines.json illisible';
    const age = (maintenant.getTime() - Date.parse(prochaines.calcule_le)) / 60_000;
    if (!(age <= 30)) return 'jules : prochaines.json périmé, rien';
    const appel = gh ?? ghCli;
    const etat = lireJson(fichierEtat, { confies: {} });
    etat.confies ??= {};
    const { choix, pasPretes, depotsConcernes, enCours } = choisirPourJules(prochaines, lireIssueGh(appel), etat);
    if (depotsConcernes === 0) return `jules : aucune tâche réservée (faisable-jules), ${enCours} en cours`;
    const confiees = [];
    const sautees = [];
    for (const c of choix) {
      if (!executer && !aBlanc) { sautees.push(`${c.ref} (non confiée)`); continue; }
      const r = confierAJules({ repo: c.repo, n: c.n }, appel, { aBlanc });
      if (r.statut === 'confiee') {
        confiees.push(c.ref);
        if (!aBlanc) etat.confies[c.ref] = { fois: (etat.confies[c.ref]?.fois ?? 0) + 1, derniere: maintenant.toISOString() };
      } else sautees.push(`${c.ref} (${r.raison})`);
    }
    if (!aBlanc && confiees.length) ecrireJson(fichierEtat, etat);
    const pas = pasPretes.length ? `, ${pasPretes.length} pas prête(s) : ${pasPretes.slice(0, 3).map((p) => `${p.ref} ${p.raisons[0]}`).join(' ; ')}${pasPretes.length > 3 ? ' …' : ''}`.slice(0, 320) : '';
    return `jules : ${confiees.length} confiée(s)${confiees.length ? ` (${confiees.join(', ')})` : ''}${aBlanc && choix.length ? ' (à blanc)' : ''}${sautees.length ? `, sautée(s) ${sautees.join(', ')}` : ''}, ${depotsConcernes} dépôt(s) avec réservée(s), ${enCours} en cours${pas}`;
  } catch (e) {
    return `jules : ÉCHEC (${String(e.message).slice(0, 160)})`;
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
    const total = { acceptees: [], nettoyees: [], holds: [], signaux: [], menage: [], marquees: [], vu: 0 };
    const echecs = [];
    for (const depot of depots) {
      try {
        const r = suivreDepot({ depot, gh: appel, etat, maintenant, aBlanc: aBlanc || !executer });
        for (const k of ['acceptees', 'nettoyees', 'holds', 'signaux']) total[k].push(...r[k]);
        total.vu += r.vu;
        total.menage.push(...menageFermees({ depot, gh: appel, aBlanc: aBlanc || !executer }));
        total.marquees.push(...marquerFaisables({ depot, gh: appel, aBlanc: aBlanc || !executer }).marquees);
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
    return `jules-suivi : ${total.vu} tâche(s) jules, ${total.acceptees.length} acceptée(s)${total.acceptees.length ? ` (${total.acceptees.join(', ')})` : ''}, ${total.nettoyees.length} PR nettoyée(s), ${total.holds.length} hold${total.menage.length ? `, ${total.menage.length} étiquette(s) retirée(s) sur tâches fermées` : ''}${total.marquees.length ? `, ${total.marquees.length} marquée(s) faisable-jules (${total.marquees.join(', ')})` : ''}${seul}${envoi}${echecs.length ? `, ÉCHEC ${echecs.join(' ; ')}` : ''}`;
  } catch (e) {
    return `jules-suivi : ÉCHEC (${String(e.message).slice(0, 160)})`;
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
    const jules = tourJules({ fichierProchaines, fichierEtat: fichierEtat.replace(/(\.json)?$/, '-jules.json'), ...options });
    const file = tourFile({ fichierEtat: fichierEtat.replace(/(\.json)?$/, '-file.json'), ...options });
    const suivi = tourJulesSuivi({ fichierEtat: fichierEtat.replace(/(\.json)?$/, '-jules-suivi.json'), ...options });
    console.log(`${reveil} · ${quotidien} · ${oublis} · ${liens} · ${jules} · ${file} · ${suivi}`);
  }
}
