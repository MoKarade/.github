import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyserLien, lierTout } from './lier-taches.mjs';

test('analyserLien lit dépôt#n, y compris .github, et refuse le reste', () => {
  assert.deepEqual(analyserLien('memoryai#93'), { depot: 'memoryai', n: 93 });
  assert.deepEqual(analyserLien('.github#16'), { depot: '.github', n: 16 });
  assert.equal(analyserLien('#93'), null);
  assert.equal(analyserLien('memoryai/93'), null);
  assert.equal(analyserLien(undefined), null);
});

test('lierTout pose le lien sur la tâche qui attend, avec l\'identifiant de celle qu\'elle attend', () => {
  const appels = [];
  const gh = (methode, chemin, corps) => { appels.push([methode, chemin, corps]); return methode === 'GET' ? { id: 777 } : {}; };
  const r = lierTout([{ ref: 'memoryai#93', attend: 'memoryai#92' }], gh);
  assert.deepEqual(r.faits, ['memoryai#93 <- memoryai#92']);
  assert.deepEqual(appels, [
    ['GET', 'repos/MoKarade/memoryai/issues/92', undefined],
    ['POST', 'repos/MoKarade/memoryai/issues/93/dependencies/blocked_by', { issue_id: 777 }],
  ]);
});

test('lierTout lit une seule fois l\'identifiant d\'une tâche attendue par plusieurs', () => {
  let lectures = 0;
  const gh = (methode) => { if (methode === 'GET') { lectures += 1; return { id: 1 }; } return {}; };
  lierTout([{ ref: 'a#1', attend: '.github#16' }, { ref: 'b#2', attend: '.github#16' }], gh);
  assert.equal(lectures, 1);
});

test('lierTout traite « déjà lié » comme un succès, pas comme un échec', () => {
  const gh = (methode) => { if (methode === 'GET') return { id: 1 }; throw new Error('HTTP 422: dependency already exists'); };
  const r = lierTout([{ ref: 'a#1', attend: 'b#2' }], gh);
  assert.deepEqual(r.deja, ['a#1 <- b#2']);
  assert.equal(r.echecs.length, 0);
});

test('lierTout range les autres erreurs en échecs sans jamais lever, et continue', () => {
  const gh = (methode, chemin) => { if (chemin.includes('/issues/1/')) throw new Error('HTTP 403: Resource not accessible'); return methode === 'GET' ? { id: 5 } : {}; };
  const r = lierTout([{ ref: 'a#1', attend: 'b#2' }, { ref: 'c#3', attend: 'b#2' }, { ref: '??', attend: 'b#2' }], gh);
  assert.deepEqual(r.faits, ['c#3 <- b#2']);
  assert.equal(r.echecs.length, 2);
  assert.match(r.echecs[0].raison, /403/);
  assert.equal(r.echecs[1].raison, 'référence illisible');
});

test('lierTout à blanc ne touche pas GitHub', () => {
  let appels = 0;
  const r = lierTout([{ ref: 'a#1', attend: 'b#2' }], () => { appels += 1; return {}; }, { aBlanc: true });
  assert.equal(appels, 0);
  assert.deepEqual(r.faits, ['a#1 <- b#2']);
});
