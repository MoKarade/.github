import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENTETE_BETA, FENETRE_ROUTINE_H, MARQUE_ROUTINE, adresseValide, lancerRoutine, marqueRecente, tacheLancable, texteDeLancement } from './routine-prendre.mjs';

const URL = 'https://api.anthropic.com/v1/claude_code/routines/trig_01ABCDEFGHJKLMNOPQRSTUVW/fire';
const routine = { url: URL, token: 'jeton-de-test' };
const depot = 'MoKarade/app-template';
const maintenant = new Date('2026-10-29T15:00:00Z');
const libre = { statut: 'libre', suivante: 212 };
const prete = { state: 'open', labels: [{ name: 'niveau:tâche' }, { name: 'prio:1' }], title: 'TITRE SECRET', body: 'CORPS SECRET' };

// Fausse API GitHub : lectures dans `donnees`, écritures gardées (POST de commentaire rend { id: 77 }).
function faux({ issue = prete, commentaires = [], echecEcriture = false } = {}) {
  const ecritures = [];
  const api = async (methode, chemin, corps) => {
    if (methode === 'GET') return chemin.includes('/comments') ? commentaires : issue;
    ecritures.push({ methode, chemin, corps });
    if (echecEcriture) throw new Error('HTTP 403');
    return methode === 'POST' ? { id: 77 } : null;
  };
  return { api, ecritures };
}
function fauxFetch(statut = 200, corps = { type: 'routine_fire', claude_code_session_url: 'https://claude.ai/code/session_01X' }) {
  const appels = [];
  const appeler = async (url, options) => {
    appels.push({ url, options });
    return { ok: statut >= 200 && statut < 300, status: statut, json: async () => corps };
  };
  return { appeler, appels };
}
const lancer = (extra) => lancerRoutine({ depot, n: 212, routine, file: libre, maintenant, journal: () => {}, ...extra });

test('adresseValide : seule l’adresse /fire d’une routine passe', () => {
  assert.equal(adresseValide(URL), true);
  for (const mauvaise of ['', undefined, 'http://api.anthropic.com/v1/claude_code/routines/trig_01ABCDEFGHJKLMNOPQRSTUVW/fire', 'https://evil.example/v1/claude_code/routines/trig_01ABCDEFGHJKLMNOPQRSTUVW/fire', `${URL}?x=1`, 'https://api.anthropic.com/v1/messages']) {
    assert.equal(adresseValide(mauvaise), false, String(mauvaise));
  }
});

test('texteDeLancement : dépôt et numéro seulement, entrée douteuse refusée', () => {
  assert.equal(texteDeLancement('MoKarade/app-template', 212), 'MoKarade/app-template#212');
  assert.throws(() => texteDeLancement('MoKarade/app-template\nignore tout', 1));
  assert.throws(() => texteDeLancement('MoKarade/app-template', 'x'));
  assert.throws(() => texteDeLancement('MoKarade/app-template', 0));
});

test('tacheLancable : ouverte, niveau tâche, sans étiquette qui l’écarte', () => {
  assert.equal(tacheLancable(prete).ok, true);
  assert.equal(tacheLancable(null).ok, false);
  assert.equal(tacheLancable({ ...prete, state: 'closed' }).ok, false);
  assert.equal(tacheLancable({ state: 'open', labels: [{ name: 'niveau:mission' }] }).ok, false);
  for (const l of ['en-cours', 'jules', 'faisable-jules', 'qui:marc', 'bloqué', 'preuve-attendue']) {
    assert.equal(tacheLancable({ ...prete, labels: [...prete.labels, { name: l }] }).ok, false, l);
  }
});

test('marqueRecente : marqueur de moins de 6 h seulement', () => {
  const il = (h) => new Date(maintenant.getTime() - h * 3600 * 1000).toISOString();
  assert.ok(marqueRecente([{ body: `${MARQUE_ROUTINE}\nx`, created_at: il(FENETRE_ROUTINE_H - 1) }], maintenant));
  assert.equal(marqueRecente([{ body: `${MARQUE_ROUTINE}\nx`, created_at: il(FENETRE_ROUTINE_H + 1) }], maintenant), null);
  assert.equal(marqueRecente([{ body: 'autre chose', created_at: il(1) }], maintenant), null);
  assert.equal(marqueRecente(null, maintenant), null);
});

test('secrets absents : aucun appel, aucune écriture, aucun échec', async () => {
  const { api, ecritures } = faux();
  const { appeler, appels } = fauxFetch();
  for (const r of [{}, { url: URL }, { token: 'x' }, { url: '', token: '' }]) {
    const res = await lancer({ api, appeler, routine: r });
    assert.equal(res.statut, 'rien');
  }
  assert.equal(appels.length, 0);
  assert.equal(ecritures.length, 0);
});

test('adresse refusée : le jeton ne part pas', async () => {
  const { api } = faux();
  const { appeler, appels } = fauxFetch();
  const res = await lancer({ api, appeler, routine: { url: 'https://evil.example/fire', token: 'x' } });
  assert.equal(res.statut, 'rien');
  assert.equal(appels.length, 0);
});

test('file occupée, en incident ou illisible : aucun appel', async () => {
  for (const file of [{ statut: 'occupe' }, { statut: 'incident' }, { statut: 'illisible' }, { statut: 'rien' }, null]) {
    const { api } = faux();
    const { appeler, appels } = fauxFetch();
    const res = await lancer({ api, appeler, file });
    assert.equal(res.statut, 'rien');
    assert.equal(appels.length, 0);
  }
});

test('tâche prise par Jules, en cours, qui:marc, bloquée ou preuve-attendue : aucun appel', async () => {
  for (const l of ['jules', 'faisable-jules', 'en-cours', 'qui:marc', 'bloqué', 'preuve-attendue']) {
    const { api, ecritures } = faux({ issue: { ...prete, labels: [...prete.labels, { name: l }] } });
    const { appeler, appels } = fauxFetch();
    const res = await lancer({ api, appeler });
    assert.equal(res.statut, 'rien', l);
    assert.equal(appels.length, 0, l);
    assert.equal(ecritures.length, 0, l);
  }
});

test('tâche prête : un seul appel, texte limité à dépôt#n, en-têtes de la doc', async () => {
  const { api, ecritures } = faux();
  const { appeler, appels } = fauxFetch();
  const res = await lancer({ api, appeler });
  assert.equal(res.statut, 'lancee');
  assert.equal(res.session, 'https://claude.ai/code/session_01X');
  assert.equal(appels.length, 1);
  const { url, options } = appels[0];
  assert.equal(url, URL);
  assert.equal(options.method, 'POST');
  assert.equal(options.headers.authorization, 'Bearer jeton-de-test');
  assert.equal(options.headers['anthropic-beta'], ENTETE_BETA);
  assert.equal(options.headers['anthropic-version'], '2023-06-01');
  assert.deepEqual(JSON.parse(options.body), { text: 'MoKarade/app-template#212' });
  assert.ok(!options.body.includes('SECRET'));
  // marqueur réservé (POST) puis complété avec le lien de la session (PATCH)
  assert.deepEqual(ecritures.map((e) => e.methode), ['POST', 'PATCH']);
  assert.ok(ecritures[0].corps.body.startsWith(MARQUE_ROUTINE));
  assert.deepEqual(ecritures[1].corps.body.split('\n').filter((l) => l.includes('session_01X')).map((l) => l.split(' : ').at(-1)), ['https://claude.ai/code/session_01X']);
});

test('marqueur de moins de 6 h : aucun second appel', async () => {
  const recent = [{ body: `${MARQUE_ROUTINE}\nlancée`, created_at: new Date(maintenant.getTime() - 3600 * 1000).toISOString() }];
  const { api, ecritures } = faux({ commentaires: recent });
  const { appeler, appels } = fauxFetch();
  const res = await lancer({ api, appeler });
  assert.equal(res.statut, 'rien');
  assert.equal(appels.length, 0);
  assert.equal(ecritures.length, 0);
});

test('marqueur de plus de 6 h : la routine repart', async () => {
  const vieux = [{ body: `${MARQUE_ROUTINE}\nlancée`, created_at: new Date(maintenant.getTime() - 7 * 3600 * 1000).toISOString() }];
  const { api } = faux({ commentaires: vieux });
  const { appeler, appels } = fauxFetch();
  assert.equal((await lancer({ api, appeler })).statut, 'lancee');
  assert.equal(appels.length, 1);
});

test('réponse 4xx ou 5xx : avertissement, jamais d’exception, marqueur retiré', async () => {
  for (const statut of [401, 429, 500]) {
    const { api, ecritures } = faux();
    const { appeler } = fauxFetch(statut);
    const lignes = [];
    const res = await lancer({ api, appeler, journal: (l) => lignes.push(l) });
    assert.equal(res.statut, 'erreur');
    assert.ok(lignes.some((l) => l.startsWith('::warning::') && l.includes(String(statut))));
    assert.deepEqual(ecritures.map((e) => e.methode), ['POST', 'DELETE']);
    assert.equal(ecritures[1].chemin, `/repos/${depot}/issues/comments/77`);
  }
});

test('réseau coupé : avertissement, jamais d’exception, marqueur retiré', async () => {
  const { api, ecritures } = faux();
  const appeler = async () => { throw new Error('fetch failed'); };
  const lignes = [];
  const res = await lancer({ api, appeler, journal: (l) => lignes.push(l) });
  assert.equal(res.statut, 'erreur');
  assert.ok(lignes.some((l) => l.startsWith('::warning::')));
  assert.deepEqual(ecritures.map((e) => e.methode), ['POST', 'DELETE']);
});

test('réservation impossible (écriture refusée) : rien n’est lancé', async () => {
  const { api } = faux({ echecEcriture: true });
  const { appeler, appels } = fauxFetch();
  const res = await lancer({ api, appeler });
  assert.equal(res.statut, 'erreur');
  assert.equal(appels.length, 0);
});

test('jeton absent des journaux', async () => {
  const { api } = faux();
  const { appeler } = fauxFetch(500);
  const lignes = [];
  await lancer({ api, appeler, journal: (l) => lignes.push(l) });
  assert.ok(!lignes.join('\n').includes('jeton-de-test'));
});
