#!/usr/bin/env node
// Tâche suivante de chaque dépôt (docs/cycle-de-vie-tache.md §5 et §6) : UN seul calcul, lu par le Gantt ET par la routine.
//
// Rôle : lit le relevé `backlog.json` (écrit par fetch.py) et écrit `prochaines.json` : pour chaque dépôt, son état
// (`libre`, `occupe`, `incident`, `frein`, `rien`), la tâche suivante, la file complète dans l'ordre, et pour chaque tâche
// ouverte écartée la raison. Rien n'est lu sur le réseau : le fichier peut dater de quelques dizaines de minutes,
// donc l'appelant revérifie EN DIRECT la tâche choisie (ouverte, sans `en-cours`, sans PR ouverte) avant de la lancer.
//
// Ordre (§5), du plus pressé au moins pressé, puis `prio` croissante, puis numéro :
//   1 preuve due : tâche `preuve-manquante`, ou PR fusionnée sans que la tâche soit acceptée (la preuve passe avant tout
//     travail neuf)   [un incident ouvert passe avant : statut `incident`]
//   2 `prio:1`   3 sécurité (étiquette `sécurité`)
//   4 même mission que la dernière tâche lancée ou fermée du dépôt   5 même chantier
//   6 alternance : le chantier de l'autre type (`chantier:standard` / `chantier:fonction`)   7 le reste
// Prenable : ouverte et `niveau:tâche` ; sans `qui:marc`, `bloqué`, `en-cours`, `jules`, `preuve-attendue` ;
// toutes les tâches attendues fermées ; aucune PR ouverte ne la cite ; un « Fini quand » écrit.
// Frein de quota (palier `frein` en tête du fichier) : retient les tâches non permises, état `frein` si c'est tout ce qui reste.
// Capacité : un seul travail par dépôt. Le dépôt est occupé par une tâche `en-cours` ou `jules` ouverte, une PR de
// tâche ouverte, ou un fil actif passé en option. Une tâche `preuve-attendue` n'occupe pas le dépôt.
//
// Frein de quota (MoKarade/.github#184, docs/cycle-de-vie-tache.md §5 bis) : le pourcentage hebdomadaire du quota Claude,
// relevé par la tâche du PC (`quota.json`, .github#45), fixe un palier `frein` (`normal`, `1`, `2`) qui ne laisse passer
// que les tâches permises. Aucune IA, aucun réseau : un nombre, deux seuils, une hystérésis.
//
// Fonctions pures d'un côté (`calculer`, `calculerFrein`), I/O de l'autre (`main`) : les tests n'ont besoin ni de réseau ni de fichier.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const VERSION = 1;

// Étiquettes qui sortent une tâche de la file, avec la raison écrite dans `exclues`.
export const ECARTS_ETIQUETTE = {
  'qui:marc': 'geste-marc',
  'bloqué': 'bloquee',
  'en-cours': 'en-cours',
  jules: 'jules',
  'preuve-attendue': 'preuve-attendue',
};

// Ce que ce calcul ne peut PAS savoir depuis le relevé : l'appelant doit le regarder lui-même.
export const NON_CALCULE = [
  'PR rouge d’un fil ou branche par défaut rouge (absent du relevé)',
  'avis de sécurité Dependabot ou npm (seule l’étiquette `sécurité` compte)',
  'fil actif du projet (à passer avec --fils-actifs)',
  '« Fini quand » prouvable vite (seule sa présence est vérifiée)',
];

const TIERS = {
  1: 'preuve due (preuve-manquante ou PR fusionnée sans acceptation)',
  2: 'prio:1',
  3: 'sécurité',
  4: 'même mission que la dernière tâche',
  5: 'même chantier que la dernière tâche',
  6: 'alternance (autre type de chantier)',
  7: 'le reste, par prio puis numéro',
};

// Frein de quota : LE seul endroit où régler les seuils (en % du quota hebdomadaire). Palier 1 dès `seuil1`, palier 2 dès `seuil2` ;
// on ne redescend d'un palier que `hysteresis` points sous son seuil (évite d'osciller autour de 80 %) ; un relevé de plus de
// `perimeHeures` heures n'est plus une mesure : on garde le dernier palier connu.
export const FREIN = { seuil1: 80, seuil2: 90, hysteresis: 2, perimeHeures: 3 };

const niveauDe = (palier) => (palier === 1 || palier === 2 ? palier : 0);
const libelleDe = (niveau) => (niveau === 0 ? 'normal' : niveau);

/**
 * Palier du frein pour un relevé de quota.
 * @param pct pourcentage hebdomadaire utilisé (nombre), @param mesureUtc date de la mesure (ISO)
 * @param precedent palier du calcul précédent (`normal`, 1 ou 2) ou undefined s'il est inconnu
 * Rend { palier: 'normal'|1|2, detail }. Jamais un faux « normal » : relevé absent ou périmé = dernier palier connu, dit tel quel ;
 * sans relevé ni palier précédent, `normal` MAIS `detail.inconnu` vaut true (ce n'est pas une mesure).
 */
export function calculerFrein({ pct, mesureUtc, precedent, maintenant = new Date(), seuils = FREIN } = {}) {
  const seuilDe = (niveau) => (niveau === 2 ? seuils.seuil2 : seuils.seuil1);
  const avant = niveauDe(precedent);
  const mesure = Date.parse(mesureUtc);
  const valide = typeof pct === 'number' && Number.isFinite(pct) && pct >= 0 && Number.isFinite(mesure);
  const ageHeures = valide ? (maintenant.getTime() - mesure) / 3.6e6 : null;
  const perime = !valide || ageHeures > seuils.perimeHeures;
  const inconnu = perime && precedent === undefined && !valide;
  let niveau;
  if (perime && precedent !== undefined) niveau = avant;
  else if (!valide) niveau = 0;
  else {
    // Montée immédiate ; descente d'un palier à la fois, seulement sous (seuil - hystérésis).
    niveau = avant;
    while (niveau > 0 && pct < seuilDe(niveau) - seuils.hysteresis) niveau -= 1;
    niveau = Math.max(niveau, pct >= seuils.seuil2 ? 2 : pct >= seuils.seuil1 ? 1 : 0);
  }
  const quota = valide ? `${pct} % le ${mesureUtc}` : 'aucun relevé exploitable';
  const raison = inconnu ? 'aucun relevé de quota ni palier précédent : palier normal par défaut, ce n’est pas une mesure'
    : perime ? `quota périmé (${quota}${valide ? `, ${Math.round(ageHeures * 10) / 10} h` : ''}) : dernier palier connu gardé`
    : niveau === 0 ? `quota à ${pct} % : rien ne change`
    : `quota à ${pct} % : ${niveau === 2 ? 'plus aucune nouvelle tâche (sécurité, incident et preuve due exceptés)' : 'seules les tâches prio:1, sécurité, incident et preuve due partent'}`;
  return {
    palier: libelleDe(niveau),
    detail: { pct: valide ? pct : null, mesure_utc: valide ? mesureUtc : null, age_heures: valide ? Math.round(ageHeures * 10) / 10 : null, perime, inconnu, precedent: libelleDe(avant), seuils: { palier1: seuils.seuil1, palier2: seuils.seuil2, hysteresis: seuils.hysteresis, perime_heures: seuils.perimeHeures }, raison },
  };
}

/** Une tâche passe-t-elle le frein ? Les incidents, la sécurité et la preuve due (fin d'un travail déjà fait) passent toujours. */
export function permiseParFrein({ labels, tier }, palier) {
  if (palier === 'normal') return true;
  if (labels.includes('incident') || securite(labels) || tier === 1) return true;
  return palier === 1 && labels.includes('prio:1');
}

const minuscule = (s) => String(s).toLowerCase();
const ref = (depot, n) => `${minuscule(depot)}#${n}`;
// Un enfant est un numéro (même dépôt) ou « dépôt#n » (autre dépôt) : on le ramène à « dépôt#n » en minuscules.
const refEnfant = (depot, k) => (typeof k === 'number' ? ref(depot, k) : minuscule(k));
const prioDe = (etiquettes) => {
  const m = etiquettes.map((l) => /^prio:(\d)$/.exec(l)).find(Boolean);
  return m ? Number(m[1]) : 3;
};
const typeChantier = (etiquettes) =>
  etiquettes.includes('chantier:standard') ? 'standard' : etiquettes.includes('chantier:fonction') ? 'fonction' : null;
const securite = (etiquettes) => etiquettes.includes('sécurité') || etiquettes.includes('securite');

/** Index global : référence -> { noeud, depot }, parent de chaque référence (mission, chantier), PR fusionnées connues. */
export function indexer(backlog) {
  const noeuds = new Map();
  const parents = new Map();
  // Certaines tâches « attendent » une PR (ex. `memoryai#132`) : fusionnée, l'attente est levée.
  const depotParCle = new Map(backlog.repos.map((d) => [d.key, d.repo]));
  const fusionnees = new Set((backlog.prlog ?? []).filter((p) => p.m && depotParCle.has(p.r)).map((p) => ref(depotParCle.get(p.r), p.n)));
  for (const depot of backlog.repos) {
    for (const noeud of Object.values(depot.nodes)) {
      noeuds.set(ref(depot.repo, noeud.n), { noeud, depot });
      if (noeud.lvl === 'tâche') continue;
      for (const k of noeud.kids ?? []) parents.set(refEnfant(depot.repo, k), ref(depot.repo, noeud.n));
    }
  }
  return { noeuds, parents, fusionnees };
}

/**
 * Remonte de la tâche à sa mission (le premier parent de niveau mission) puis au premier ancêtre de niveau chantier
 * (quatre sauts au plus). Une mission imbriquée sous une mission sans chantier (ex. une mission commune à plusieurs
 * dépôts) n'a pas de chantier : `chantier` reste null, jamais une mission prise pour un chantier.
 */
function ascendants(reference, idx) {
  let mission = null;
  let courant = idx.parents.get(reference) ?? null;
  for (let saut = 0; saut < 4 && courant; saut += 1) {
    const niveau = idx.noeuds.get(courant)?.noeud.lvl;
    if (niveau === 'chantier') return { mission, chantier: courant };
    if (!mission) mission = courant;
    courant = idx.parents.get(courant) ?? null;
  }
  return { mission, chantier: null };
}

/** Le type (`standard` / `fonction`) du chantier de cette référence, ou null (aucun chantier, ou chantier sans type). */
const typeDuChantier = (haut, idx) => (haut.chantier ? typeChantier(idx.noeuds.get(haut.chantier)?.noeud.labels ?? []) : null);

/** La dernière tâche lancée (début) ou fermée du dépôt, ou null. */
function derniere(depot) {
  let meilleure = null;
  for (const n of Object.values(depot.nodes)) {
    if (n.lvl !== 'tâche') continue;
    const t = [n.start, n.closed].filter(Boolean).sort().pop();
    if (t && (!meilleure || t > meilleure.t)) meilleure = { t, n };
  }
  return meilleure?.n ?? null;
}

/** Pourquoi une tâche ouverte n'est pas prenable (code), ou null si elle l'est. */
function ecart(n, depot, idx) {
  for (const [etiquette, code] of Object.entries(ECARTS_ETIQUETTE)) if (n.labels.includes(etiquette)) return { code, detail: etiquette };
  const dependances = n.deps ?? [];
  const levee = (d) => !idx.noeuds.has(minuscule(d)) && idx.fusionnees.has(minuscule(d));
  const inconnue = dependances.find((d) => !idx.noeuds.has(minuscule(d)) && !levee(d));
  if (inconnue) return { code: 'attend-inconnue', detail: inconnue };
  const ouverte = dependances.find((d) => !levee(d) && idx.noeuds.get(minuscule(d)).noeud.state === 'open');
  if (ouverte) return { code: 'attend-ouverte', detail: ouverte };
  if (n.pr?.state === 'open') return { code: 'pr-ouverte', detail: `PR ${n.pr.repo ?? depot.repo}#${n.pr.n}` };
  if (!String(n.fq ?? '').trim()) return { code: 'fini-quand-absent', detail: '' };
  return null;
}

/**
 * Calcule la file de chaque dépôt.
 * @param backlog le contenu de backlog.json
 * @param options.filsActifs dépôts (nom ou clé) où un fil de ce projet travaille déjà
 * @param options.frein résultat de `calculerFrein` (absent : palier normal, rien n'est retenu)
 */
export function calculer(backlog, { filsActifs = [], frein = null } = {}) {
  const idx = indexer(backlog);
  const actifs = new Set(filsActifs.map(minuscule));
  const palier = frein?.palier ?? 'normal';
  const alertes = [];
  if (frein && (palier !== 'normal' || frein.detail.perime)) alertes.push(`Frein de quota, palier ${palier} : ${frein.detail.raison}`);
  const depots = backlog.repos.map((depot) => {
    const taches = Object.values(depot.nodes).filter((n) => n.lvl === 'tâche' && n.state === 'open');
    const exclues = {};
    const prenables = [];
    for (const n of taches) {
      const e = ecart(n, depot, idx);
      if (e) exclues[ref(depot.repo, n.n)] = e;
      else prenables.push(n);
    }
    // Capacité : un seul travail à la fois.
    const occupePar = [
      ...taches.filter((n) => n.labels.includes('en-cours') || n.labels.includes('jules')).map((n) => ({ ref: ref(depot.repo, n.n), motif: n.labels.includes('jules') ? 'jules' : 'en-cours' })),
      ...taches.filter((n) => n.pr?.state === 'open' && !n.labels.includes('en-cours') && !n.labels.includes('jules')).map((n) => ({ ref: ref(depot.repo, n.n), motif: 'pr-ouverte' })),
      ...(actifs.has(minuscule(depot.repo)) || actifs.has(minuscule(depot.name)) || actifs.has(minuscule(depot.key)) ? [{ ref: null, motif: 'fil-actif' }] : []),
    ];

    const derniereTache = derniere(depot);
    const refDerniere = derniereTache ? ref(depot.repo, derniereTache.n) : null;
    const hautDerniere = refDerniere ? ascendants(refDerniere, idx) : { mission: null, chantier: null };
    const typeDerniere = typeDuChantier(hautDerniere, idx);
    // Chantiers réels sans étiquette de type (seuls ceux-là se corrigent par une étiquette) : une tâche sans chantier n'alterne pas.
    const chantiersSansType = new Set();
    let alternanceEnJeu = false;

    let retenues = 0;
    const file = prenables.map((n) => {
      const r = ref(depot.repo, n.n);
      const haut = ascendants(r, idx);
      const type = typeDuChantier(haut, idx);
      let tier = 7;
      if (n.labels.includes('preuve-manquante') || n.pr?.merged) tier = 1;
      else if (n.labels.includes('prio:1')) tier = 2;
      else if (securite(n.labels)) tier = 3;
      else if (haut.mission && haut.mission === hautDerniere.mission) tier = 4;
      else if (haut.chantier && haut.chantier === hautDerniere.chantier) tier = 5;
      else if (typeDerniere && type && type !== typeDerniere) tier = 6;
      if (tier >= 6 && refDerniere) {
        alternanceEnJeu = true;
        if (haut.chantier && !type) chantiersSansType.add(haut.chantier);
      }
      // Frein de quota : une tâche retenue sort de la file (jamais proposée) et dit pourquoi dans `exclues`.
      if (!permiseParFrein({ labels: n.labels, tier }, palier)) {
        exclues[r] = { code: 'frein-quota', detail: `palier ${palier}` };
        retenues += 1;
        return null;
      }
      return { ref: r, n: n.n, titre: n.title, url: n.url, prio: prioDe(n.labels), tier, raison: TIERS[tier], mission: haut.mission, chantier: haut.chantier };
    }).filter(Boolean);
    file.sort((a, b) => a.tier - b.tier || a.prio - b.prio || a.n - b.n);
    file.forEach((f, i) => { f.rang = i + 1; });
    if (alternanceEnJeu && hautDerniere.chantier && !typeDerniere) chantiersSansType.add(hautDerniere.chantier);
    if (chantiersSansType.size) alertes.push(`${depot.name} : alternance standard/fonction non calculable (chantier sans étiquette chantier:standard ou chantier:fonction : ${[...chantiersSansType].join(', ')})`);

    const incidents = depot.incidents ?? [];
    const statut = incidents.length ? 'incident' : occupePar.length ? 'occupe' : file.length ? 'libre' : retenues ? 'frein' : 'rien';
    return {
      depot: depot.name,
      cle: depot.key,
      repo: depot.repo,
      statut,
      suivante: statut === 'libre' ? file[0] : null,
      incidents: incidents.map((i) => ({ n: i.n, titre: i.t, url: i.url })),
      occupe_par: occupePar,
      derniere: refDerniere,
      file,
      exclues,
    };
  });
  return { version: VERSION, source_asof: backlog.asof, non_calcule: NON_CALCULE, frein: palier, frein_detail: frein?.detail ?? null, alertes, depots };
}

function lireArguments(argv) {
  const options = { filsActifs: [], sortie: null, entree: null, quota: null, precedent: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--fils-actifs') options.filsActifs = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (argv[i] === '--sortie') options.sortie = argv[++i];
    else if (argv[i] === '--quota') options.quota = argv[++i];
    else if (argv[i] === '--precedent') options.precedent = argv[++i];
    else if (!options.entree) options.entree = argv[i];
  }
  return options;
}

/** Lit un JSON s'il existe ; rend null s'il est absent ou illisible (le frein le dit « périmé », il ne devine rien). */
function lireJsonOuNull(chemin) {
  try { return existsSync(chemin) ? JSON.parse(readFileSync(chemin, 'utf8')) : null; } catch { return null; }
}

/** Le frein d'après `quota.json` (à côté du relevé par défaut) et le palier du `prochaines.json` précédent (idem). */
export function freinDepuisFichiers(dossier, { quota = null, precedent = null, maintenant = new Date() } = {}) {
  const q = lireJsonOuNull(quota ?? join(dossier, 'quota.json'));
  const av = lireJsonOuNull(precedent ?? join(dossier, 'prochaines.json'));
  const claude = q?.jauges?.claude;
  return calculerFrein({ pct: claude?.utilise, mesureUtc: claude?.mesure_utc ?? claude?.source_asof, precedent: av?.frein, maintenant });
}

function main() {
  const { entree, sortie, filsActifs, quota, precedent } = lireArguments(process.argv.slice(2));
  if (!entree) {
    console.error('usage : node scripts/prochaine-tache.mjs backlog.json [--fils-actifs depot,depot] [--sortie prochaines.json] [--quota quota.json] [--precedent prochaines.json]');
    process.exit(2);
  }
  // Sans option, le frein lit `quota.json` et `prochaines.json` dans le dossier du relevé : le relevé du PC n'a rien à changer.
  const frein = freinDepuisFichiers(dirname(entree), { quota, precedent });
  const resultat = { ...calculer(JSON.parse(readFileSync(entree, 'utf8')), { filsActifs, frein }), calcule_le: new Date().toISOString() };
  const texte = `${JSON.stringify(resultat, null, 1)}\n`;
  if (sortie) writeFileSync(sortie, texte);
  else process.stdout.write(texte);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
