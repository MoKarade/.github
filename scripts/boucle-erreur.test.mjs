import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CONCLUSIONS_ECHEC, LABEL, NOM_DU_SIGNALEMENT, choisirAction, corpsDeLEchec, ligneDEchec, nettoyer, signaler, titreDe } from './boucle-erreur.mjs';

const DEPOT = 'MoKarade/Hubperso';
const WORKFLOW = 'Réacteur';
const base = { depot: DEPOT, workflow: WORKFLOW, runId: '4242', runUrl: `https://github.com/${DEPOT}/actions/runs/4242`, sha: 'abcdef0123456789' };

// Fausse API en mémoire : les issues ouvertes de `etat.issues`, les écritures gardées.
function faux({ issues = [], jobs = null, panne = null } = {}) {
  const ecritures = [];
  const etat = { issues: [...issues] };
  const api = async (methode, chemin, corps) => {
    if (panne && methode !== 'GET') throw panne;
    if (methode === 'GET' && chemin.startsWith(`/repos/${DEPOT}/issues?labels=`)) return etat.issues;
    if (methode === 'GET' && chemin.includes('/jobs')) return jobs;
    ecritures.push({ methode, chemin, corps });
    if (methode === 'POST' && chemin === `/repos/${DEPOT}/issues`) return { number: 901 };
    return null;
  };
  return { api, ecritures };
}
const ouverte = { number: 900, title: titreDe({ depot: DEPOT, workflow: WORKFLOW }) };

test('choisirAction : échec sans issue ouverte → ouvrir ; avec → commenter ; succès → fermer ; le reste → rien', () => {
  assert.equal(choisirAction({ workflow: WORKFLOW, conclusion: 'failure', ouverte: null }), 'ouvrir');
  assert.equal(choisirAction({ workflow: WORKFLOW, conclusion: 'timed_out', ouverte: null }), 'ouvrir');
  assert.equal(choisirAction({ workflow: WORKFLOW, conclusion: 'failure', ouverte }), 'commenter');
  assert.equal(choisirAction({ workflow: WORKFLOW, conclusion: 'success', ouverte }), 'fermer');
  assert.equal(choisirAction({ workflow: WORKFLOW, conclusion: 'success', ouverte: null }), 'rien');
  for (const c of ['cancelled', 'skipped', 'neutral', '', undefined]) assert.equal(choisirAction({ workflow: WORKFLOW, conclusion: c, ouverte }), 'rien');
  assert.deepEqual([...CONCLUSIONS_ECHEC].sort(), ['failure', 'timed_out']);
});

test('le signalement ne se signale pas lui-même', async () => {
  assert.equal(choisirAction({ workflow: NOM_DU_SIGNALEMENT, conclusion: 'failure', ouverte: null }), 'rien');
  const { api, ecritures } = faux();
  assert.deepEqual(await signaler({ api, ...base, workflow: NOM_DU_SIGNALEMENT, conclusion: 'failure', journal: () => {} }), { action: 'rien' });
  assert.equal(ecritures.length, 0);
});

test('premier échec : UNE issue boucle:erreur, titre par couple (dépôt, workflow), job et étape en échec', async () => {
  const jobs = { jobs: [{ name: 'Réveiller', conclusion: 'failure', steps: [{ name: 'Checkout', conclusion: 'success' }, { name: 'Lancer le script', conclusion: 'failure' }] }] };
  const { api, ecritures } = faux({ jobs });
  const r = await signaler({ api, ...base, conclusion: 'failure', journal: () => {} });
  assert.deepEqual(r, { action: 'ouvrir', issue: 901 });
  assert.equal(ecritures.length, 1);
  const e = ecritures[0];
  assert.equal(e.chemin, `/repos/${DEPOT}/issues`);
  assert.equal(e.corps.title, 'Échec : Réacteur dans MoKarade/Hubperso');
  assert.deepEqual(e.corps.labels, [LABEL]);
  assert.match(e.corps.body, /actions\/runs\/4242/);
  assert.match(e.corps.body, /job « Réveiller », étape « Lancer le script »/);
  assert.match(e.corps.body, /`abcdef0`/);
});

test('deuxième échec : un commentaire sur l’issue ouverte, jamais un doublon', async () => {
  const { api, ecritures } = faux({ issues: [ouverte] });
  const r = await signaler({ api, ...base, conclusion: 'failure', journal: () => {} });
  assert.deepEqual(r, { action: 'commenter', issue: 900 });
  assert.equal(ecritures.length, 1);
  assert.equal(ecritures[0].methode, 'POST');
  assert.equal(ecritures[0].chemin, `/repos/${DEPOT}/issues/900/comments`);
});

test('une autre issue boucle:erreur (autre workflow) n’est pas touchée par ce workflow', async () => {
  const autre = { number: 800, title: titreDe({ depot: DEPOT, workflow: 'Relecture IA' }) };
  const { api, ecritures } = faux({ issues: [autre] });
  assert.equal((await signaler({ api, ...base, conclusion: 'failure', journal: () => {} })).action, 'ouvrir');
  assert.equal(ecritures[0].chemin, `/repos/${DEPOT}/issues`);
});

test('succès suivant : commentaire puis issue fermée ; sans issue ouverte, rien', async () => {
  const { api, ecritures } = faux({ issues: [ouverte] });
  const r = await signaler({ api, ...base, conclusion: 'success', journal: () => {} });
  assert.deepEqual(r, { action: 'fermer', issue: 900 });
  assert.equal(ecritures.length, 2);
  assert.equal(ecritures[1].methode, 'PATCH');
  assert.deepEqual(ecritures[1].corps, { state: 'closed', state_reason: 'completed' });
  const vide = faux();
  assert.equal((await signaler({ api: vide.api, ...base, conclusion: 'success', journal: () => {} })).action, 'rien');
  assert.equal(vide.ecritures.length, 0);
});

test('échec du signalement : un avertissement, aucune exception, rien d’écrit', async () => {
  const lignes = [];
  const { api } = faux({ panne: new Error('HTTP 403 sur POST /repos/x/issues') });
  const r = await signaler({ api, ...base, conclusion: 'failure', journal: (l) => lignes.push(l) });
  assert.equal(r.action, 'rien');
  assert.ok(lignes.some((l) => l.startsWith('::warning::') && l.includes('HTTP 403')));
});

test('nettoyer : jetons, secrets et retours à la ligne ne sortent jamais dans une issue', () => {
  const jeton = `ghp_${'a'.repeat(36)}`;
  assert.doesNotMatch(nettoyer(`échec avec ${jeton} dans le journal`), /ghp_/);
  assert.doesNotMatch(nettoyer(`github_pat_${'B'.repeat(40)}`), /github_pat_/);
  assert.doesNotMatch(nettoyer('Authorization: Bearer abcdefghijklmnop1234'), /abcdefghijklmnop/);
  assert.doesNotMatch(nettoyer('password=hunter2hunter2'), /hunter2/);
  assert.doesNotMatch(nettoyer(`clé ${'f'.repeat(40)}`), /ffffffff/);
  assert.equal(nettoyer('ligne 1\nligne 2\r\n\tligne 3'), 'ligne 1 ligne 2 ligne 3');
  assert.equal(nettoyer('ab '.repeat(300)).length, 160);
  assert.equal(nettoyer(undefined), '');
});

test('le commit complet (40 caractères hexadécimaux) s’écrit en 7 caractères, jamais « [retiré] »', () => {
  const corps = corpsDeLEchec({ ...base, sha: 'abcdef0123456789abcdef0123456789abcdef01', conclusion: 'failure', ligne: '' });
  assert.match(corps, /- Commit : `abcdef0`/);
  assert.doesNotMatch(corps, /retiré/);
  assert.doesNotMatch(corpsDeLEchec({ ...base, sha: 'pas un sha', conclusion: 'failure', ligne: '' }), /Commit/);
});

test('ligneDEchec et corpsDeLEchec : des noms de job et d’étape, un lien du run, pas de journal', () => {
  assert.equal(ligneDEchec([]), '');
  assert.equal(ligneDEchec([{ name: 'A', conclusion: 'success' }]), '');
  assert.equal(ligneDEchec([{ name: 'A', conclusion: 'failure', steps: [] }]), 'job « A »');
  const jeton = `ghp_${'z'.repeat(36)}`;
  const corps = corpsDeLEchec({ ...base, conclusion: 'failure', ligne: ligneDEchec([{ name: jeton, conclusion: 'failure', steps: [] }]) });
  assert.doesNotMatch(corps, /ghp_/);
  // un lien qui n’est pas celui d’un run GitHub est remplacé par le lien construit
  const mauvais = corpsDeLEchec({ ...base, runUrl: 'https://exemple.test/piege', conclusion: 'failure', ligne: '' });
  assert.match(mauvais, /https:\/\/github\.com\/MoKarade\/Hubperso\/actions\/runs\/4242/);
  assert.doesNotMatch(mauvais, /exemple\.test/);
});

test('le workflow signaler-echec.yml : aucun cron, aucun secret, données du run par env, ne se surveille pas lui-même', () => {
  const y = readFileSync(new URL('../.github/workflows/signaler-echec.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(y, /^\s*schedule:/m);
  assert.doesNotMatch(y, /secrets\./);
  assert.match(y, /workflow_run:/);
  assert.match(y, /workflow_call:/);
  assert.match(y, /BOUCLE_WORKFLOW: \$\{\{ github\.event\.workflow_run\.name \}\}/);
  assert.doesNotMatch(y, /run:[^\n]*\$\{\{ github\.event\./, 'une donnée du run ne s’interpole jamais dans une commande');
  assert.match(y, /issues: write/);
  assert.match(y, /timeout-minutes:/);
  const surveilles = /workflows:\s*\[([^\]]*)\]/.exec(y)?.[1] ?? '';
  assert.ok(!surveilles.includes(NOM_DU_SIGNALEMENT), 'le signalement ne se surveille pas lui-même');
  assert.ok(surveilles.includes('Réacteur'));
});
