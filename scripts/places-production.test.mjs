// Production : SANS LIMITE de places par dépôt (décision de Marc, 29/10/2026 16:13Z, « On va arrêter le 3 max maintenant plus de limite », tâche MoKarade/.github#874 ;
// trois travaux du 26 au 29/10/2026). Reste la règle des fichiers disjoints : deux travaux qui se recoupent, ou dont les fichiers sont inconnus, ne tournent pas ensemble. Ce fichier n'importe PAS `places-deux.mjs` : il lit la valeur réelle.
// Les tests de la mécanique à deux places (fichiers disjoints, couloirs) tournent à deux places dans leurs propres fichiers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLACES_PAR_DEPOT, SANS_LIMITE } from './capacite.mjs';
import { calculer, couloirsDe } from './prochaine-tache.mjs';

const tache = (n, o = {}) => ({
  n, title: `Tâche ${n}`, lvl: 'tâche', labels: ['niveau:tâche', ...(o.labels ?? [])], state: 'open',
  url: `https://github.com/exemple/depot/issues/${n}`, kids: [], start: null, closed: null, pr: null, deps: [], fpl: o.fpl, fq: 'une commande de test passe',
});
const depot = (noeuds) => ({ repo: 'a', name: 'a', key: 'a', incidents: [], nodes: Object.fromEntries(noeuds.map((n) => [String(n.n), n])) });
const etat = (noeuds) => calculer({ asof: '2026-10-21T20:00:00Z', repos: [depot(noeuds)], prlog: [] }).depots[0];

test('production : aucune limite de places', () => assert.equal(PLACES_PAR_DEPOT, SANS_LIMITE));

test('un dépôt libre propose toutes les tâches à fichiers disjoints, pas seulement trois', () => {
  const d = etat([1, 2, 3, 4, 5].map((n) => tache(n, { fpl: [`src/f${n}.ts`] })));
  assert.equal(d.statut, 'libre');
  assert.deepEqual(d.suivantes.map((s) => s.ref), ['a#1', 'a#2', 'a#3', 'a#4', 'a#5']);
  assert.equal(d.places.prises, 0);
});

test('trois travaux en cours ne remplissent plus le dépôt : une quatrième tâche à fichiers disjoints part', () => {
  const trois = [1, 2, 3].map((n) => tache(n, { labels: ['en-cours'], fpl: [`src/f${n}.ts`] }));
  const d = etat([...trois, tache(4, { fpl: ['src/d.ts'] })]);
  assert.equal(d.statut, 'partiel');
  assert.deepEqual(d.suivantes.map((s) => s.ref), ['a#4']);
  assert.equal(d.places.prises, 3);
});

test('les fichiers disjoints restent la règle : un recoupement ou des fichiers inconnus gardent la tâche en file', () => {
  const enCours = tache(1, { labels: ['en-cours'], fpl: ['src/a.ts'] });
  const recoupe = etat([enCours, tache(2, { fpl: ['src/a.ts'] })]);
  assert.equal(recoupe.statut, 'occupe');
  assert.equal(recoupe.suivante, null);
  const inconnus = etat([enCours, tache(3, {})]);
  assert.equal(inconnus.suivante, null);
});

test('les couloirs du Gantt suivent les travaux réels, jamais une centaine de places', () => {
  assert.equal(couloirsDe([], []).length, 3);
  const occupes = [1, 2, 3, 4, 5].map((n) => ({ ref: `a#${n}`, motif: 'en-cours', fichiers: null }));
  assert.equal(couloirsDe(occupes, [{ ref: 'a#9', fichiers: null }]).length, 6);
});
