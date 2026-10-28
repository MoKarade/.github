import test from 'node:test';
import assert from 'node:assert/strict';
import { choisirTache, jugerLecture, lirePages, resumer } from './preuve-page.mjs';

const DEPOT = 'MoKarade/FinanceAI';
const CORPS_B = '**Fini quand** (classe B) : la page des totaux s’affiche.\n**Lecture de page** : GET /totaux → 200, contient « Total »\n';

function faux({ merged = true, prBody = 'Tâche : #115', issue = {} } = {}) {
  const tache = { number: 115, state: 'open', body: CORPS_B, labels: [{ name: 'niveau:tâche' }, { name: 'en-cours' }], ...issue };
  return async (methode, chemin) => {
    if (chemin === `/repos/${DEPOT}/pulls/7`) return { number: 7, merged, body: prBody };
    if (chemin === `/repos/${DEPOT}/issues/115`) return tache;
    return null;
  };
}

test('valide : une PR fusionnée qui cite une tâche de classe B est à lire, avec ses lectures', async () => {
  const r = await choisirTache({ api: faux(), depot: DEPOT, numeroPr: 7 });
  assert.equal(r.applicable, true);
  assert.equal(r.numero, 115);
  assert.deepEqual(r.lectures, [{ chemin: '/totaux', statut: 200, texte: 'Total' }]);
});

test('rejeté : PR non fusionnée, sans tâche, deux tâches, tâche fermée, en attente, classe A, classe B sans lecture', async () => {
  const cas = [
    [{ merged: false }, /pas fusionnée/],
    [{ prBody: 'rien' }, /exactement une tâche/],
    [{ prBody: 'Tâche : #115\nTâche : #116' }, /exactement une tâche/],
    [{ issue: { state: 'closed' } }, /pas une tâche ouverte/],
    [{ issue: { labels: [{ name: 'niveau:tâche' }, { name: 'qui:marc' }] } }, /attend quelque chose/],
    [{ issue: { body: '**Fini quand** (classe A) : `npm test`' } }, /n’est pas de classe B/],
    [{ issue: { body: '**Fini quand** (classe B) : x' } }, /classe B mal écrite/],
    [{ issue: { body: '**Fini quand** : x' } }, /n’est pas de classe B/],
  ];
  for (const [options, motif] of cas) {
    const r = await choisirTache({ api: faux(options), depot: DEPOT, numeroPr: 7 });
    assert.equal(r.applicable, false, JSON.stringify(options));
    assert.match(r.motif, motif);
  }
});

test('jugerLecture : statut et texte doivent correspondre, une erreur de navigation refuse', () => {
  const l = { chemin: '/totaux', statut: 200, texte: 'Total' };
  assert.deepEqual(jugerLecture(l, { statut: 200, texteTrouve: true }), { ok: true, detail: 'GET /totaux → 200, contient « Total » : lu' });
  assert.equal(jugerLecture(l, { statut: 500, texteTrouve: false }).ok, false);
  assert.match(jugerLecture(l, { statut: 500, texteTrouve: false }).detail, /HTTP 500 reçu/);
  assert.match(jugerLecture(l, { statut: 200, texteTrouve: false }).detail, /texte absent de la page/);
  assert.match(jugerLecture(l, { erreur: 'navigation impossible' }).detail, /navigation impossible/);
  assert.equal(jugerLecture({ chemin: '/', statut: 200, texte: null }, { statut: 200, texteTrouve: true }).ok, true);
});

test('resumer : tout doit être lu et conforme, sinon refus ; rien lu = refus', () => {
  const ls = [{ chemin: '/a', statut: 200, texte: null }, { chemin: '/b', statut: 200, texte: 'x' }];
  assert.equal(resumer(ls, [{ statut: 200, texteTrouve: true }, { statut: 200, texteTrouve: true }]).ok, true);
  const r = resumer(ls, [{ statut: 200, texteTrouve: true }, { statut: 404, texteTrouve: false }]);
  assert.equal(r.ok, false);
  assert.match(r.detail, /GET \/a → 200 : lu ; GET \/b → 200, contient « x » : HTTP 404 reçu/);
  assert.deepEqual(resumer(ls, []), { ok: false, detail: 'aucune page lue' });
  assert.deepEqual(resumer([], []), { ok: false, detail: 'aucune page lue' });
});

function navigateurFaux(pages, appels = []) {
  return {
    appels,
    lancer: async () => ({
      newContext: async () => ({
        newPage: async () => {
          let courant = null;
          return {
            goto: async (url) => {
              appels.push(url);
              courant = pages[new URL(url).pathname];
              if (courant === 'panne') throw new Error('net::ERR_CONNECTION_REFUSED http://localhost:3000 secret-interne');
              return { status: () => courant?.statut ?? 404 };
            },
            innerText: async () => courant?.corps ?? '',
          };
        },
      }),
      close: async () => appels.push('fermé'),
    }),
  };
}

test('lirePages : statut et texte lus, navigateur fermé, l’erreur brute n’est jamais recopiée', async () => {
  const nav = navigateurFaux({ '/totaux': { statut: 200, corps: 'Total général 12' }, '/vide': { statut: 200, corps: 'rien' }, '/casse': 'panne' });
  const lectures = [
    { chemin: '/totaux', statut: 200, texte: 'Total' },
    { chemin: '/vide', statut: 200, texte: 'Total' },
    { chemin: '/casse', statut: 200, texte: null },
    { chemin: '/absente', statut: 404, texte: null },
  ];
  const lus = await lirePages({ urlBase: 'http://localhost:3000', lectures, lancerNavigateur: nav.lancer });
  assert.deepEqual(lus, [{ statut: 200, texteTrouve: true }, { statut: 200, texteTrouve: false }, { erreur: 'navigation impossible' }, { statut: 404, texteTrouve: true }]);
  assert.equal(nav.appels.at(-1), 'fermé');
  assert.doesNotMatch(JSON.stringify(lus), /secret-interne/);
});

test('lirePages : une page hors de l’app n’est jamais ouverte', async () => {
  const nav = navigateurFaux({});
  const lus = await lirePages({ urlBase: 'http://localhost:3000', lectures: [{ chemin: 'http://evil.test/x', statut: 200, texte: null }], lancerNavigateur: nav.lancer });
  assert.deepEqual(lus, [{ erreur: 'page hors de l’app' }]);
  assert.deepEqual(nav.appels, ['fermé']);
});

test('lirePages : le stockage local est posé avant le chargement, les étapes jouées ; une étape qui échoue refuse toutes les lectures', async () => {
  const journal = [];
  const fabrique = (echecEtape) => async () => ({
    newContext: async () => ({
      addInitScript: async (_f, [origine, entrees]) => journal.push(['stockage', origine, entrees]),
      newPage: async () => ({
        goto: async (url) => (journal.push(['goto', url]), { status: () => 200 }),
        innerText: async () => 'Dettes',
        mouse: { move: async (x, y) => journal.push(['pointeur', x, y]) },
        getByRole: () => ({ click: async () => { if (echecEtape) throw new Error('introuvable (détail interne)'); journal.push(['clic']); } }),
        getByText: () => ({ first: () => ({ waitFor: async () => journal.push(['attente']) }) }),
        waitForTimeout: async () => {},
      }),
    }),
    close: async () => {},
  });
  const lectures = [{ chemin: '/#DEBT', statut: 200, texte: 'Dettes' }];
  const etapes = [{ verbe: 'cliquer-bouton', texte: 'Activer le mode test' }, { verbe: 'attendre-texte', texte: 'MODE TEST' }];
  const stockage = [{ cle: 'app_onboarding_done', valeur: 'true' }];
  const bon = await lirePages({ urlBase: 'http://localhost:3000', lectures, lancerNavigateur: fabrique(false), etapes, stockage });
  assert.deepEqual(bon, [{ statut: 200, texteTrouve: true }]);
  assert.deepEqual(journal.slice(0, 3), [['stockage', 'http://localhost:3000', [['app_onboarding_done', 'true']]], ['clic'], ['attente']]);
  const mauvais = await lirePages({ urlBase: 'http://localhost:3000', lectures, lancerNavigateur: fabrique(true), etapes, stockage });
  assert.deepEqual(mauvais, [{ erreur: 'étape impossible' }]);
  assert.doesNotMatch(JSON.stringify(mauvais), /détail interne/);
});
