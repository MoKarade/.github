#!/usr/bin/env node
// Contrôle d'un geste réclamé à Marc (docs/archive/cycle-de-vie-tache-2026-10-29.md §5 ter, mission MoKarade/.github#703, tâche #706).
//
// Constat du 28/10/2026 : 5 gestes sur 7 de la liste de Marc n'étaient pas à lui (une tâche du PC, une obsolète, une déjà faite,
// une mal étiquetée, une à reporter). Une étiquette `qui:marc` posée à la légère fait attendre la tâche et encombre sa liste.
// Règle : une tâche `qui:marc` porte une ligne `Geste : …` (ce qu'il fait, étapes exactes) ET une ligne `Pourquoi lui seul : …`
// (compte à lui, argent, décision, écran à regarder), dans le corps ou dans un commentaire.
//
// Déclencheur : l'événement `issues: labeled` (geste-controle.yml), aucun minuteur. Sans ligne complète, UN commentaire qui le dit et
// l'étiquette `geste-incomplet`, sans retirer `qui:marc` (le geste reste affiché à Marc : on ne devine pas qu'il est faux).
// Fonctions pures d'un côté (`analyserGeste`, `texteDuCommentaire`, `decider`), I/O de l'autre (`controler` avec `api` injecté, `main`).
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const LABEL_GESTE = 'qui:marc';
export const LABEL_INCOMPLET = 'geste-incomplet';
export const MARQUEUR = '<!-- geste-controle -->';

// Une ligne « Geste : … » : en début de ligne (gras, puces et citations tolérés), jamais « Gestes de Marc » ni un mot qui la contient.
const LIGNE_GESTE = /^[\s>*_\-#]*Geste\s*\*{0,2}\s*:\s*\*{0,2}\s*(.+)$/im;
const LIGNE_POURQUOI = /^[\s>*_\-#]*Pourquoi\s+lui\s+seul\s*\*{0,2}\s*:\s*\*{0,2}\s*(.+)$/im;

/** Une valeur écrite pour de vrai : pas vide, pas un gabarit laissé tel quel (`…`, `<raison>`, `...`). */
const valeurReelle = (v) => {
  const t = (v ?? '').replace(/[*_`\s]/g, '');
  return t.length >= 3 && !/^(…|\.{3}|<[^>]*>|\[[^\]]*\]|à compléter|todo)$/i.test(t);
};

/**
 * Lit la ligne « Geste » et la ligne « Pourquoi lui seul » dans le corps puis dans les commentaires (le premier qui les porte l'emporte).
 * Les commentaires de ce contrôle (marqueur) sont ignorés : son propre texte cite les deux lignes.
 * @returns {{ geste: string|null, pourquoi: string|null, complet: boolean }}
 */
export function analyserGeste({ corps = '', commentaires = [] } = {}) {
  const textes = [corps ?? '', ...commentaires.map((c) => c?.body ?? '').filter((b) => !b.includes(MARQUEUR))];
  const trouver = (re) => {
    for (const t of textes) {
      const m = re.exec(t);
      if (m && valeurReelle(m[1])) return m[1].trim();
    }
    return null;
  };
  const geste = trouver(LIGNE_GESTE);
  const pourquoi = trouver(LIGNE_POURQUOI);
  return { geste, pourquoi, complet: Boolean(geste && pourquoi) };
}

/** Le commentaire unique, qui dit ce qui manque (sans deviner si le geste est vrai). */
export function texteDuCommentaire({ geste, pourquoi }) {
  const manque = [];
  if (!geste) manque.push('une ligne `Geste : …` (ce que Marc fait, avec les étapes exactes)');
  if (!pourquoi) manque.push('une ligne `Pourquoi lui seul : …` (son compte, de l\'argent, une décision, ou un écran qu\'il doit regarder)');
  return [
    MARQUEUR,
    '**Geste incomplet** : `qui:marc` est posé, mais il manque ' + manque.join(' et ') + '.',
    '',
    'Écrire la ou les lignes en commentaire (ou dans le corps). Si rien de cela n\'est vrai (tâche du PC, déjà faite, obsolète, à reporter), ce n\'est pas un geste de Marc : le fil retire `qui:marc` et dit à qui revient la tâche.',
    '',
    'Règle : docs/archive/cycle-de-vie-tache-2026-10-29.md §5 ter. `qui:marc` reste posé tant que personne ne l\'a retiré.',
  ].join('\n');
}

/**
 * Décide quoi faire pour un événement `labeled`. Pure.
 * @returns {{ action: 'rien'|'signaler', raison: string }}
 */
export function decider({ etiquette, issue, commentaires }) {
  if (etiquette !== LABEL_GESTE) return { action: 'rien', raison: 'autre étiquette' };
  if (!issue || issue.pull_request) return { action: 'rien', raison: 'pas une issue' };
  const noms = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
  if (!noms.includes('niveau:tâche')) return { action: 'rien', raison: 'pas une tâche' };
  if (issue.state && issue.state !== 'open') return { action: 'rien', raison: 'tâche fermée' };
  const a = analyserGeste({ corps: issue.body, commentaires });
  if (a.complet) return { action: 'rien', raison: 'ligne complète' };
  if (noms.includes(LABEL_INCOMPLET) || commentaires.some((c) => (c?.body ?? '').includes(MARQUEUR))) return { action: 'rien', raison: 'déjà signalé' };
  return { action: 'signaler', raison: 'ligne incomplète', analyse: a };
}

/** Passe sur un événement. `api(méthode, chemin, corps)` -> JSON ; lève sur toute erreur. Rend la phrase du journal. */
export async function controler({ api, depot, evenement }) {
  const issue = evenement?.issue;
  if (!issue?.number) return 'événement sans issue : rien';
  const commentaires = [];
  for (let page = 1; page <= 10; page += 1) {
    const lot = (await api('GET', `/repos/${depot}/issues/${issue.number}/comments?per_page=100&page=${page}`)) ?? [];
    commentaires.push(...lot);
    if (lot.length < 100) break;
  }
  const d = decider({ etiquette: evenement.label?.name, issue, commentaires });
  if (d.action === 'rien') return `#${issue.number} : rien (${d.raison})`;
  await api('POST', `/repos/${depot}/issues/${issue.number}/comments`, { body: texteDuCommentaire(d.analyse) });
  await api('POST', `/repos/${depot}/issues/${issue.number}/labels`, { labels: [LABEL_INCOMPLET] });
  return `#${issue.number} : geste incomplet signalé`;
}

function apiReelle(jeton) {
  return async function api(methode, chemin, corps) {
    const r = await fetch(`https://api.github.com${chemin}`, {
      method: methode,
      headers: { Authorization: `Bearer ${jeton}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(corps ? { 'Content-Type': 'application/json' } : {}) },
      body: corps ? JSON.stringify(corps) : undefined,
    });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`${methode} ${chemin} : HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.status === 204 ? null : r.json();
  };
}

async function main() {
  const { GITHUB_TOKEN: jeton, GITHUB_EVENT_PATH: chemin, GITHUB_REPOSITORY: depot } = process.env;
  if (!jeton || !chemin || !depot) { console.error('GITHUB_TOKEN, GITHUB_EVENT_PATH ou GITHUB_REPOSITORY absent : rien à faire.'); process.exit(2); }
  const evenement = JSON.parse(readFileSync(chemin, 'utf8')); // une donnée : jamais passée à un interpréteur de commandes
  try {
    console.log(await controler({ api: apiReelle(jeton), depot, evenement }));
  } catch (erreur) {
    // Un contrôle d'information ne met jamais une tâche ni le dépôt en rouge : l'avertissement se lit dans le journal.
    console.log(`::warning title=Geste::contrôle impossible : ${String(erreur.message).slice(0, 200)}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
