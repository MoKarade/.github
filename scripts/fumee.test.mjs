// Tests de la fumée : un vrai serveur HTTP local joue l'app (saine, puis cassée de chaque façon).
// Aucune dépendance, aucun réseau externe (`node --test scripts/`). Chaque contrôle a un cas vert ET un cas rouge.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { formeSummary, fumee, tableau } from './fumee.mjs';

const JETON = 'jeton-de-test';
const SUMMARY = {
  contractVersion: 1,
  app: { id: 'app-test', name: 'App test', url: 'https://x.test', color: '#112233' },
  generatedAt: '2026-10-16T01:00:00.000Z',
  status: 'building',
  metrics: [],
  alerts: [],
  actions: [],
};

/** Sert une fausse app ; `defauts` remplace le comportement de chaque route. */
async function appFausse(surcharges = {}) {
  const routes = new Map(Object.entries({
    '/api/sante': (req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'),
    '/hub/summary': (req, res) => {
      if (req.headers['x-hub-token'] !== JETON) return res.writeHead(401).end();
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(SUMMARY));
    },
    '/login': (req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<html></html>'),
    ...surcharges,
  }));
  // Map et non objet : l'URL d'une requête ne doit jamais choisir une méthode héritée (CodeQL, appel dynamique).
  const serveur = createServer((req, res) => (routes.get(req.url) ?? ((_, r) => r.writeHead(404).end()))(req, res));
  await new Promise((ok) => serveur.listen(0, '127.0.0.1', ok));
  return { base: `http://127.0.0.1:${serveur.address().port}`, fermer: () => new Promise((ok) => serveur.close(ok)) };
}

const config = (base, extra = {}) => ({
  base, sante: '/api/sante', summary: '/hub/summary', connexion: '/login', jeton: JETON,
  essais: 2, delaiMs: 5, timeoutMs: 1000, ...extra,
});
const etat = (resultats) => Object.fromEntries(resultats.map((r) => [r.nom, r.ok ? 'vert' : r.cause]));

async function avec(surcharges, extra, verifier) {
  const app = await appFausse(surcharges);
  try {
    return await verifier(etat(await fumee(config(app.base, extra))));
  } finally {
    await app.fermer();
  }
}

test('app saine : les quatre contrôles sont verts', () =>
  avec({}, {}, (e) => assert.deepEqual(e, { sante: 'vert', 'summary-ferme': 'vert', summary: 'vert', connexion: 'vert' })));

test('app sans route summary (dashboard) : seuls santé et connexion sont contrôlés', () =>
  avec({}, { summary: '' }, (e) => assert.deepEqual(Object.keys(e), ['sante', 'connexion'])));

test('URL cassée : rien ne répond, tout est rouge, sans fuite du message réseau', async () => {
  const app = await appFausse();
  await app.fermer(); // port fermé : connexion refusée
  const r = etat(await fumee(config(app.base)));
  assert.equal(r.sante, 'connexion impossible');
  assert.equal(r.summary, 'connexion impossible');
  assert.equal(r.connexion, 'connexion impossible');
});

test('santé : 200 mais ok:false est une panne', () =>
  avec({ '/api/sante': (q, s) => s.writeHead(200).end('{"ok":false,"cause":"base"}') }, {}, (e) =>
    assert.equal(e.sante, 'ok:true absent de la réponse')));

test('santé : 503 est une panne', () =>
  avec({ '/api/sante': (q, s) => s.writeHead(503).end() }, {}, (e) => assert.equal(e.sante, 'HTTP 503')));

test('summary sans jeton qui répond 200 : faille, rouge', () =>
  avec({ '/hub/summary': (q, s) => s.writeHead(200, { 'cache-control': 'no-store' }).end(JSON.stringify(SUMMARY)) }, {}, (e) =>
    assert.match(e['summary-ferme'], /HTTP 200 sans jeton/)));

test('summary sans jeton : 503 (HUB_TOKEN absent côté app) est accepté', () =>
  avec({ '/hub/summary': (q, s) => s.writeHead(503).end() }, {}, (e) => assert.equal(e['summary-ferme'], 'vert')));

test('summary avec jeton : 401 (jeton refusé) est rouge', () =>
  avec({ '/hub/summary': (q, s) => s.writeHead(401).end() }, {}, (e) => assert.equal(e.summary, 'HTTP 401')));

test('summary : cache-control sans no-store est rouge', () =>
  avec({ '/hub/summary': (q, s) => s.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(SUMMARY)) },
    {}, (e) => assert.equal(e.summary, 'Cache-Control sans no-store')));

test('summary : corps qui n’est pas du JSON est rouge', () =>
  avec({ '/hub/summary': (q, s) => (q.headers['x-hub-token'] ? s.writeHead(200, { 'cache-control': 'no-store' }).end('<html>') : s.writeHead(401).end()) },
    {}, (e) => assert.equal(e.summary, 'la réponse n’est pas du JSON')));

test('summary : jeton non transmis au workflow est une cause claire, pas un faux vert', () =>
  avec({}, { jeton: '' }, (e) => assert.match(e.summary, /jeton du hub absent/)));

test('connexion : 500 rouge ; redirection avec Location verte', async () => {
  await avec({ '/login': (q, s) => s.writeHead(500).end() }, {}, (e) => assert.equal(e.connexion, 'HTTP 500'));
  await avec({ '/login': (q, s) => s.writeHead(307, { location: 'https://hubperso.com/login' }).end() }, {}, (e) =>
    assert.equal(e.connexion, 'vert'));
});

test('panne passagère : un succès au 2e essai suffit', async () => {
  let appels = 0;
  await avec({ '/api/sante': (q, s) => (++appels === 1 ? s.writeHead(502).end() : s.writeHead(200).end('{"ok":true}')) }, {}, (e) =>
    assert.equal(e.sante, 'vert'));
  assert.equal(appels, 2);
});

test('formeSummary : refuse appId dans le corps et un status inconnu', () => {
  assert.equal(formeSummary(SUMMARY), null);
  assert.match(formeSummary({ ...SUMMARY, appId: 'x' }), /appId/);
  assert.match(formeSummary({ ...SUMMARY, status: 'fine' }), /status/);
  assert.match(formeSummary([]), /objet/);
});

test('le tableau ne contient ni jeton ni corps de réponse', async () => {
  const app = await appFausse();
  try {
    const texte = tableau(await fumee(config(app.base)), app.base);
    assert.ok(!texte.includes(JETON));
    assert.ok(!texte.includes('contractVersion'));
  } finally {
    await app.fermer();
  }
});
