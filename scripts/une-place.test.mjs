// Production : UN travail par dépôt (décision de Marc, 21/10/2026 20:00Z, « 124 »). Ce fichier n'importe PAS `places-deux.mjs` : il lit la valeur réelle.
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

test('une place par dépôt en production', () => assert.equal(PLACES_PAR_DEPOT, 1));

test('un dépôt libre ne propose qu\'une tâche, même à fichiers disjoints', () => {
  const d = etat([tache(1, { fpl: ['src/a.ts'] }), tache(2, { fpl: ['src/b.ts'] })]);
  assert.equal(d.statut, 'libre');
  assert.deepEqual(d.suivantes.map((s) => s.ref), ['a#1']);
  assert.deepEqual(d.places, { total: 1, prises: 0, libres: 1 });
});

test('un travail en cours occupe le dépôt : aucune suivante, même à fichiers disjoints ; un travail déjà ouvert en 2e place ne rouvre rien', () => {
  const un = etat([tache(1, { labels: ['en-cours'], fpl: ['src/a.ts'] }), tache(2, { fpl: ['src/b.ts'] })]);
  assert.equal(un.statut, 'occupe');
  assert.equal(un.suivante, null);
  assert.deepEqual(un.places, { total: 1, prises: 1, libres: 0 });
  const deux = etat([tache(1, { labels: ['en-cours'], fpl: ['src/a.ts'] }), tache(2, { labels: ['en-cours'], fpl: ['src/b.ts'] }), tache(3, { fpl: ['src/c.ts'] })]);
  assert.equal(deux.statut, 'occupe');
  assert.equal(deux.suivante, null);
  assert.equal(deux.places.libres, 0);
});
