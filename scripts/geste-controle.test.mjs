import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LABEL_INCOMPLET, MARQUEUR, analyserGeste, controler, decider, texteDuCommentaire } from './geste-controle.mjs';

const tache = (extra = {}) => ({ number: 7, state: 'open', body: '', labels: [{ name: 'niveau:tâche' }, { name: 'qui:marc' }], ...extra });
const evenement = (issue, etiquette = 'qui:marc') => ({ action: 'labeled', label: { name: etiquette }, issue });

// Fausse API : commentaires servis par issue, toutes les écritures gardées.
function faux(commentaires = []) {
  const ecritures = [];
  const api = async (methode, chemin, corps) => {
    if (methode === 'GET') {
      assert.match(chemin, /^\/repos\/MoKarade\/\.github\/issues\/7\/comments\?per_page=100&page=1$/);
      return commentaires;
    }
    ecritures.push({ methode, chemin, corps });
    return { id: 1 };
  };
  return { api, ecritures };
}

const COMPLET = 'Geste : ouvrir la page des jetons et cliquer sur « Renouveler ».\nPourquoi lui seul : c\'est son compte GitHub.';

test('analyserGeste : les deux lignes, en gras, en puce ou en citation', () => {
  assert.equal(analyserGeste({ corps: COMPLET }).complet, true);
  assert.equal(analyserGeste({ corps: '- **Geste** : ouvrir la page\n- **Pourquoi lui seul** : son compte' }).complet, true);
  assert.equal(analyserGeste({ corps: '**Geste :** ouvrir la page\n> **Pourquoi lui seul :** c\'est de l\'argent' }).complet, true);
  assert.equal(analyserGeste({ corps: 'GESTE : ouvrir la page\npourquoi LUI seul : décision' }).complet, true);
});

test('analyserGeste : une ligne manque, vide ou laissée au gabarit = incomplet', () => {
  assert.deepEqual(analyserGeste({ corps: 'Geste : ouvrir la page' }), { geste: 'ouvrir la page', pourquoi: null, complet: false });
  assert.equal(analyserGeste({ corps: 'Pourquoi lui seul : son compte' }).geste, null);
  assert.equal(analyserGeste({ corps: 'Geste :\nPourquoi lui seul :' }).complet, false);
  assert.equal(analyserGeste({ corps: 'Geste : …\nPourquoi lui seul : <raison>' }).complet, false);
  assert.equal(analyserGeste({ corps: 'Geste : ...\nPourquoi lui seul : [à compléter]' }).complet, false);
});

test('analyserGeste : « Gestes de Marc » ou une phrase qui contient le mot ne compte pas', () => {
  assert.equal(analyserGeste({ corps: 'Gestes de Marc : 3\nLe geste : à faire\nPourquoi lui seul : x y z' }).geste, null);
});

test('analyserGeste : les lignes viennent du corps ou des commentaires, jamais du commentaire du contrôle', () => {
  const a = analyserGeste({ corps: 'Geste : ouvrir la page', commentaires: [{ body: 'Pourquoi lui seul : son compte' }] });
  assert.equal(a.complet, true);
  const propre = { body: `${MARQUEUR}\nune ligne \`Geste : …\`\nPourquoi lui seul : exemple écrit par le contrôle` };
  assert.equal(analyserGeste({ commentaires: [propre] }).complet, false);
});

test('ligne complète → rien : ni commentaire ni étiquette', async () => {
  const { api, ecritures } = faux();
  const phrase = await controler({ api, depot: 'MoKarade/.github', evenement: evenement(tache({ body: COMPLET })) });
  assert.match(phrase, /rien \(ligne complète\)/);
  assert.deepEqual(ecritures, []);
});

test('ligne complète en commentaire → rien', async () => {
  const { api, ecritures } = faux([{ body: COMPLET }]);
  await controler({ api, depot: 'MoKarade/.github', evenement: evenement(tache()) });
  assert.deepEqual(ecritures, []);
});

test('ligne absente → UN commentaire et l\'étiquette geste-incomplet, qui:marc reste', async () => {
  const { api, ecritures } = faux();
  const phrase = await controler({ api, depot: 'MoKarade/.github', evenement: evenement(tache({ body: 'Avant : x' })) });
  assert.match(phrase, /signalé/);
  assert.equal(ecritures.length, 2);
  assert.deepEqual(ecritures.map((e) => [e.methode, e.chemin]), [['POST', '/repos/MoKarade/.github/issues/7/comments'], ['POST', '/repos/MoKarade/.github/issues/7/labels']]);
  assert.match(ecritures[0].corps.body, /Geste incomplet/);
  assert.ok(ecritures[0].corps.body.includes(MARQUEUR));
  assert.match(ecritures[0].corps.body, /`Geste : …`/);
  assert.match(ecritures[0].corps.body, /`Pourquoi lui seul : …`/);
  assert.deepEqual(ecritures[1].corps, { labels: [LABEL_INCOMPLET] });
  assert.ok(!ecritures.some((e) => e.methode === 'DELETE'), 'qui:marc n\'est jamais retiré');
});

test('le commentaire ne réclame que la ligne qui manque', () => {
  assert.doesNotMatch(texteDuCommentaire({ geste: 'x y z', pourquoi: null }), /`Geste : …`/);
  assert.match(texteDuCommentaire({ geste: 'x y z', pourquoi: null }), /`Pourquoi lui seul : …`/);
  assert.match(texteDuCommentaire({ geste: null, pourquoi: 'son compte' }), /`Geste : …`/);
  assert.doesNotMatch(texteDuCommentaire({ geste: null, pourquoi: 'son compte' }), /`Pourquoi lui seul : …`/);
});

test('déjà signalé (commentaire du contrôle, ou étiquette) → rien, jamais deux commentaires', async () => {
  const a = faux([{ body: texteDuCommentaire({ geste: null, pourquoi: null }) }]);
  assert.match(await controler({ api: a.api, depot: 'MoKarade/.github', evenement: evenement(tache()) }), /déjà signalé/);
  assert.deepEqual(a.ecritures, []);
  const b = faux();
  const avecEtiquette = tache({ labels: [{ name: 'niveau:tâche' }, { name: 'qui:marc' }, { name: LABEL_INCOMPLET }] });
  assert.match(await controler({ api: b.api, depot: 'MoKarade/.github', evenement: evenement(avecEtiquette) }), /déjà signalé/);
  assert.deepEqual(b.ecritures, []);
});

test('autre étiquette → rien, sans même lire les commentaires de l\'issue', () => {
  assert.equal(decider({ etiquette: 'prio:1', issue: tache(), commentaires: [] }).action, 'rien');
  assert.equal(decider({ etiquette: LABEL_INCOMPLET, issue: tache(), commentaires: [] }).action, 'rien');
});

test('hors tâche, fermée ou PR → rien', () => {
  const sansNiveau = tache({ labels: [{ name: 'qui:marc' }] });
  assert.equal(decider({ etiquette: 'qui:marc', issue: sansNiveau, commentaires: [] }).raison, 'pas une tâche');
  assert.equal(decider({ etiquette: 'qui:marc', issue: tache({ state: 'closed' }), commentaires: [] }).raison, 'tâche fermée');
  assert.equal(decider({ etiquette: 'qui:marc', issue: tache({ pull_request: {} }), commentaires: [] }).action, 'rien');
});

test('événement sans issue : rien, sans appel', async () => {
  const api = async () => { throw new Error('aucun appel attendu'); };
  assert.match(await controler({ api, depot: 'MoKarade/.github', evenement: {} }), /rien/);
});

test('plus de cent commentaires : lus par pages, le marqueur de la page 2 est vu', async () => {
  const pages = [Array.from({ length: 100 }, () => ({ body: 'x' })), [{ body: MARQUEUR }]];
  const ecritures = [];
  const api = async (methode, chemin) => {
    if (methode !== 'GET') { ecritures.push(chemin); return {}; }
    return pages[Number(/&page=(\d+)/.exec(chemin)[1]) - 1] ?? [];
  };
  assert.match(await controler({ api, depot: 'MoKarade/.github', evenement: evenement(tache()) }), /déjà signalé/);
  assert.deepEqual(ecritures, []);
});
