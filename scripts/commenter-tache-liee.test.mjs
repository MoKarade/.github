import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEPOTS, TEXTE_LEVE, commenterDepot, corpsDuCommentaire } from './commenter-tache-liee.mjs';
import { MARQUEUR_TACHE } from './tache-liee.mjs';

// Fausse API GitHub en mémoire : PR ouvertes, issues, commentaires ; toutes les écritures sont gardées.
const humain = { login: 'MoKarade', type: 'User' };
const tache = { number: 120, state: 'open', labels: [{ name: 'niveau:tâche' }] };
function faux({ pulls, issues = {}, commentaires = {}, echec = {} }) {
  const ecritures = [];
  const api = async (methode, chemin, corps) => {
    if (methode !== 'GET') { ecritures.push({ methode, chemin, corps }); return { id: 1 }; }
    const [base] = chemin.split('?');
    let m;
    if (/\/pulls$/.test(base)) return pulls;
    if ((m = /\/issues\/(\d+)\/comments$/.exec(base))) { if (echec[m[1]]) throw new Error('HTTP 502'); return commentaires[m[1]] ?? []; }
    if ((m = /\/repos\/MoKarade\/([^/]+)\/issues\/(\d+)$/.exec(base))) return issues[`${m[1]}#${m[2]}`] ?? null;
    throw new Error(`appel inattendu ${chemin}`);
  };
  return { api, ecritures };
}
const pr = (number, body, extra = {}) => ({ number, body, user: humain, head: { ref: 'claude/x' }, draft: false, ...extra });

test('les dix dépôts, dont .github', () => {
  assert.equal(DEPOTS.length, 10);
  assert.ok(DEPOTS.includes('.github'));
});

test('corpsDuCommentaire : rien pour une PR en règle sans commentaire, « levé » si elle en avait un', () => {
  assert.equal(corpsDuCommentaire({ ok: true, citees: [], motifs: [] }, null), null);
  assert.equal(corpsDuCommentaire({ ok: true, citees: [], motifs: [] }, { id: 1 }), `${MARQUEUR_TACHE}\n${TEXTE_LEVE}`);
  assert.match(corpsDuCommentaire({ ok: false, citees: [], motifs: ['aucune ligne'] }, null), /rouge[\s\S]*Re-run jobs/);
});

test('une PR sans tâche reçoit un commentaire, une PR en règle aucun', async () => {
  const { api, ecritures } = faux({ pulls: [pr(1, 'sans lien'), pr(2, 'Tâche : #120')], issues: { 'Hubperso#120': tache } });
  const r = await commenterDepot({ api, depot: 'Hubperso' });
  assert.deepEqual(r.actions, ['Hubperso#1 : posé']);
  assert.equal(ecritures.length, 1);
  assert.equal(ecritures[0].methode, 'POST');
  assert.match(ecritures[0].chemin, /issues\/1\/comments$/);
  assert.ok(ecritures[0].corps.body.startsWith(MARQUEUR_TACHE));
});

test('le commentaire existant est mis à jour, une seule fois, puis levé quand la PR est corrigée', async () => {
  const rouge = corpsDuCommentaire({ ok: false, citees: [], motifs: ['aucune ligne `Tâche : #n` dans le corps de la PR'] }, null);
  const dejaPose = faux({ pulls: [pr(1, 'sans lien')], commentaires: { 1: [{ id: 9, body: rouge }] } });
  assert.deepEqual((await commenterDepot({ api: dejaPose.api, depot: 'CarAI' })).actions, []);
  assert.equal(dejaPose.ecritures.length, 0);
  const corrigee = faux({ pulls: [pr(1, 'Tâche : #120')], issues: { 'CarAI#120': tache }, commentaires: { 1: [{ id: 9, body: rouge }] } });
  const r = await commenterDepot({ api: corrigee.api, depot: 'CarAI' });
  assert.deepEqual(r.actions, ['CarAI#1 : levé']);
  assert.equal(corrigee.ecritures[0].methode, 'PATCH');
  assert.match(corrigee.ecritures[0].chemin, /issues\/comments\/9$/);
  assert.equal(corrigee.ecritures[0].corps.body, `${MARQUEUR_TACHE}\n${TEXTE_LEVE}`);
  const levee = faux({ pulls: [pr(1, 'Tâche : #120')], issues: { 'CarAI#120': tache }, commentaires: { 1: [{ id: 9, body: `${MARQUEUR_TACHE}\n${TEXTE_LEVE}` }] } });
  assert.deepEqual((await commenterDepot({ api: levee.api, depot: 'CarAI' })).actions, []);
  assert.equal(levee.ecritures.length, 0);
});

test('les robots et la boîte du Réacteur n’ont jamais de commentaire', async () => {
  const { api, ecritures } = faux({
    pulls: [
      pr(1, '', { user: { login: 'dependabot[bot]', type: 'Bot' } }),
      pr(2, '', { head: { ref: 'claude/boite-reacteur' }, draft: true }),
    ],
  });
  const r = await commenterDepot({ api, depot: 'app-template' });
  assert.deepEqual(r, { actions: [], erreurs: [] });
  assert.equal(ecritures.length, 0);
});

test('Jules n’est pas dispensé : sa PR sans tâche est commentée', async () => {
  const { api } = faux({ pulls: [pr(3, 'sans lien', { user: { login: 'google-labs-jules[bot]', type: 'Bot' } })] });
  assert.deepEqual((await commenterDepot({ api, depot: 'JobAI' })).actions, ['JobAI#3 : posé']);
});

test('une erreur sur une PR est notée et n’arrête pas les autres', async () => {
  const { api, ecritures } = faux({ pulls: [pr(1, 'sans lien'), pr(2, 'sans lien')], echec: { 1: true } });
  const r = await commenterDepot({ api, depot: 'MemoryAI' });
  assert.deepEqual(r.actions, ['MemoryAI#2 : posé']);
  assert.match(r.erreurs[0], /MemoryAI#1.*502/);
  assert.equal(ecritures.length, 1);
});
