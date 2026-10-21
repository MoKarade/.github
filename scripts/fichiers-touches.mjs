#!/usr/bin/env node
// Écrire seul la ligne « Fichiers touchés » des tâches qui n'en ont pas (tâche MoKarade/.github#358, demande de Marc relayée le 21/10/2026 13:55Z :
// « la deuxième place par dépôt doit être réelle »). Deux travaux n'avancent ensemble que si leurs fichiers sont connus et disjoints
// (`scripts/capacite.mjs`) ; or aucune tâche ne les déclarait. Le filet du PC ajoute donc, À LA FIN du corps et sans toucher au texte existant,
// un bloc `<!-- fichiers-auto -->` quand la tâche n'a ni « Fichiers permis » ni « Fichiers touchés ».
//
// Estimation = ce que la tâche CITE, rien de plus : les chemins du corps et du titre (entre `backticks` ou en clair) qui EXISTENT dans le dépôt, un nom
// de fichier seul (`fetch.py`) quand il désigne un à trois fichiers du dépôt, plus le fichier de test voisin de chaque fichier de code cité s'il existe. Pas d'élargissement au dossier : il fermerait la deuxième place dans tout dépôt plat
// (`scripts/`, `lib/`). Si l'estimation est trop étroite, la PR le montre (ses fichiers réels s'ajoutent, tâche #359) et un conflit de texte se
// règle en fusionnant la base. Aucun chemin existant cité (ou plus de `CITES_MAX`) : le bloc dit « non déterminés » et la tâche reste inconnue,
// donc seule (règle du doute). Un « Fichiers permis » exact (gabarit Jules) l'emporte sur ce bloc quand les deux existent.
//
// Fonctions pures (`composerBloc`, `entete`) d'un côté ; I/O injecté (`gh`) de l'autre : les tests n'ont besoin ni de réseau ni de fichier.

import { jetonsChemins, existe } from './jules-gabarit.mjs';
import { tachesCitees } from './jules-suivi.mjs';
import { section } from './jules-auto.mjs';

const ORG = 'MoKarade';
export const MARQUEUR = '<!-- fichiers-auto -->';
export const PAR_TOUR_MAX = 8; // tâches écrites par tour, tous dépôts confondus : les lectures et les écritures restent bornées
export const CITES_MAX = 10; // au-delà, la tâche est trop large pour une estimation honnête
// La ligne existe déjà (écrite par un fil, par le gabarit Jules ou par ce script) : rien à faire.
// Au début d'une ligne, comme la grammaire de capacite.mjs : une phrase qui parle de la ligne (« la ligne **Fichiers touchés** ») n'est pas la ligne.
export const ENTETE = /^\s*\*\*\s*Fichiers (?:permis|touchés)\s*\*\*/im;
const BLOC_AUTO = /(?:^|\n)<!-- fichiers-auto -->\n\*\*Fichiers touchés\*\*/;
const ETIQUETTES_QUI_ECARTENT = ['en-cours', 'jules', 'preuve-attendue', 'preuve-manquante', 'qui:marc'];
export const HOMONYMES_MAX = 3; // un nom de fichier seul qui en désigne davantage (`index.ts`, `page.tsx`) est ambigu : ignoré
const EXTENSIONS = 'ts|tsx|js|jsx|mjs|cjs|py|md|json|ya?ml|css|sh|sql|ps1|html';
// Un chemin ou un nom de fichier en clair : jamais collé à un autre mot, à une URL (`https://x/y.md` : précédé de `/`) ni à un chemin absolu.
const FICHIER_EN_CLAIR = new RegExp(`(?<![\\w./@-])((?:[\\w@.\\-\\[\\]()]+/)*[\\w@\\-\\[\\]()][\\w@.\\-\\[\\]()]*\\.(?:${EXTENSIONS}))(?![\\w/-])`, 'g');
// Fichiers de suivi et de consigne : cités presque partout (« voir BACKLOG.md »), ils ne disent rien de ce que la tâche modifie. Jamais estimés.
const SUIVI = /(^|\/)(BACKLOG|HANDOVER|CHANGELOG|CLAUDE|AGENTS|README)\.md$/i;
const BLOC = /\n*(?:^|\n)<!-- fichiers-auto -->\n\*\*Fichiers touchés\*\*[\s\S]*$/;
const NON_DETERMINES = /\*\*Fichiers touchés\*\* : non déterminés/;
const FICHIER_CODE = /\.(ts|tsx|js|jsx|mjs)$/;
const FICHIER_TEST = /\.(test|spec)\.[a-z]+$|(^|\/)(tests?|__tests__)\//;
const noms = (labels) => (labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));

/** La tâche a-t-elle déjà sa ligne « Fichiers permis » / « Fichiers touchés » (ou ce bloc) ? */
export const aLaLigne = (corps) => ENTETE.test(String(corps ?? '')) || BLOC_AUTO.test(String(corps ?? ''));

/**
 * Les tests voisins d'un fichier de code : à côté (`a/b.test.ts`) ou sous `tests/` (à la racine, ou sous le préfixe d'app `web/`, `app/`). Pour
 * `page`, `route`, `index`, `layout`, le test porte le nom du dossier (`tests/tendances.test.ts`), comme `deriverTest` de jules-gabarit.mjs.
 */
export function testsCandidats(chemin) {
  const morceaux = chemin.split('/');
  const fichier = morceaux.pop();
  const m = /^(.*)\.(ts|tsx|js|jsx|mjs)$/.exec(fichier);
  if (!m || FICHIER_TEST.test(chemin)) return [];
  const [, nom, ext] = m;
  const exts = ext === 'tsx' ? ['tsx', 'ts'] : ext === 'jsx' ? ['jsx', 'js'] : [ext];
  const dossier = morceaux.length ? `${morceaux.join('/')}/` : '';
  const base = ['page', 'route', 'index', 'layout'].includes(nom) ? (morceaux.at(-1) ?? nom).replace(/[[\]()]/g, '').replace(/^_+|_+$/g, '') || nom : nom;
  const racines = ['tests/', ...(morceaux[0] && ['web', 'app'].includes(morceaux[0]) ? [`${morceaux[0]}/tests/`] : [])];
  return [...new Set([...exts.map((e) => `${dossier}${nom}.test.${e}`), ...racines.flatMap((r) => exts.map((e) => `${r}${base}.test.${e}`))])];
}

/** Le bloc à ajouter : la liste estimée, ou la déclaration honnête de « non déterminés ». */
export function composerBloc({ fichiers = [], raison = '' } = {}) {
  if (!fichiers.length) {
    return `${MARQUEUR}\n**Fichiers touchés** : non déterminés (${raison || 'aucun chemin de fichier existant cité dans la tâche'}). Tant que le fil qui la prend ne les écrit pas, un seul travail à la fois dans ce dépôt.\n`;
  }
  return `${MARQUEUR}\n**Fichiers touchés** (estimation automatique du filet du PC : les chemins cités dans la tâche et leur test ; le fil qui la prend la corrige) :\n${fichiers.map((f) => `- \`${f}\``).join('\n')}\n`;
}

/** Le corps sans le bloc automatique (l'estimation ne se lit pas elle-même). */
export const sansBloc = (corps) => String(corps ?? '').replace(BLOC, '');

/** Le bloc automatique est-il la déclaration « non déterminés » (et la seule ligne de fichiers du corps) ? Alors il se recalcule quand la tâche cite enfin des fichiers. */
export const estNonDeterminee = (corps) => {
  const c = String(corps ?? '');
  return BLOC_AUTO.test(c) && NON_DETERMINES.test(c) && (c.match(new RegExp(ENTETE.source, 'gim')) ?? []).length === 1;
};

/**
 * Le texte où chercher ce que la tâche modifie : son titre et ses sections « Avant », « Après » et « Fini quand » (la tâche touche ce qu'elles citent) ;
 * « Source » ne dit que d'où elle vient (de quoi lire). Un corps sans aucune de ces trois sections (écrit à la main) est lu en entier.
 */
export function texteDeTouche(titre, corps) {
  const c = sansBloc(corps);
  const fond = ['Avant', 'Après', 'Fini quand'].map((t) => section(c, t) ?? '').join('\n');
  return `${titre ?? ''}\n${fond.trim() ? fond : c}`;
}

/** Les fichiers du dépôt (une lecture de l'arbre), ou null si l'arbre est illisible ou tronqué : on retombe alors sur une lecture par chemin. */
export function arbreDe(gh, depot) {
  try {
    const r = gh('GET', `repos/${depot}/git/trees/HEAD?recursive=1`);
    if (!r || r.truncated || !Array.isArray(r.tree)) return null;
    return new Set(r.tree.filter((e) => e.type === 'blob').map((e) => e.path));
  } catch {
    return null;
  }
}

/**
 * Estime les fichiers d'une tâche : cités + existants (+ test voisin existant). Les chemins sont lus dans l'arbre du dépôt quand on l'a (`arbre`, un
 * Set), à défaut un par un ; un nom de fichier seul n'est résolu qu'avec l'arbre. Une erreur autre que « introuvable » remonte (rien n'est deviné).
 * @returns {{ fichiers: string[], raison: string }} `fichiers` vide = non déterminés, `raison` dit pourquoi
 */
export function estimer({ depot, corps, titre = '', gh, arbre = null }) {
  const texte = texteDeTouche(titre, corps);
  const { motifs } = jetonsChemins(texte);
  if (motifs.length) return { fichiers: [], raison: `motif de fichiers (${motifs[0]}) : une liste fermée de chemins est requise` };
  const jetons = [...new Set([...texte.matchAll(FICHIER_EN_CLAIR)].map((m) => m[1].replace(/^\.\//, '')))].filter((j) => !SUIVI.test(j));
  const present = (chemin) => (arbre ? arbre.has(chemin) : existe(gh, depot, chemin));
  const parNom = new Map();
  if (arbre) for (const f of arbre) { const nom = f.slice(f.lastIndexOf('/') + 1); (parNom.get(nom) ?? parNom.set(nom, []).get(nom)).push(f); }
  const fichiers = [];
  const ajouter = (c) => { if (!fichiers.includes(c)) fichiers.push(c); };
  for (const j of jetons) {
    if (j.includes('/')) { if (present(j)) ajouter(j); continue; }
    const homonymes = parNom.get(j) ?? [];
    if (homonymes.length && homonymes.length <= HOMONYMES_MAX) homonymes.forEach(ajouter);
    else if (!arbre && present(j)) ajouter(j); // sans arbre : seulement à la racine du dépôt
  }
  if (fichiers.length > CITES_MAX) return { fichiers: [], raison: `plus de ${CITES_MAX} fichiers cités : trop large pour une estimation` };
  for (const c of [...fichiers]) {
    if (!FICHIER_CODE.test(c)) continue;
    const test = testsCandidats(c).find((t) => !fichiers.includes(t) && present(t));
    if (test) fichiers.push(test);
  }
  return fichiers.length ? { fichiers, raison: '' } : { fichiers: [], raison: 'aucun chemin de fichier existant cité dans la tâche' };
}

/**
 * Complète, dans un dépôt, les tâches ouvertes `niveau:tâche` sans ligne de fichiers, par ordre de priorité puis de numéro, dans la limite de `budget.restant`
 * (partagé entre les dépôts d'un tour). Une tâche qui travaille déjà (`en-cours`, `jules`), qui a livré (`preuve-attendue`), qui est un geste de Marc
 * (`qui:marc`) ou dont une PR ouverte est liée n'est pas touchée : ses fichiers viennent de sa PR. Le corps est relu juste avant l'écriture ; s'il a
 * bougé entre-temps, la tâche attend le tour suivant (aucune écriture perdue pour un fil qui édite).
 * @returns {{ ecrites: {ref: string, fichiers: string[]}[] }}
 */
export function completerDepot({ depot, gh, budget = { restant: PAR_TOUR_MAX }, aBlanc = false }) {
  const court = depot.replace(`${ORG}/`, '');
  const sortie = { ecrites: [], recalculees: [] };
  const prio = (t) => Number(/prio:(\d)/.exec(noms(t.labels).find((l) => /^prio:\d$/.test(l)) ?? '')?.[1] ?? 9);
  const ouvertes = gh('GET', `repos/${depot}/issues?state=open&per_page=100`)
    .filter((i) => !i.pull_request && noms(i.labels).includes('niveau:tâche') && !ETIQUETTES_QUI_ECARTENT.some((x) => noms(i.labels).includes(x)))
    .sort((a, b) => prio(a) - prio(b) || a.number - b.number);
  const neuves = ouvertes.filter((i) => !aLaLigne(i.body));
  const anciennes = ouvertes.filter((i) => estNonDeterminee(i.body));
  if (!neuves.length && !anciennes.length) return sortie;
  const citees = new Set(gh('GET', `repos/${depot}/pulls?state=open&per_page=50`).flatMap((p) => tachesCitees(p)));
  const arbre = arbreDe(gh, depot);
  // Relit, juste avant l'écriture, la tâche telle qu'elle est : un fil qui l'a éditée entre-temps n'est pas écrasé (au tour suivant).
  const ecrire = (t, corpsBase, e, garde) => {
    if (aBlanc) return true;
    const frais = gh('GET', `repos/${depot}/issues/${t.number}`);
    if (frais.updated_at !== t.updated_at || !garde(frais.body)) return false;
    gh('PATCH', `repos/${depot}/issues/${t.number}`, { body: `${corpsBase(frais.body).replace(/\s+$/, '')}\n\n${composerBloc(e)}` });
    return true;
  };
  // 1. « non déterminés » qui peuvent l'être maintenant (la tâche cite enfin un fichier existant) : sans budget, une lecture de l'arbre seulement.
  for (const t of anciennes) {
    if (citees.has(t.number)) continue;
    const e = estimer({ depot, corps: t.body, titre: t.title, gh, arbre });
    if (!e.fichiers.length) continue;
    if (ecrire(t, sansBloc, e, estNonDeterminee)) sortie.recalculees.push({ ref: `${court}#${t.number}`, fichiers: e.fichiers });
  }
  // 2. Les tâches sans ligne, par priorité puis numéro, dans la limite du budget.
  for (const t of neuves) {
    if (budget.restant <= 0) break;
    if (citees.has(t.number)) continue;
    const e = estimer({ depot, corps: t.body, titre: t.title, gh, arbre });
    if (!ecrire(t, (c) => c ?? '', e, (c) => !aLaLigne(c))) continue; // un fil a édité entre-temps : au tour suivant
    budget.restant -= 1;
    sortie.ecrites.push({ ref: `${court}#${t.number}`, fichiers: e.fichiers });
  }
  return sortie;
}
