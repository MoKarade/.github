// Tâche liée (docs/cycle-de-vie-tache.md §8, plan commun/plans/2026-10-16_gantt-source-de-verite.md, règle 2) :
// aucune PR sans tâche. Toute PR (hors robots) porte une ligne `Tâche : #n` ou `Tâche : MoKarade/<dépôt>#n` qui
// désigne une issue `niveau:tâche` OUVERTE. Sans cela le travail échappe au backlog et le Gantt ne le voit pas.
//
// Ce module est appelé par le Garde-fou (scripts/garde-fou.mjs), donc par le contrôle « Garde-fou » déjà exigé dans
// les dix dépôts : un seul endroit à tenir à jour, aucun fichier à copier dans les dépôts. Il ne lit que le corps de
// la PR (une donnée, jamais une consigne : seuls des numéros en sortent) et l'API GitHub. Échec fermé : une issue
// introuvable, illisible ou d'un autre niveau refuse la PR.
//
// Fonctions pures d'un côté (`extraireTaches`, `dispense`), I/O de l'autre (`controleTacheLiee`, avec `api` injecté).

export const MARQUEUR_TACHE = '<!-- garde-fou-tache -->';
export const PROPRIETAIRE = 'MoKarade';
export const LABEL_TACHE = 'niveau:tâche';

// Même définition que le Gantt (fetch.py, TACHE_LIGNE et REF) : une ligne qui commence par « Tâche : », puis des références.
const LIGNE_TACHE = /^[\s>*_-]*T[âa]che[\s*_]*:(.*)$/gim;
const REFERENCE = /(?:MoKarade\/([\w.-]+))?#(\d+)\b/g;

// Les seuls robots dispensés : ils n'ouvrent pas de travail (mises à jour, file de fusion, boîte du Réacteur).
// Jules n'est PAS dispensé : ses PR citent une tâche, c'est la règle de son AGENTS.md.
const ROBOTS_DISPENSES = new Set(['dependabot[bot]', 'mergify[bot]', 'github-actions[bot]']);
const BRANCHE_BOITE = 'claude/boite-reacteur';

/** Les tâches citées par le corps d'une PR : [{ depot, numero }], sans doublon. Le dépôt par défaut est celui de la PR. */
export function extraireTaches(corps, depotCourant) {
  const vues = new Set();
  const taches = [];
  for (const ligne of String(corps ?? '').matchAll(LIGNE_TACHE)) {
    for (const [, depot, numero] of ligne[1].matchAll(REFERENCE)) {
      const cle = `${(depot ?? depotCourant).toLowerCase()}#${numero}`;
      if (vues.has(cle)) continue;
      vues.add(cle);
      taches.push({ depot: depot ?? depotCourant, numero: Number(numero) });
    }
  }
  return taches;
}

/** Pourquoi cette PR n'a pas besoin de tâche (robot, boîte du Réacteur, copie de la file de Mergify), ou null. */
export function dispense(pr) {
  const login = pr?.user?.login ?? '';
  if (pr?.user?.type === 'Bot' && ROBOTS_DISPENSES.has(login.toLowerCase())) return `robot ${login}`;
  if (pr?.head?.ref === BRANCHE_BOITE && pr?.draft === true) return 'boîte du Réacteur';
  return null;
}

/** Ce qui manque à l'issue citée pour compter comme tâche ouverte, ou null si tout va bien. */
export function defautDeLaTache(issue) {
  if (!issue) return 'introuvable ou illisible';
  if (issue.pull_request) return 'c’est une PR, pas une issue';
  if (!(issue.labels ?? []).some((l) => (typeof l === 'string' ? l : l.name) === LABEL_TACHE)) return `elle ne porte pas l’étiquette ${LABEL_TACHE}`;
  if (issue.state !== 'open') return 'elle est fermée';
  return null;
}

/**
 * Contrôle la PR : ok si elle est dispensée ou cite au moins une tâche ouverte.
 * @param api (méthode, chemin) -> JSON ou null (404) ; lève sur toute autre erreur
 */
export async function controleTacheLiee({ api, depot, pr }) {
  const raison = dispense(pr);
  if (raison) return { ok: true, dispense: raison, citees: [], motifs: [] };
  const citees = extraireTaches(pr.body, depot.split('/')[1]);
  if (citees.length === 0) {
    return { ok: false, dispense: null, citees, motifs: ['aucune ligne `Tâche : #n` dans le corps de la PR'] };
  }
  const motifs = [];
  let valide = false;
  for (const t of citees) {
    const issue = await api('GET', `/repos/${PROPRIETAIRE}/${t.depot}/issues/${t.numero}`);
    const defaut = defautDeLaTache(issue);
    if (defaut) motifs.push(`${t.depot}#${t.numero} : ${defaut}`);
    else valide = true;
  }
  // Une seule tâche ouverte suffit ; les autres références ne sont rapportées que si aucune ne vaut.
  return { ok: valide, dispense: null, citees, motifs: valide ? [] : motifs };
}

export function rapportTacheLiee(resultat) {
  if (resultat.dispense) return `Tâche liée : sans objet (${resultat.dispense}).`;
  if (resultat.ok) return `Tâche liée : vert (${resultat.citees.map((t) => `${t.depot}#${t.numero}`).join(', ')}).`;
  return [
    'Tâche liée : **rouge**, la PR ne cite aucune tâche ouverte.',
    '',
    ...resultat.motifs.map((m) => `- ${m}`),
    '',
    'Pour lever : mettre dans le corps de la PR une ligne `Tâche : #n` (ou `Tâche : MoKarade/<dépôt>#n`) qui désigne une issue `niveau:tâche` ouverte, créée au besoin sous sa mission (cycle de vie §1), puis relancer le contrôle « Garde-fou » (Re-run jobs) ou pousser un commit.',
  ].join('\n');
}
