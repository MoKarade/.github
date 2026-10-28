import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXEC, analyserLien, analyserReponse, compteursGh, ghCli, lierTout } from './lier-taches.mjs';

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

// ---------- cache ETag de ghCli (.github#741) ----------

/** Remplace `gh` par une suite de réponses (chaîne = sortie normale, objet = erreur levée avec cette sortie) ; rend les arguments reçus. */
function fauxGh(reponses) {
  const vus = [];
  const avant = EXEC.run;
  EXEC.run = (cmd, args) => {
    vus.push(args);
    const r = reponses.shift();
    if (typeof r === 'string') return r;
    throw Object.assign(new Error(r.message ?? 'gh a échoué'), { stdout: r.stdout ?? '', stderr: r.stderr ?? '' });
  };
  return { vus, rendre: () => { EXEC.run = avant; } };
}
const avecCache = (f) => async () => {
  const dossier = mkdtempSync(join(tmpdir(), 'gh-cache-'));
  process.env.GANTT_CACHE_HTTP = dossier;
  try { await f(dossier); } finally { delete process.env.GANTT_CACHE_HTTP; rmSync(dossier, { recursive: true, force: true }); }
};
const reponse200 = (corps, etag = '"abc"') => `HTTP/2.0 200 OK\r\nEtag: ${etag}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(corps)}`;

test('analyserReponse : statut, en-têtes en minuscules, corps ; sans statut tout est corps', () => {
  const r = analyserReponse('HTTP/2.0 304 Not Modified\r\nEtag: "x"\r\n\r\n');
  assert.deepEqual([r.statut, r.entetes.etag, r.corps], [304, '"x"', '']);
  assert.deepEqual(analyserReponse('{"a":1}'), { statut: null, entetes: {}, corps: '{"a":1}' });
});

test('ghCli sans GANTT_CACHE_HTTP : comportement d\'avant, aucun -i ni cache', () => {
  delete process.env.GANTT_CACHE_HTTP;
  const g = fauxGh(['{"id":5}']);
  try {
    assert.deepEqual(ghCli('GET', 'repos/MoKarade/x/issues/1'), { id: 5 });
    assert.deepEqual(g.vus[0], ['api', '-X', 'GET', 'repos/MoKarade/x/issues/1']);
  } finally { g.rendre(); }
});

test('ghCli avec cache : 200 écrit l\'ETag, la lecture suivante est conditionnelle et un 304 rend le corps du cache sans compter', avecCache(async (dossier) => {
  const g = fauxGh([reponse200({ id: 7 }), { stdout: 'HTTP/2.0 304 Not Modified\r\nEtag: "abc"\r\n\r\n', message: 'exit 1' }]);
  try {
    const avant = compteursGh();
    assert.deepEqual(ghCli('GET', 'repos/MoKarade/x/issues/1'), { id: 7 });
    assert.deepEqual(g.vus[0], ['api', '-i', 'repos/MoKarade/x/issues/1']);
    assert.equal(readdirSync(dossier).length, 1);
    assert.deepEqual(ghCli('GET', 'repos/MoKarade/x/issues/1'), { id: 7 });
    assert.deepEqual(g.vus[1], ['api', '-i', 'repos/MoKarade/x/issues/1', '-H', 'If-None-Match: "abc"']);
    const apres = compteursGh();
    assert.deepEqual([apres.req - avant.req, apres.n200 - avant.n200, apres.n304 - avant.n304, apres.comptees - avant.comptees], [2, 1, 1, 1]);
    const fichier = JSON.parse(readFileSync(join(dossier, readdirSync(dossier)[0]), 'utf8'));
    assert.deepEqual([fichier.etag, JSON.parse(fichier.corps)], ['"abc"', { id: 7 }]);
  } finally { g.rendre(); }
}));

test('ghCli avec cache : un 200 neuf remplace le cache ; une erreur 4xx lève et se compte', avecCache(async () => {
  const g = fauxGh([reponse200({ v: 1 }, '"e1"'), reponse200({ v: 2 }, '"e2"'), { stdout: 'HTTP/2.0 404 Not Found\r\n\r\n{"message":"Not Found"}', message: 'gh: Not Found (HTTP 404)' }]);
  try {
    assert.deepEqual(ghCli('GET', 'repos/MoKarade/x/pulls'), { v: 1 });
    assert.deepEqual(ghCli('GET', 'repos/MoKarade/x/pulls'), { v: 2 });
    const avant = compteursGh().erreurs;
    assert.throws(() => ghCli('GET', 'repos/MoKarade/x/pulls'), /404/);
    assert.equal(compteursGh().erreurs - avant, 1);
  } finally { g.rendre(); }
}));

test('ghCli avec cache : une écriture ne passe jamais par le cache', avecCache(async (dossier) => {
  const g = fauxGh(['{}']);
  try {
    ghCli('PUT', 'repos/MoKarade/x/pulls/3/update-branch');
    assert.deepEqual(g.vus[0], ['api', '-X', 'PUT', 'repos/MoKarade/x/pulls/3/update-branch']);
    assert.equal(readdirSync(dossier).length, 0);
  } finally { g.rendre(); }
}));
