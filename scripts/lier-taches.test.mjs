import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXEC, analyserReponse, compteursGh, ghCli } from './lier-taches.mjs';

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
