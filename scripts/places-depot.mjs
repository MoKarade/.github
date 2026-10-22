// Places d'un dépôt (docs/cycle-de-vie-tache.md §6, capacité) : un dépôt n'a qu'`PLACES_PAR_DEPOT` travaux à la fois, Jules compris
// (décision de Marc, 21/10/2026 20:00Z : économiser le quota Claude). Jusqu'au 22/10/2026 la limite n'était tenue que par la file de
// `prochaine-tache.mjs` : rien n'empêchait un fil d'ouvrir une troisième PR (.github a eu trois tâches `en-cours` ce jour-là).
// Ce module est appelé par le Garde-fou (scripts/garde-fou.mjs), donc par le contrôle « Garde-fou » déjà exigé dans les dix dépôts :
// une PR sortie du brouillon dont la tâche NE TIENT PAS déjà une place, dans un dépôt dont toutes les places sont prises, est refusée.
//
// Un travail est une tâche ouverte `en-cours` ou `jules` (une tâche et sa PR comptent pour un). Exception du 17/10/2026 (tâche #197) :
// une tâche dont toutes les PR ouvertes n'attendent plus qu'un geste de Marc (issue `qui:marc` « Garde-fou : la PR #n attend un geste de
// Marc ») n'occupe pas le dépôt : le travail suivant part, comme dans la file. Une tâche déjà `en-cours` ou `jules` n'est jamais refusée
// (c'est l'une des places) ; poser `en-cours` à la main sur une tâche est donc la sortie du Coordinateur pour un travail urgent.
//
// Fonctions pures d'un côté (`titreDuGeste`, `occupants`), I/O de l'autre (`controlePlaces`, avec `api` injecté).
// Une liste illisible n'est PAS un refus : avertissement seulement (la file de la routine reste le garde-fou de fond).

import { PLACES_PAR_DEPOT } from './capacite.mjs';
import { LABEL_EN_COURS, PROPRIETAIRE, extraireTachesCompletes } from './tache-liee.mjs';

export const MARQUEUR_PLACES = '<!-- garde-fou-places -->';
const GESTE = /^Garde-fou : la PR #(\d+) attend un geste de Marc$/;

/** Numéros des PR dont le titre d'une issue `qui:marc` dit qu'elles n'attendent plus que Marc. */
export function prsQuiAttendentMarc(issuesMarc) {
  const numeros = new Set();
  for (const i of issuesMarc ?? []) {
    const m = GESTE.exec(i?.title ?? '');
    if (m && !i.pull_request) numeros.add(Number(m[1]));
  }
  return numeros;
}

/**
 * Les travaux qui occupent le dépôt : tâches `en-cours` ou `jules` ouvertes (sans doublon), hors celles dont toutes les PR ouvertes
 * attendent Marc. `prsOuvertes` : [{ number, body }] ; `depotComplet` : « MoKarade/<dépôt> ».
 */
export function occupants({ issues, prsOuvertes, attendentMarc, depotComplet, sauf }) {
  const prDeLaTache = new Map(); // « MoKarade/dépôt#n » -> numéros des PR ouvertes qui la citent
  for (const p of prsOuvertes ?? []) {
    for (const t of extraireTachesCompletes(p.body, depotComplet)) {
      const cle = `${t.depot.toLowerCase()}#${t.numero}`;
      prDeLaTache.set(cle, [...(prDeLaTache.get(cle) ?? []), p.number]);
    }
  }
  const vus = new Set();
  const liste = [];
  for (const i of issues ?? []) {
    if (i.pull_request || vus.has(i.number) || i.number === sauf) continue;
    vus.add(i.number);
    const prs = prDeLaTache.get(`${depotComplet.toLowerCase()}#${i.number}`) ?? [];
    if (prs.length > 0 && prs.every((n) => attendentMarc.has(n))) continue;
    liste.push({ numero: i.number, titre: i.title ?? '', jules: (i.labels ?? []).some((l) => (typeof l === 'string' ? l : l.name) === 'jules') });
  }
  return liste;
}

/**
 * Le dépôt de la tâche citée a-t-il encore une place ?
 * @param lien résultat de `controleTacheLiee` ({ ok, dispense, ouvertes: [{ depot, numero, tientPlace }] })
 * @param api (méthode, chemin) -> JSON ou null (404) ; lève sur toute autre erreur
 */
export async function controlePlaces({ api, pr, lien, places = PLACES_PAR_DEPOT }) {
  const sansObjet = (raison) => ({ ok: true, raison, occupants: [], places, avertissement: null });
  if (pr?.draft === true) return sansObjet('brouillon');
  if (lien?.dispense) return sansObjet(lien.dispense);
  // PR sans tâche ouverte : le contrôle « tâche liée » est déjà rouge, celui-ci n'a rien à dire de plus.
  const ouvertes = lien?.ouvertes ?? [];
  if (!lien?.ok || ouvertes.length === 0) return sansObjet('aucune tâche ouverte à contrôler');
  if (ouvertes.some((t) => t.tientPlace)) return sansObjet('la tâche tient déjà une place');
  // Une PR qui cite plusieurs tâches passe si l'une d'elles trouve une place.
  let dernier = null;
  for (const t of ouvertes) {
    try {
      const base = `/repos/${PROPRIETAIRE}/${t.depot}`;
      const lister = (labels) => api('GET', `${base}/issues?state=open&labels=${labels}&per_page=100`);
      const [enCours, jules, marc, prs] = await Promise.all([
        lister(LABEL_EN_COURS), lister('jules'), lister('qui:marc'), api('GET', `${base}/pulls?state=open&per_page=100`),
      ]);
      const liste = occupants({
        issues: [...(enCours ?? []), ...(jules ?? [])],
        prsOuvertes: prs ?? [],
        attendentMarc: prsQuiAttendentMarc(marc),
        depotComplet: `${PROPRIETAIRE}/${t.depot}`,
        sauf: t.numero,
      });
      const verdict = { ok: liste.length < places, raison: null, occupants: liste, places, depot: t.depot, tache: t.numero, avertissement: null };
      if (verdict.ok) return verdict;
      dernier ??= verdict;
    } catch (erreur) {
      // Liste illisible : pas de refus (le Garde-fou ne bloque pas une PR sur une panne de lecture de l'API), mais on le dit.
      return { ok: true, raison: null, occupants: [], places, avertissement: `places du dépôt illisibles (${erreur.message}) : contrôle sauté` };
    }
  }
  return dernier;
}

export function rapportPlaces(verdict) {
  if (verdict.avertissement) return `Places : non contrôlées, ${verdict.avertissement}.`;
  if (verdict.raison) return `Places : sans objet (${verdict.raison}).`;
  if (verdict.ok) return `Places : vert (${verdict.occupants.length} travail(aux) sur ${verdict.places} place(s) dans ${verdict.depot}).`;
  const tenues = verdict.occupants.slice(0, 3).map((o) => `#${o.numero}${o.jules ? ' (Jules)' : ''}`).join(', ');
  return [
    `Places : **rouge**, ${verdict.depot} a déjà ${verdict.occupants.length} travail(aux) sur ${verdict.places} place(s) : ${tenues}. La tâche #${verdict.tache} de cette PR ne tient pas de place.`,
    '',
    'Un dépôt n’a qu’un nombre limité de travaux à la fois, Jules compris (décision de Marc, 21/10/2026 : économiser le quota ; cycle de vie §6, capacité).',
    '',
    `Pour lever, au choix : (1) attendre que l’un de ces travaux se termine, puis relancer le contrôle « Garde-fou » (Re-run jobs) ; (2) fermer ou mettre en pause l’un d’eux ; (3) pour un travail urgent, le Coordinateur ou Marc pose \`${LABEL_EN_COURS}\` sur la tâche. Repasser la PR en brouillon la met hors de ce contrôle pendant qu’elle itère.`,
  ].join('\n');
}
