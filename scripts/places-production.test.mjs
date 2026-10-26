// Production : TROIS travaux par dépôt (décision de Marc, 26/10/2026 17:39Z, « plusieurs tâches par dépôt en même temps à partir de maintenant »,
// après la mesure de la semaine : jusqu'à 13 en-cours à la fois dans .github, la place unique n'était déjà plus tenue). Ce fichier n'importe PAS `places-deux.mjs` : il lit la valeur réelle.
// Les tests de la mécanique à deux places (fichiers disjoints, couloirs) tournent à deux places dans leurs propres fichiers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLACES_PAR_DEPOT } from './capacite.mjs';
import { calculer } from './prochaine-tache.mjs';

const tache = (n, o = {}) => ({
  n, title: `Tâche ${n}`, lvl: 'tâche', labels: ['niveau:tâche', ...(o.labels ?? [])], state: 'open',
  url: `https://github.com/exemple/depot/issues/${n}`, kids: [], start: null, closed: null, pr: null, deps: [], fpl: o.fpl, fq: 'une commande de test passe',
});
const depot = (noeuds) => ({ repo: 'a', name: 'a', key: 'a', incidents: [], nodes: Object.fromEntries(noeuds.map((n) => [String(n.n), n])) });
const etat = (noeuds) => calculer({ asof: '2026-10-21T20:00:00Z', repos: [depot(noeuds)], prlog: [] }).depots[0];

test('trois places par dépôt en production', () => assert.equal(PLACES_PAR_DEPOT, 3));

test('un dépôt libre propose jusqu\'à trois tâches à fichiers disjoints, pas une quatrième', () => {
  const d = etat([tache(1, { fpl: ['src/a.ts'] }), tache(2, { fpl: ['src/b.ts'] }), tache(3, { fpl: ['src/c.ts'] }), tache(4, { fpl: ['src/d.ts'] })]);
  assert.equal(d.statut, 'libre');
  assert.deepEqual(d.suivantes.map((s) => s.ref), ['a#1', 'a#2', 'a#3']);
  assert.deepEqual(d.places, { total: 3, prises: 0, libres: 3 });
});

test('deux travaux en cours laissent une place ; trois occupent le dépôt', () => {
  const deux = etat([tache(1, { labels: ['en-cours'], fpl: ['src/a.ts'] }), tache(2, { labels: ['en-cours'], fpl: ['src/b.ts'] }), tache(3, { fpl: ['src/c.ts'] })]);
  assert.equal(deux.statut, 'partiel');
  assert.deepEqual(deux.suivantes.map((s) => s.ref), ['a#3']);
  assert.deepEqual(deux.places, { total: 3, prises: 2, libres: 1 });
  const trois = etat([tache(1, { labels: ['en-cours'], fpl: ['src/a.ts'] }), tache(2, { labels: ['en-cours'], fpl: ['src/b.ts'] }), tache(3, { labels: ['en-cours'], fpl: ['src/c.ts'] }), tache(4, { fpl: ['src/d.ts'] })]);
  assert.equal(trois.statut, 'occupe');
  assert.equal(trois.suivante, null);
  assert.equal(trois.places.libres, 0);
});
