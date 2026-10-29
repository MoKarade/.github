#!/usr/bin/env node
// Une tâche fermée réveille aussi les dépôts dont une tâche l'attendait (docs/reacteur-dependances.md, mission MoKarade/.github#703, tâche #870).
//
// Constat du 29/10/2026 : app-template#213 fermée à 14:50Z, six tâches d'autres dépôts (« Attend : app-template#213 ») n'ont rien reçu pendant 20 min, jusqu'à un
// réveil à la main. Le Réacteur d'un dépôt ne réveillait que ce dépôt.
//
// Ici, la partie pure et la lecture : quelles tâches OUVERTES d'AUTRES dépôts citent `dépôt#n` sur leur ligne `**Attend**` ? (`lireAttend`, la même grammaire que la file.)
// Le réveil lui-même est fait par `reveil-reacteur.mjs` (un seul appel) avec les mêmes boîtes que les autres réveils : aucun cron, aucun secret de plus.
// Une lecture qui échoue (dépôt privé, panne) n'empêche pas les autres dépôts : elle est dite dans `illisibles`, le filet de 6 h reprend la main.
import { LABEL_TACHE, lireAttend } from './file-depot.mjs';

const PAGES_MAX = 3;
const noms = (issue) => (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));

/** La clé « dépôt#n » en minuscules, comme `lireAttend`. */
export const cleTache = (depot, numero) => `${depot.split('/').pop().toLowerCase()}#${numero}`;

/** Une issue ouverte d'un autre dépôt attend-elle cette tâche ? Pure. */
export function attendCetteTache({ issue, depotIssue, depot, numero }) {
  if (issue.pull_request || issue.state === 'closed' || !noms(issue).includes(LABEL_TACHE)) return false;
  if (depotIssue.toLowerCase() === depot.toLowerCase()) return false;
  return lireAttend(issue.body, depotIssue.split('/').pop()).includes(cleTache(depot, numero));
}

/**
 * Les tâches ouvertes des AUTRES dépôts qui attendent `depot#numero`.
 * @returns {Promise<{ dependants: { depot: string, taches: number[] }[], illisibles: string[] }>}
 */
export async function dependantsAutresDepots({ api, depot, numero, depots }) {
  const dependants = [];
  const illisibles = [];
  for (const d of depots) {
    if (d.toLowerCase() === depot.toLowerCase()) continue;
    try {
      const taches = [];
      for (let page = 1; page <= PAGES_MAX; page += 1) {
        const lot = await api('GET', `/repos/${d}/issues?labels=${encodeURIComponent(LABEL_TACHE)}&state=open&per_page=100&page=${page}`);
        if (!Array.isArray(lot)) throw new Error('réponse illisible');
        taches.push(...lot.filter((i) => attendCetteTache({ issue: i, depotIssue: d, depot, numero })).map((i) => i.number));
        if (lot.length < 100) break;
      }
      if (taches.length > 0) dependants.push({ depot: d, taches });
    } catch {
      illisibles.push(d);
    }
  }
  return { dependants, illisibles };
}
