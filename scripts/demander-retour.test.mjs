import assert from 'node:assert/strict';
import { test } from 'node:test';
import { corpsEvenement, demander } from './demander-retour.mjs';

test('corpsEvenement : garde l’origine https, coupe le sha, refuse http', () => {
  assert.deepEqual(corpsEvenement({ urlBase: 'https://carai.hubperso.com/login', depot: 'MoKarade/CarAI', sha: 'a'.repeat(50) }), {
    event_type: 'fumee-rouge',
    client_payload: { url_base: 'https://carai.hubperso.com', depot: 'MoKarade/CarAI', sha: 'a'.repeat(40) },
  });
  assert.throws(() => corpsEvenement({ urlBase: 'http://x.example' }), /https/);
  assert.throws(() => corpsEvenement({ urlBase: 'pas une url' }));
});

test('demander : sans jeton, rien n’est envoyé et le dit', async () => {
  let appels = 0;
  const r = await demander({ jeton: '', urlBase: 'https://a.example', appel: async () => { appels++; } });
  assert.equal(appels, 0);
  assert.equal(r.envoye, false);
  assert.match(r.raison, /HUB_DISPATCH_TOKEN absent/);
});

test('demander : POST vers MoKarade/.github avec le jeton en en-tête, 204 = envoyé', async () => {
  let vu;
  const r = await demander({
    jeton: 'jeton-secret',
    urlBase: 'https://emploi.hubperso.com',
    depot: 'MoKarade/JobAI',
    sha: 'abc1234',
    appel: async (url, init) => { vu = { url, init }; return { status: 204 }; },
  });
  assert.equal(r.envoye, true);
  assert.equal(vu.url, 'https://api.github.com/repos/MoKarade/.github/dispatches');
  assert.equal(vu.init.method, 'POST');
  assert.equal(vu.init.headers.authorization, 'Bearer jeton-secret');
  assert.deepEqual(JSON.parse(vu.init.body).client_payload, { url_base: 'https://emploi.hubperso.com', depot: 'MoKarade/JobAI', sha: 'abc1234' });
  assert.ok(!vu.init.body.includes('jeton-secret'));
});

test('demander : un refus de GitHub lève sans mettre le jeton dans le message', async () => {
  await assert.rejects(
    demander({ jeton: 'jeton-secret', urlBase: 'https://a.example', appel: async () => ({ status: 403 }) }),
    (e) => /HTTP 403/.test(e.message) && !e.message.includes('jeton-secret'),
  );
});
