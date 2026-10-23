// Tests de scripts/controle-preuve.mjs (tâche MoKarade/.github#248). Aucun réseau ni navigateur : `fetch` et `navigateur` sont injectés.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { corpsResume, executer, lireControles, lireLigne, valider } from './controle-preuve.mjs';

test('lireLigne : les trois formes fermées', () => {
  assert.deepEqual(lireLigne('http https://emploi.hubperso.com/sante statut 200 contient "ok"'), { type: 'http', url: 'https://emploi.hubperso.com/sante', statut: 200, contient: 'ok' });
  assert.deepEqual(lireLigne('http https://hubperso.com/ statut 302'), { type: 'http', url: 'https://hubperso.com/', statut: 302, contient: null });
  assert.deepEqual(lireLigne('navigateur https://carai.hubperso.com/ texte "Connexion"'), { type: 'navigateur', url: 'https://carai.hubperso.com/', texte: 'Connexion' });
  assert.deepEqual(lireLigne('actions MoKarade/CarAI smartcar-poll.yml réussi depuis 2026-10-22T23:30:00Z'), { type: 'actions', depot: 'MoKarade/CarAI', workflow: 'smartcar-poll.yml', depuis: '2026-10-22T23:30:00Z' });
});

test('lireLigne : refuse ce qui sort du format fermé', () => {
  for (const l of [
    'http http://hubperso.com/ statut 200', // pas https
    'http https://evil.example.com/ statut 200', // hôte hors hubperso.com
    'http https://hubperso.com.evil.com/ statut 200', // faux sous-domaine
    'http https://user:pw@hubperso.com/ statut 200', // identifiants dans l'adresse
    'navigateur https://hubperso.com/ js "document.cookie"', // JavaScript libre
    'curl https://hubperso.com/',
    'actions MoKarade/CarAI smartcar-poll.yml réussi depuis demain',
  ]) assert.ok(lireLigne(l).erreur, l);
});

test('lireControles : lit corps et commentaires, plusieurs lignes, majuscules et gras', () => {
  const t = 'Avant : x\n**Contrôle** : http https://hubperso.com/ statut 200\n> **Contrôle** : navigateur https://hubperso.com/ texte "Hub"\nautre ligne';
  const c = lireControles(t);
  assert.equal(c.length, 2);
  assert.equal(c[0].type, 'http');
  assert.equal(c[1].type, 'navigateur');
  assert.deepEqual(lireControles('rien'), []);
  assert.deepEqual(lireControles(null), []);
});

test('valider : ouverte, preuve-attendue, au moins un contrôle lisible', () => {
  const issue = { state: 'open', labels: [{ name: 'niveau:tâche' }, { name: 'preuve-attendue' }] };
  const bon = lireControles('**Contrôle** : http https://hubperso.com/ statut 200');
  assert.equal(valider({ issue, controles: bon }).ok, true);
  assert.match(valider({ issue: { ...issue, state: 'closed' }, controles: bon }).raison, /fermée/);
  assert.match(valider({ issue: { state: 'open', labels: [] }, controles: bon }).raison, /preuve-attendue/);
  assert.match(valider({ issue, controles: [] }).raison, /aucune ligne/);
  assert.match(valider({ issue, controles: lireControles('**Contrôle** : bidule') }).raison, /illisible/);
});

const reponse = (status, corps = '') => ({ status, ok: status >= 200 && status < 300, text: async () => corps, json: async () => JSON.parse(corps) });

test('executer http : statut et texte attendus, observé dit dans les deux sens', async () => {
  const c = lireLigne('http https://hubperso.com/ statut 200 contient "Hub"');
  const ok = await executer(c, { fetch: async () => reponse(200, '<h1>Hub perso</h1>') });
  assert.equal(ok.ok, true);
  assert.match(ok.observe, /HTTP 200.*contient « Hub »/);
  const faux = await executer(c, { fetch: async () => reponse(200, 'vide') });
  assert.equal(faux.ok, false);
  assert.match(faux.observe, /ne contient pas « Hub »/);
  const mauvais = await executer(c, { fetch: async () => reponse(503, 'Hub') });
  assert.equal(mauvais.ok, false);
  assert.match(mauvais.observe, /HTTP 503/);
});

test('executer http : une panne réseau est un échec dit, pas une exception', async () => {
  const r = await executer(lireLigne('http https://hubperso.com/ statut 200'), { fetch: async () => { throw new Error('ECONNRESET'); } });
  assert.equal(r.ok, false);
  assert.match(r.observe, /impossible.*ECONNRESET/);
});

test('executer navigateur : sans navigateur le contrôle échoue au lieu de passer', async () => {
  const c = lireLigne('navigateur https://hubperso.com/ texte "Hub"');
  assert.equal((await executer(c, {})).ok, false);
  assert.equal((await executer(c, { navigateur: async () => ({ ok: true }) })).ok, true);
  const absent = await executer(c, { navigateur: async () => ({ ok: false, detail: 'Timeout 15000ms' }) });
  assert.equal(absent.ok, false);
  assert.match(absent.observe, /absent.*Timeout/);
});

test('executer actions : exige un run terminé en succès depuis la date', async () => {
  const c = lireLigne('actions MoKarade/CarAI smartcar-poll.yml réussi depuis 2026-10-22T23:30:00Z');
  const runs = (liste) => async (u) => { assert.match(u, /created=%3E%3D2026-10-22T23%3A30%3A00Z/); return reponse(200, JSON.stringify({ workflow_runs: liste })); };
  const bon = await executer(c, { fetch: runs([{ id: 2, status: 'completed', conclusion: 'success', event: 'schedule', created_at: '2026-10-23T01:00:00Z', html_url: 'https://github.com/x' }]) });
  assert.equal(bon.ok, true);
  assert.match(bon.observe, /run 2 réussi \(schedule/);
  const echec = await executer(c, { fetch: runs([{ id: 3, status: 'completed', conclusion: 'cancelled', event: 'schedule', created_at: 'x' }]) });
  assert.equal(echec.ok, false);
  assert.match(echec.observe, /aucun succès.*cancelled/);
  const vide = await executer(c, { fetch: runs([{ id: 4, status: 'in_progress', conclusion: null }]) });
  assert.equal(vide.ok, false);
  assert.match(vide.observe, /aucun run terminé/);
  const api = await executer(c, { fetch: async () => reponse(404) });
  assert.match(api.observe, /HTTP 404/);
});

test('corpsResume : un seul échec refuse tout, liste vide refuse', () => {
  assert.equal(corpsResume([]).ok, false);
  const m = corpsResume([{ ok: true, observe: 'a' }, { ok: false, observe: 'b' }]);
  assert.equal(m.ok, false);
  assert.match(m.texte, /REFUSÉE/);
  assert.match(m.texte, /- OK : a\n- ÉCHEC : b/);
  assert.match(corpsResume([{ ok: true, observe: 'a' }]).texte, /tout est vu/);
});
