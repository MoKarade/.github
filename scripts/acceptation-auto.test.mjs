import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ECRAN, MARQUEUR_AUTO, accepterApresFusion, ecran, evaluerEligibilite, veutAuto } from './acceptation-auto.mjs';
import { ENTETE_ABANDON, evaluer, trouverPreuve } from './preuve.mjs';

const DEPOT = 'MoKarade/JobAI';
const SHA = 'ea239e9a1b2c3d4e5f60718293a4b5c6d7e8f901';
const TETE = 'bbbbbbbb1b2c3d4e5f60718293a4b5c6d7e8f901';
const FUSION = '2026-10-21T14:00:00Z';
const AUTO = '**Acceptation automatique** : oui — le « Fini quand » est un contrôle CI.';

/** Une fausse API GitHub avec état : fermer l'issue la ferme pour de bon, un commentaire s'ajoute à la liste. */
function faux({ corps = `Tâche : #115`, issueBody = `**Avant** : x\n${AUTO}\n**Attend** : aucune`, labels = ['niveau:tâche', 'en-cours'], fichiers = ['docs/cycle-de-vie-tache.md'], controles = [{ name: 'Gate', status: 'completed', conclusion: 'success' }], ouvertes = [], deploiements = [], merged = true } = {}) {
  const etat = { issue: { number: 115, state: 'open', state_reason: null, body: issueBody, labels: labels.map((name) => ({ name })) }, commentaires: [], ecritures: [] };
  const api = async (methode, chemin, body) => {
    const ligne = `${methode} ${chemin.split('?')[0]}`;
    if (methode !== 'GET') etat.ecritures.push(ligne);
    if (ligne === `GET /repos/${DEPOT}/pulls/7`) return { number: 7, merged, merged_at: FUSION, merge_commit_sha: SHA, head: { sha: TETE }, body: corps, user: { login: 'MoKarade', type: 'User' } };
    if (ligne === `GET /repos/${DEPOT}/issues/115`) return etat.issue;
    if (ligne === `GET /repos/${DEPOT}/pulls/7/files`) return fichiers.map((filename) => ({ filename }));
    if (ligne === `GET /repos/${DEPOT}/commits/${TETE}/check-runs`) return { check_runs: controles };
    if (ligne === `GET /repos/${DEPOT}/pulls`) return ouvertes;
    if (ligne === `GET /repos/${DEPOT}/deployments`) return deploiements.map((d) => d.dep);
    if (/\/deployments\/\d+\/statuses$/.test(ligne)) return [{ state: 'success' }];
    if (/\/compare\//.test(ligne)) return { status: 'identical' };
    if (ligne === `GET /repos/${DEPOT}/issues/115/comments`) return etat.commentaires;
    if (ligne === `POST /repos/${DEPOT}/issues/115/comments`) {
      etat.commentaires.push({ body: body.body, user: { login: 'github-actions[bot]', type: 'Bot' }, created_at: '2026-10-21T14:01:00Z' });
      return {};
    }
    if (ligne === `PATCH /repos/${DEPOT}/issues/115`) {
      Object.assign(etat.issue, body);
      return etat.issue;
    }
    if (methode === 'DELETE') {
      const nom = decodeURIComponent(chemin.split('/labels/')[1]);
      etat.issue.labels = etat.issue.labels.filter((l) => l.name !== nom);
      return null;
    }
    if (ligne === `POST /repos/${DEPOT}/issues/7/comments`) return {};
    return null;
  };
  return { api, etat };
}
const dormir = async () => {};
const lancer = (f, config = { deploiement: 'aucun' }) => accepterApresFusion({ api: f.api, depot: DEPOT, numeroPr: 7, config, maintenant: () => new Date('2026-10-21T14:01:00Z'), dormir, essais: 2, pause: 0 });

test('docs seules, tâche qui le demande : acceptée, fermée, étiquettes retirées, signal sur la PR', async () => {
  const f = faux();
  const r = await lancer(f);
  assert.equal(r.statut, 'acceptee');
  assert.equal(r.tache, 115);
  assert.equal(f.etat.issue.state, 'closed');
  assert.equal(f.etat.issue.state_reason, 'completed');
  assert.deepEqual(f.etat.issue.labels.map((l) => l.name), ['niveau:tâche']);
  const preuve = f.etat.commentaires[0].body;
  assert.match(preuve, /^\*\*Acceptée\*\* — PR #7 fusionnée \(ea239e9\), sans déploiement : ce dépôt ne se déploie pas, preuve : contrôles réussis sur la tête bbbbbbb de la PR \(1\), aucun rouge ; 1 fichiers touchés, aucun écran/);
  assert.ok(preuve.includes(MARQUEUR_AUTO));
  assert.match(preuve, /la production n’a pas été lue par une personne/);
  assert.ok(f.etat.ecritures.includes(`POST /repos/${DEPOT}/issues/7/comments`));
  // le garde-fou de preuve reconnaît ce commentaire, et lui seul : sans le marqueur, un robot ne prouve rien
  assert.ok(trouverPreuve(f.etat.commentaires));
  assert.equal(trouverPreuve([{ ...f.etat.commentaires[0], body: preuve.replace(MARQUEUR_AUTO, '') }]), null);
});

test('rien ne s’écrit quand la tâche ne demande pas l’acceptation automatique', async () => {
  const f = faux({ issueBody: '**Avant** : x\n**Attend** : aucune' });
  const r = await lancer(f);
  assert.equal(r.statut, 'ignoree');
  assert.deepEqual(f.etat.ecritures, []);
});

test('un écran touché, un contrôle rouge, une attente ou une autre PR qui cite la tâche : refusé, rien n’est écrit', async () => {
  const cas = [
    [{ fichiers: ['docs/a.md', 'app/page.tsx'] }, /écran/],
    [{ fichiers: ['public/logo.png'] }, /écran/],
    [{ controles: [{ name: 'Gate', status: 'completed', conclusion: 'failure' }] }, /rouge/],
    [{ labels: ['niveau:tâche', 'en-cours', 'qui:marc'] }, /attend quelque chose/],
    [{ labels: ['niveau:tâche', 'preuve-attendue'] }, /attend quelque chose/],
    [{ ouvertes: [{ number: 9, body: 'Tâche : #115' }] }, /autre PR ouverte/],
    [{ corps: 'Tâche : #115 et #116' }, /exactement une tâche/],
    [{ corps: 'Aucune tâche' }, /exactement une tâche/],
    [{ merged: false }, /pas fusionnée/],
  ];
  for (const [options, motif] of cas) {
    const f = faux(options);
    const r = await lancer(f);
    assert.equal(r.statut, 'ignoree', JSON.stringify(options));
    assert.match(r.motifs.join(' '), motif, JSON.stringify(options));
    assert.deepEqual(f.etat.ecritures, [], JSON.stringify(options));
    assert.equal(f.etat.issue.state, 'open');
  }
});

test('code servi : sans déploiement READY dans le délai la tâche reste ouverte ; avec, elle est acceptée et le déploiement est cité', async () => {
  const servi = faux({ fichiers: ['lib/calcul.ts'] });
  const r = await lancer(servi, { deploiement: 'vercel' });
  assert.equal(r.statut, 'ignoree');
  assert.match(r.motifs[0], /aucun déploiement de production réussi/);
  assert.deepEqual(servi.etat.ecritures, []);

  const ok = faux({ fichiers: ['lib/calcul.ts'], deploiements: [{ dep: { id: 42, sha: SHA, created_at: '2026-10-21T14:00:40Z' } }] });
  const r2 = await lancer(ok, { deploiement: 'vercel' });
  assert.equal(r2.statut, 'acceptee');
  assert.match(ok.etat.commentaires[0].body, /déploiement READY \(déploiement 42 sur ea239e9\)/);
});

test('le commentaire posé passe toujours le garde-fou de preuve (jamais de réouverture après coup)', async () => {
  const f = faux();
  await lancer(f);
  const pr = { merged: true, merged_at: FUSION, merge_commit_sha: SHA, head_sha: TETE };
  const v = evaluer({ raison: 'completed', commentaires: f.etat.commentaires, pr, fichiers: ['docs/x.md'], deploiement: { requis: false, ok: null, detail: '' } });
  assert.deepEqual(v.motifs, []);
});

test('le marqueur ne vaut que pour « Acceptée », que pour github-actions[bot], et jamais pour un abandon', () => {
  const corps = `**Acceptée** — PR #7 fusionnée (ea239e9), preuve : ${'x'.repeat(50)}\n${MARQUEUR_AUTO}`;
  const bot = (login) => ({ body: corps, user: { login, type: 'Bot' }, created_at: '2026-10-21T14:01:00Z' });
  assert.ok(trouverPreuve([bot('github-actions[bot]')]));
  assert.equal(trouverPreuve([bot('dependabot[bot]')]), null);
  assert.equal(trouverPreuve([bot('google-labs-jules[bot]')]), null);
  const abandon = { body: `**Abandonnée** — ${'x'.repeat(30)}\n${MARQUEUR_AUTO}`, user: { login: 'github-actions[bot]', type: 'Bot' }, created_at: '2026-10-21T14:01:00Z' };
  assert.equal(trouverPreuve([abandon], ENTETE_ABANDON), null);
});

test('écran : composants, styles, images, HTML, public/ ; une route d’API ou un contrat n’en est pas un', () => {
  for (const f of ['app/page.tsx', 'a/b.jsx', 'styles/x.css', 'index.html', 'img/a.svg', 'public/robots.txt', 'x/public/a.js']) assert.ok(ecran([f]), f);
  for (const f of ['app/api/hub/summary/route.ts', 'lib/calcul.ts', 'docs/a.md', 'scripts/a.mjs', 'tests/a.test.ts', '.github/workflows/a.yml']) assert.equal(ecran([f]), false, f);
  assert.ok(ECRAN instanceof RegExp);
});

test('la ligne « Acceptation automatique » se reconnaît en gras, en liste ou nue, et seulement avec « oui »', () => {
  for (const body of ['**Acceptation automatique** : oui — CI', 'x\nAcceptation automatique : oui', '- **Acceptation automatique**: oui']) assert.ok(veutAuto({ body }), body);
  for (const body of ['**Acceptation automatique** : non', 'je veux une acceptation automatique oui', '']) assert.equal(veutAuto({ body }), false, body);
});

test('éligibilité : une tâche fermée ou sans l’étiquette niveau:tâche n’est pas acceptée', () => {
  const base = { numeroTache: 1, pr: { merged: true }, fichiers: ['docs/a.md'], controles: [], autresPr: [], depot: DEPOT };
  const issue = (o) => ({ number: 1, state: 'open', body: AUTO, labels: [{ name: 'niveau:tâche' }], ...o });
  assert.equal(evaluerEligibilite({ ...base, issue: issue() }).ok, true);
  assert.match(evaluerEligibilite({ ...base, issue: issue({ state: 'closed' }) }).motifs[0], /fermée/);
  assert.match(evaluerEligibilite({ ...base, issue: issue({ labels: [] }) }).motifs[0], /niveau:tâche/);
  assert.equal(evaluerEligibilite({ ...base, issue: issue(), fichiers: [] }).ok, false);
});
