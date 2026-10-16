import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { LABEL, appliquer, appsAControler, corpsOuverture, decider, lireApps, sonder, tableau, titrePanne } from './surveillance.mjs';

const CFG = { essais: 2, delaiMs: 5, timeoutMs: 1000, appel: (u, init = {}) => fetch(u, { ...init, signal: AbortSignal.timeout(1000) }) };

/** Fausse app : `statut` et `corps` réglables entre deux appels. */
async function appFausse() {
  const etat = { statut: 200, corps: '{"ok":true}' };
  const serveur = createServer((req, res) => {
    if (req.url !== '/api/sante') return res.writeHead(404).end();
    res.writeHead(etat.statut, { 'content-type': 'application/json' }).end(etat.corps);
  });
  await new Promise((ok) => serveur.listen(0, '127.0.0.1', ok));
  return { etat, url: `http://127.0.0.1:${serveur.address().port}/api/sante`, fermer: () => new Promise((ok) => serveur.close(ok)) };
}

test('lireApps : liste valide, app non sondée avec sa raison', () => {
  const apps = lireApps([
    { nom: 'a', depot: 'MoKarade/A', sante: 'https://a.example/api/sante' },
    { nom: 'b', depot: 'MoKarade/B', sante: null, raison: 'route absente' },
  ]);
  assert.deepEqual(apps, [
    { nom: 'a', depot: 'MoKarade/A', sante: 'https://a.example/api/sante' },
    { nom: 'b', depot: 'MoKarade/B', sante: null, raison: 'route absente' },
  ]);
});

test('lireApps : refuse liste vide, nom en double, http, null sans raison', () => {
  assert.throws(() => lireApps([]), /liste non vide/);
  const D = 'MoKarade/A';
  assert.throws(() => lireApps([{ nom: 'a', depot: D, sante: 'https://a/x' }, { nom: 'a', depot: D, sante: 'https://a/x' }]), /en double/);
  assert.throws(() => lireApps([{ nom: 'a', depot: D, sante: 'http://a/x' }]), /https/);
  assert.throws(() => lireApps([{ nom: 'a', depot: D, sante: null }]), /sans raison/);
  assert.throws(() => lireApps([{ nom: 'A b', depot: D, sante: 'https://a/x' }]), /nom invalide/);
  assert.throws(() => lireApps([{ nom: 'a', sante: 'https://a/x' }]), /depot invalide/);
});

test('surveillance/apps.json réel passe la validation', async () => {
  const { readFileSync } = await import('node:fs');
  const apps = lireApps(JSON.parse(readFileSync(new URL('../surveillance/apps.json', import.meta.url), 'utf8')));
  assert.ok(apps.some((a) => a.sante), 'au moins une app sondée');
  for (const a of apps.filter((x) => !x.sante)) assert.ok(a.raison);
});

test('sonder : app saine, 500, ok:false, corps non JSON, app injoignable', async () => {
  const app = await appFausse();
  try {
    assert.deepEqual(await sonder({ nom: 'x', sante: app.url }, CFG), { nom: 'x', ok: true, cause: null });

    app.etat.statut = 500;
    assert.deepEqual(await sonder({ nom: 'x', sante: app.url }, CFG), { nom: 'x', ok: false, cause: 'HTTP 500' });

    app.etat.statut = 200;
    app.etat.corps = '{"ok":false}';
    assert.equal((await sonder({ nom: 'x', sante: app.url }, CFG)).cause, 'ok:true absent de la réponse');

    app.etat.corps = 'pas du json';
    assert.equal((await sonder({ nom: 'x', sante: app.url }, CFG)).ok, false);
  } finally {
    await app.fermer();
  }
  const r = await sonder({ nom: 'x', sante: 'http://127.0.0.1:1/api/sante' }, CFG);
  assert.deepEqual(r, { nom: 'x', ok: false, cause: 'connexion impossible' });
});

test('sonder : panne passagère rattrapée par le 2e essai', async () => {
  const app = await appFausse();
  try {
    app.etat.statut = 503;
    const attente = sonder({ nom: 'x', sante: app.url }, { ...CFG, essais: 3, delaiMs: 30 });
    setTimeout(() => {
      app.etat.statut = 200;
    }, 15);
    assert.equal((await attente).ok, true);
  } finally {
    await app.fermer();
  }
});

test('decider : ouvre une issue pour une panne nouvelle', () => {
  const actions = decider({ resultats: [{ nom: 'a', ok: false, cause: 'HTTP 500' }], ouvertes: [] });
  assert.deepEqual(actions, [{ type: 'ouvrir', nom: 'a', cause: 'HTTP 500' }]);
});

test('decider : une panne déjà signalée ne fait pas de bruit', () => {
  const actions = decider({ resultats: [{ nom: 'a', ok: false, cause: 'HTTP 500' }], ouvertes: [{ number: 7, title: titrePanne('a') }] });
  assert.deepEqual(actions, []);
});

test('decider : le retour d\'une app ferme son issue, et seulement la sienne', () => {
  const ouvertes = [
    { number: 7, title: titrePanne('a') },
    { number: 8, title: titrePanne('b') },
  ];
  const actions = decider({ resultats: [{ nom: 'a', ok: true, cause: null }, { nom: 'b', ok: false, cause: 'HTTP 500' }], ouvertes });
  assert.deepEqual(actions, [{ type: 'fermer', nom: 'a', numero: 7 }]);
});

test('decider : app saine sans issue, rien à faire', () => {
  assert.deepEqual(decider({ resultats: [{ nom: 'a', ok: true, cause: null }], ouvertes: [] }), []);
});

test('appliquer : ouvre avec l\'étiquette panne puis ferme avec un commentaire', async () => {
  const appels = [];
  const gh = async (args) => {
    appels.push(args);
    return '';
  };
  const apps = [{ nom: 'a', sante: 'https://a.example/api/sante' }];
  await appliquer([{ type: 'ouvrir', nom: 'a', cause: 'HTTP 500' }, { type: 'fermer', nom: 'b', numero: 8 }], apps, gh, new Date('2026-10-16T12:00:00Z'));
  assert.deepEqual(appels[0].slice(0, 6), ['issue', 'create', '--title', 'Panne : a', '--label', LABEL]);
  assert.match(appels[0].at(-1), /HTTP 500/);
  assert.match(appels[0].at(-1), /https:\/\/a\.example\/api\/sante/);
  assert.deepEqual(appels[1].slice(0, 5), ['issue', 'close', '8', '--reason', 'completed']);
  assert.match(appels[1].at(-1), /répond de nouveau/);
});

test('corps de l\'issue : ni jeton ni corps de réponse, heure du Québec', () => {
  const texte = corpsOuverture({ nom: 'a', sante: 'https://a.example/api/sante' }, 'HTTP 500', new Date('2026-10-16T12:00:00Z'));
  assert.match(texte, /heure du Québec/);
  assert.doesNotMatch(texte, /token|secret/i);
});

test('tableau : panne, retour et app à brancher', () => {
  const t = tableau({
    resultats: [{ nom: 'a', ok: false, cause: 'HTTP 500' }, { nom: 'b', ok: true, cause: null }],
    aBrancher: [{ nom: 'c', raison: 'route absente' }],
    actions: [{ type: 'ouvrir', nom: 'a', cause: 'HTTP 500' }],
  });
  assert.match(t, /\| a \| PANNE \| HTTP 500 \| issue ouverte \|/);
  assert.match(t, /\| b \| répond \|/);
  assert.match(t, /\| c \| à brancher \| route absente \|/);
});

test('lancement d\'essai : une seule app simulée, valide pour lireApps (régression du 16/10 : depot manquant)', () => {
  const env = { SURVEILLANCE_ESSAI_NOM: 'essai', SURVEILLANCE_ESSAI_URL: 'https://x.example/api/sante', GITHUB_REPOSITORY: 'MoKarade/.github' };
  const apps = lireApps(appsAControler(env, () => assert.fail('la liste ne doit pas être lue')));
  assert.deepEqual(apps, [{ nom: 'essai', depot: 'MoKarade/.github', sante: 'https://x.example/api/sante' }]);
  assert.equal(lireApps(appsAControler({ SURVEILLANCE_ESSAI_URL: 'https://x.example/s' }, () => '[]'))[0].nom, 'essai', 'nom par défaut');
});

test('sans essai : la liste du dépôt est lue', () => {
  const liste = JSON.stringify([{ nom: 'a', depot: 'MoKarade/A', sante: 'https://a.example/api/sante' }]);
  assert.equal(lireApps(appsAControler({}, () => liste))[0].nom, 'a');
});
