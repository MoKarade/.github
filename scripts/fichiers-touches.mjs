#!/usr/bin/env node
// Écrire seul la ligne « Fichiers touchés » des tâches qui n'en ont pas (tâche MoKarade/.github#358, demande de Marc relayée le 21/10/2026 13:55Z :
// « la deuxième place par dépôt doit être réelle »). Deux travaux n'avancent ensemble que si leurs fichiers sont connus et disjoints
// (`scripts/capacite.mjs`) ; or aucune tâche ne les déclarait. Le filet du PC ajoute donc, À LA FIN du corps et sans toucher au texte existant,
// un bloc `<!-- fichiers-auto -->` quand la tâche n'a ni « Fichiers permis » ni « Fichiers touchés ».
//
// Estimation = ce que la tâche CITE, rien de plus : les chemins entre `backticks` (tout le corps) qui EXISTENT dans le dépôt, plus le fichier de
// test voisin de chaque fichier de code cité s'il existe. Pas d'élargissement au dossier : il fermerait la deuxième place dans tout dépôt plat
// (`scripts/`, `lib/`). Si l'estimation est trop étroite, la PR le montre (ses fichiers réels s'ajoutent, tâche #359) et un conflit de texte se
// règle en fusionnant la base. Aucun chemin existant cité (ou plus de `CITES_MAX`) : le bloc dit « non déterminés » et la tâche reste inconnue,
// donc seule (règle du doute). Un « Fichiers permis » exact (gabarit Jules) l'emporte sur ce bloc quand les deux existent.
//
// Fonctions pures (`composerBloc`, `entete`) d'un côté ; I/O injecté (`gh`) de l'autre : les tests n'ont besoin ni de réseau ni de fichier.

import { jetonsChemins, existe } from './jules-gabarit.mjs';
import { tachesCitees } from './jules-suivi.mjs';

const ORG = 'MoKarade';
export const MARQUEUR = '<!-- fichiers-auto -->';
export const PAR_TOUR_MAX = 8; // tâches écrites par tour, tous dépôts confondus : les lectures et les écritures restent bornées
export const CITES_MAX = 10; // au-delà, la tâche est trop large pour une estimation honnête
// La ligne existe déjà (écrite par un fil, par le gabarit Jules ou par ce script) : rien à faire.
export const ENTETE = /\*\*\s*Fichiers (?:permis|touchés)\s*\*\*/i;
const ETIQUETTES_QUI_ECARTENT = ['en-cours', 'jules', 'preuve-attendue', 'qui:marc'];
const FICHIER_CODE = /\.(ts|tsx|js|jsx|mjs)$/;
const FICHIER_TEST = /\.(test|spec)\.[a-z]+$|(^|\/)(tests?|__tests__)\//;
const noms = (labels) => (labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));

/** La tâche a-t-elle déjà sa ligne « Fichiers permis » / « Fichiers touchés » (ou ce bloc) ? */
export const aLaLigne = (corps) => ENTETE.test(String(corps ?? '')) || String(corps ?? '').includes(MARQUEUR);

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

/**
 * Estime les fichiers d'une tâche : cités + existants (+ test voisin existant). Lit le dépôt (existence) ; une erreur autre que « introuvable » remonte
 * (rien n'est deviné). @returns {{ fichiers: string[], raison: string }} `fichiers` vide = non déterminés, `raison` dit pourquoi
 */
export function estimer({ depot, corps, gh }) {
  const { chemins, motifs } = jetonsChemins(corps);
  if (motifs.length) return { fichiers: [], raison: `motif de fichiers (${motifs[0]}) : une liste fermée de chemins est requise` };
  if (chemins.length > CITES_MAX) return { fichiers: [], raison: `plus de ${CITES_MAX} chemins cités : trop large pour une estimation` };
  const fichiers = [];
  for (const c of chemins) {
    if (!existe(gh, depot, c)) continue;
    if (!fichiers.includes(c)) fichiers.push(c);
  }
  for (const c of [...fichiers]) {
    if (!FICHIER_CODE.test(c)) continue;
    const test = testsCandidats(c).find((t) => !fichiers.includes(t) && existe(gh, depot, t));
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
  const sortie = { ecrites: [] };
  if (budget.restant <= 0) return sortie;
  const prio = (t) => Number(/prio:(\d)/.exec(noms(t.labels).find((l) => /^prio:\d$/.test(l)) ?? '')?.[1] ?? 9);
  const candidates = gh('GET', `repos/${depot}/issues?state=open&per_page=100`)
    .filter((i) => !i.pull_request && noms(i.labels).includes('niveau:tâche') && !aLaLigne(i.body)
      && !ETIQUETTES_QUI_ECARTENT.some((x) => noms(i.labels).includes(x)))
    .sort((a, b) => prio(a) - prio(b) || a.number - b.number);
  if (!candidates.length) return sortie;
  const citees = new Set(gh('GET', `repos/${depot}/pulls?state=open&per_page=50`).flatMap((p) => tachesCitees(p)));
  for (const t of candidates) {
    if (budget.restant <= 0) break;
    if (citees.has(t.number)) continue;
    const e = estimer({ depot, corps: t.body ?? '', gh });
    if (!aBlanc) {
      const frais = gh('GET', `repos/${depot}/issues/${t.number}`);
      if (frais.updated_at !== t.updated_at || aLaLigne(frais.body)) continue; // un fil a édité entre-temps : au tour suivant
      gh('PATCH', `repos/${depot}/issues/${t.number}`, { body: `${(frais.body ?? '').replace(/\s+$/, '')}\n\n${composerBloc(e)}` });
    }
    budget.restant -= 1;
    sortie.ecrites.push({ ref: `${court}#${t.number}`, fichiers: e.fichiers });
  }
  return sortie;
}
