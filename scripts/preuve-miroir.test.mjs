import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cibles, commentaire, finiQuand, marqueur, miroir, tacheDePr, verdict } from './preuve-miroir.mjs';

const SHA = 'f410df91ec444711fb73a7d2c41013bac127cdc4';
const DEPOT = 'MoKarade/FinanceAI';
const CORPS_TACHE = [
  '**Avant** : x',
  '**Fini quand** (classe A) : tests verts ; `https://finance.hubperso.com/` répond 200.',
  '**Source** : demande de Marc ; voir https://exemple.evil/x',
].join('\n');

test('tacheDePr : #n, dépôt#n, absente', () => {
  assert.deepEqual(tacheDePr('Tâche : #53\n'), { depot: null, numero: 53 });
  assert.deepEqual(tacheDePr('Tâche : MoKarade/FinanceAI#53'), { depot: 'MoKarade/FinanceAI', numero: 53 });
  assert.equal(tacheDePr('rien'), null);
});

test('finiQuand ne garde que sa section ; cibles ne garde que hubperso.com et lit le code attendu', () => {
  const texte = finiQuand(CORPS_TACHE);
  assert.ok(texte.includes('finance.hubperso.com'));
  assert.ok(!texte.includes('evil'));
  assert.deepEqual(cibles(texte), [{ url: 'https://finance.hubperso.com/', attendu: 200 }]);
  assert.deepEqual(cibles('https://hubperso.com.evil.test/ et https://user:pw@carai.hubperso.com/'), []);
});

test('verdict : code attendu, sinon sans 5xx', () => {
  assert.equal(verdict({ code: 200, attendu: 200 }).ok, true);
  assert.equal(verdict({ code: 302, attendu: 200 }).ok, false);
  assert.equal(verdict({ code: 302, attendu: null }).ok, true);
  assert.equal(verdict({ code: 503, attendu: null }).ok, false);
  assert.equal(verdict({ code: null, attendu: null }).ok, false);
});

test('commentaire : marqueur, jamais « Acceptée »', () => {
  const c = commentaire({ sha: SHA, pr: 62, lectures: [{ url: 'https://finance.hubperso.com/', code: 200, ok: true }] });
  assert.ok(c.startsWith(marqueur(SHA)));
  assert.ok(c.includes('lu : ok'));
  assert.ok(!/Acceptée/.test(c));
});

function faux({ prs, issue, commentaires = [] }) {
  const ecrits = [];
  const api = async (chemin, init = {}) => {
    if (init.method === 'POST') { ecrits.push({ chemin, body: init.body.body }); return {}; }
    if (chemin.includes('/commits/')) return prs;
    if (chemin.includes('/comments')) return commentaires;
    return issue;
  };
  return { api, ecrits };
}
const pr = { number: 62, merged_at: '2026-10-29T20:25:00Z', merge_commit_sha: SHA, body: 'Tâche : #53' };
const tache = { labels: [{ name: 'niveau:tâche' }], body: CORPS_TACHE };

test('miroir : lit, écrit UN commentaire, ne ferme rien', async () => {
  const f = faux({ prs: [pr], issue: tache });
  const r = await miroir({ api: f.api, lire: async () => 200, depot: DEPOT, sha: SHA });
  assert.deepEqual(r, { statut: 'ecrit', ok: true });
  assert.equal(f.ecrits.length, 1);
  assert.ok(f.ecrits[0].chemin.endsWith('/issues/53/comments'));
});

test('miroir : un écart est dit, une 2e fois ne réécrit pas, PR non fusionnée ou sans tâche ignorées', async () => {
  const f = faux({ prs: [pr], issue: tache });
  assert.deepEqual(await miroir({ api: f.api, lire: async () => 502, depot: DEPOT, sha: SHA }), { statut: 'ecrit', ok: false });
  assert.ok(f.ecrits[0].body.includes('lu : écart'));
  const g = faux({ prs: [pr], issue: tache, commentaires: [{ body: marqueur(SHA) }] });
  assert.equal((await miroir({ api: g.api, lire: async () => 200, depot: DEPOT, sha: SHA })).raison, 'déjà écrit');
  assert.equal(g.ecrits.length, 0);
  assert.equal((await miroir({ api: faux({ prs: [], issue: tache }).api, lire: async () => 200, depot: DEPOT, sha: SHA })).statut, 'ignore');
  assert.equal((await miroir({ api: faux({ prs: [{ ...pr, body: '' }], issue: tache }).api, lire: async () => 200, depot: DEPOT, sha: SHA })).raison, 'la PR ne cite pas de tâche');
});
