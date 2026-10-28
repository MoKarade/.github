import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MARQUEUR_AUTO, trouverPreuve } from './preuve.mjs';
import { accepterPreuvesAttendues, corpsAcceptee, evaluerCandidate, lireEcheance, quebecVersUtc } from './preuve-attendue-auto.mjs';

const DEPOT = 'MoKarade/JobAI';
const SHA = 'ea239e9a1b2c3d4e5f60718293a4b5c6d7e8f901';
const FUSION = '2026-10-21T14:00:00Z';
const MAINTENANT = new Date('2026-10-31T17:00:00Z');
const CONTROLE = '**Contrôle** : http https://emploi.hubperso.com/api/sante statut 200 contient "ok"';
const corpsTache = (extra = '') => `**Avant** : x\n\n**Fini quand** : la santé répond.\n\n**Preuve attendue** : 2026-10-31 12:00 (heure du Québec) — cron\n${CONTROLE}\n${extra}`;

/** Une fausse API GitHub avec état : fermer l'issue la ferme pour de bon, un commentaire s'ajoute à la liste. */
function faux({ body = corpsTache(), labels = ['niveau:tâche', 'preuve-attendue'], comments = [], fichiers = ['docs/a.md'], ouvertes = [], timeline = [{ event: 'cross-referenced', source: { issue: { number: 7, pull_request: {}, repository: { full_name: DEPOT } } } }], prCorps = 'Tâche : #115', merged = true } = {}) {
  const etat = { issue: { number: 115, state: 'open', state_reason: null, body, labels: labels.map((name) => ({ name })), comments: comments.length }, commentaires: [...comments], ecritures: [] };
  const api = async (methode, chemin, corps) => {
    const ligne = `${methode} ${chemin.split('?')[0]}`;
    if (methode !== 'GET') etat.ecritures.push(ligne);
    if (ligne === `GET /repos/${DEPOT}/issues` ) return [etat.issue];
    if (ligne === `GET /repos/${DEPOT}/issues/115`) return etat.issue;
    if (ligne === `GET /repos/${DEPOT}/issues/115/comments`) return etat.commentaires;
    if (ligne === `GET /repos/${DEPOT}/issues/115/timeline`) return timeline;
    if (ligne === `GET /repos/${DEPOT}/pulls/7`) return { number: 7, merged, merged_at: FUSION, merge_commit_sha: SHA, head: { sha: 'bbbbbbbb1b2c3d4e5f60718293a4b5c6d7e8f901' }, body: prCorps };
    if (ligne === `GET /repos/${DEPOT}/pulls/7/files`) return fichiers.map((filename) => ({ filename }));
    if (ligne === `GET /repos/${DEPOT}/pulls`) return ouvertes;
    if (ligne === `GET /repos/${DEPOT}/deployments`) return [];
    if (ligne === `POST /repos/${DEPOT}/issues/115/comments`) {
      etat.commentaires.push({ body: corps.body, user: { login: 'github-actions[bot]', type: 'Bot' }, created_at: MAINTENANT.toISOString() });
      return {};
    }
    if (ligne === `PATCH /repos/${DEPOT}/issues/115`) {
      Object.assign(etat.issue, corps);
      return etat.issue;
    }
    if (methode === 'DELETE') {
      const nom = decodeURIComponent(chemin.split('/labels/')[1]);
      etat.issue.labels = etat.issue.labels.filter((l) => l.name !== nom);
      return null;
    }
    return null;
  };
  return { api, etat };
}
const bon = async (c) => ({ ok: true, observe: `GET ${c.url} → HTTP 200, contient « ok »` });
const mauvais = async (c) => ({ ok: false, observe: `GET ${c.url} → HTTP 503` });
const lancer = (f, options = {}) => accepterPreuvesAttendues({ api: f.api, depot: DEPOT, maintenant: MAINTENANT, config: { deploiement: 'aucun' }, executer: bon, ...options });

test('l’heure du Québec devient de l’UTC, été comme hiver', () => {
  assert.equal(quebecVersUtc(2026, 10, 31, 12, 0).toISOString(), '2026-10-31T16:00:00.000Z'); // EDT, −4 h
  assert.equal(quebecVersUtc(2026, 7, 1, 12, 0).toISOString(), '2026-07-01T16:00:00.000Z');
  assert.equal(quebecVersUtc(2026, 12, 15, 12, 0).toISOString(), '2026-12-15T17:00:00.000Z'); // EST, −5 h
  assert.equal(quebecVersUtc(2026, 11, 1, 12, 0).toISOString(), '2026-11-01T17:00:00.000Z'); // le changement d'heure a eu lieu à 2 h
});

test('lireEcheance : la dernière ligne gagne, une ligne sans heure du Québec ou sans heure ne vaut rien', () => {
  const corps = '**Preuve attendue** : 2026-10-26 12:00 (heure du Québec) — cron';
  const report = '**Preuve attendue** : 2026-10-31 12:00 (heure du Québec) — cron';
  assert.equal(lireEcheance([corps, 'rien', report]).date.toISOString(), '2026-10-31T16:00:00.000Z');
  assert.equal(lireEcheance([corps]).date.toISOString(), '2026-10-26T16:00:00.000Z');
  assert.equal(lireEcheance([corps, '**Preuve attendue** : à la pose de la clé — événement, pas une heure']).date, null);
  assert.equal(lireEcheance(['**Preuve attendue** : 2026-10-31 12:00 — cron']).date, null);
  assert.equal(lireEcheance(['**Preuve attendue** : 2026-13-45 99:99 (heure du Québec)']).date, null);
  assert.equal(lireEcheance(['Avant : x']).date, null);
});

test('évaluerCandidate : échéance passée, contrôle http ou actions, aucune attente', () => {
  const issue = { state: 'open', labels: [{ name: 'niveau:tâche' }, { name: 'preuve-attendue' }] };
  assert.equal(evaluerCandidate({ issue, textes: [corpsTache()], maintenant: MAINTENANT }).ok, true);
  const futur = evaluerCandidate({ issue, textes: [corpsTache()], maintenant: new Date('2026-10-31T15:59:00Z') });
  assert.match(futur.motifs.join(' '), /n’est pas passée/);
  const nav = '**Contrôle** : navigateur https://hubperso.com/ texte "Bonjour"';
  assert.match(evaluerCandidate({ issue, textes: [corpsTache(nav)], maintenant: MAINTENANT }).motifs.join(' '), /navigateur.*fil/);
  assert.match(evaluerCandidate({ issue, textes: [corpsTache('**Contrôle** : http http://emploi.hubperso.com/ statut 200')], maintenant: MAINTENANT }).motifs.join(' '), /illisible/);
  assert.match(evaluerCandidate({ issue, textes: ['**Preuve attendue** : 2026-10-31 12:00 (heure du Québec)'], maintenant: MAINTENANT }).motifs.join(' '), /aucune ligne \*\*Contrôle/);
  for (const attente of ['qui:marc', 'bloqué', 'preuve-manquante', 'essai']) {
    const v = evaluerCandidate({ issue: { ...issue, labels: [...issue.labels, { name: attente }] }, textes: [corpsTache()], maintenant: MAINTENANT });
    assert.match(v.motifs.join(' '), /attend quelque chose/, attente);
  }
  assert.match(evaluerCandidate({ issue: { ...issue, labels: [{ name: 'preuve-attendue' }] }, textes: [corpsTache()], maintenant: MAINTENANT }).motifs.join(' '), /niveau:tâche/);
});

test('échéance passée, contrôle http réussi, PR fusionnée : acceptée, un seul commentaire, une seule fermeture, étiquettes retirées', async () => {
  const f = faux();
  const r = await lancer(f);
  assert.deepEqual(r.acceptees, [115]);
  assert.equal(f.etat.issue.state, 'closed');
  assert.equal(f.etat.issue.state_reason, 'completed');
  assert.deepEqual(f.etat.issue.labels.map((l) => l.name), ['niveau:tâche']);
  assert.equal(f.etat.ecritures.filter((e) => e === `POST /repos/${DEPOT}/issues/115/comments`).length, 1);
  assert.equal(f.etat.ecritures.filter((e) => e === `PATCH /repos/${DEPOT}/issues/115`).length, 1);
  const preuve = f.etat.commentaires[0].body;
  assert.match(preuve, /^\*\*Acceptée\*\* — PR #7 fusionnée \(ea239e9\), sans déploiement : ce dépôt ne se déploie pas, preuve : contrôle automatique à la date prévue/);
  assert.match(preuve, /GET https:\/\/emploi\.hubperso\.com\/api\/sante → HTTP 200, contient « ok »/);
  assert.ok(preuve.includes(MARQUEUR_AUTO));
  assert.ok(trouverPreuve(f.etat.commentaires));
});

test('rien ne s’écrit : échéance non passée, contrôle en échec, navigateur, qui:marc, aucune PR fusionnée, PR encore ouverte', async () => {
  const cas = [
    [{}, { maintenant: new Date('2026-10-31T15:00:00Z') }, /n’est pas passée/],
    [{}, { executer: mauvais }, /contrôle n’a pas lu/],
    [{ body: corpsTache('**Contrôle** : navigateur https://hubperso.com/ texte "x"') }, {}, /fil/],
    [{ labels: ['niveau:tâche', 'preuve-attendue', 'qui:marc'] }, {}, /attend quelque chose/],
    [{ timeline: [] }, {}, /aucune PR fusionnée/],
    [{ merged: false }, {}, /aucune PR fusionnée/],
    [{ prCorps: 'Tâche : #116' }, {}, /aucune PR fusionnée/],
    [{ ouvertes: [{ number: 9, body: 'Tâche : #115' }] }, {}, /PR ouverte/],
  ];
  for (const [options, reglages, motif] of cas) {
    const f = faux(options);
    const r = await lancer(f, reglages);
    assert.deepEqual(r.acceptees, [], JSON.stringify(options));
    assert.match(r.ignorees.map((i) => i.motifs.join(' ')).join(' '), motif, JSON.stringify(options));
    assert.deepEqual(f.etat.ecritures, [], JSON.stringify(options));
    assert.equal(f.etat.issue.state, 'open');
  }
});

test('la ligne « Contrôle » et la reprogrammation se lisent dans les commentaires du propriétaire, jamais ceux d’un tiers', async () => {
  const sansControle = '**Avant** : x\n**Preuve attendue** : 2026-10-26 12:00 (heure du Québec) — cron';
  const proprio = { body: `${CONTROLE}\n**Preuve attendue** : 2026-10-31 12:00 (heure du Québec) — reprogrammée`, author_association: 'OWNER', user: { login: 'MoKarade', type: 'User' } };
  const accepte = faux({ body: sansControle, comments: [proprio] });
  assert.deepEqual((await lancer(accepte)).acceptees, [115]);
  const tiers = faux({ body: sansControle, comments: [{ ...proprio, author_association: 'NONE' }] });
  const r = await lancer(tiers);
  assert.deepEqual(r.acceptees, []);
  assert.deepEqual(tiers.etat.ecritures, []);
  // la reprogrammation en commentaire repousse l'échéance du corps, même passée
  const repousse = faux({ comments: [{ ...proprio, body: '**Preuve attendue** : 2026-11-05 12:00 (heure du Québec) — reportée' }] });
  assert.match((await lancer(repousse)).ignorees[0].motifs.join(' '), /n’est pas passée/);
});

test('code servi : sans déploiement READY la tâche reste ouverte ; une acceptation déjà posée n’est pas doublée', async () => {
  const servi = faux({ fichiers: ['lib/calcul.ts'] });
  const r = await accepterPreuvesAttendues({ api: servi.api, depot: DEPOT, maintenant: MAINTENANT, config: { deploiement: 'vercel' }, executer: bon });
  assert.deepEqual(r.acceptees, []);
  assert.match(r.ignorees[0].motifs.join(' '), /aucun déploiement/);
  assert.deepEqual(servi.etat.ecritures, []);
  const deja = faux({ comments: [{ body: `**Acceptée** — x\n${MARQUEUR_AUTO}`, user: { login: 'github-actions[bot]', type: 'Bot' }, author_association: 'NONE' }] });
  assert.match((await lancer(deja)).ignorees[0].motifs.join(' '), /déjà posée/);
});

test('le commentaire posé passe le garde-fou de preuve ; le plafond par passage est respecté ; une erreur d’API ignore la tâche', async () => {
  const corps = corpsAcceptee({ pr: { number: 7, merge_commit_sha: SHA }, deploiement: { ok: null }, servie: false, sansDeploiement: 'docs', resultats: [{ observe: 'GET https://emploi.hubperso.com/api/sante → HTTP 200' }], echeance: new Date('2026-10-31T16:00:00Z'), maintenant: MAINTENANT });
  assert.match(corps, /^\*\*Acceptée\*\* — PR #7 fusionnée \(ea239e9\), sans déploiement : docs, preuve : /);
  const casse = faux();
  const original = casse.api;
  const r = await lancer({ ...casse, api: async (m, c, b) => (c.includes('/timeline') ? Promise.reject(new Error('HTTP 500')) : original(m, c, b)) });
  assert.deepEqual(r.acceptees, []);
  assert.match(r.ignorees[0].motifs.join(' '), /erreur : HTTP 500/);
  const zero = await lancer(faux(), { max: 0 });
  assert.deepEqual(zero.acceptees, []);
});
