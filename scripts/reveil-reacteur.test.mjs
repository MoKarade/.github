import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEPOT_BOITE, LONGUEUR_MAX, PREFIXE, WORKFLOW_BOITE, construireMotif, decider, estPanneRunner, heureQuebec, preuveAPoser, rougeDepuis, traiter } from './reveil-reacteur.mjs';

// Fausse API GitHub en mémoire : les lectures viennent de `donnees`, les écritures sont gardées.
function faux(donnees = {}) {
  const ecritures = [];
  const api = async (methode, chemin, corps, jeton) => {
    if (methode !== 'GET') { ecritures.push({ methode, chemin, corps, jeton }); return null; }
    const [base] = chemin.split('?');
    if (!(base in donnees)) return null;
    const v = donnees[base];
    if (v instanceof Error) throw v;
    return v;
  };
  return { api, ecritures };
}
const humain = { login: 'MoKarade', type: 'User' };
const tache = (extra = {}) => ({ state: 'open', labels: [{ name: 'niveau:tâche' }], ...extra });

test('estPanneRunner : jobs morts sans étape rouge, oui ; une vraie étape rouge, non', () => {
  assert.equal(estPanneRunner([]), false);
  assert.equal(estPanneRunner([{ conclusion: 'success', steps: [] }]), false);
  assert.equal(estPanneRunner([{ conclusion: 'failure', steps: [{ conclusion: 'success' }, { conclusion: 'cancelled' }] }]), true);
  assert.equal(estPanneRunner([{ conclusion: 'timed_out', steps: [{ conclusion: 'failure' }] }]), true);
  assert.equal(estPanneRunner([{ conclusion: 'failure', steps: [{ conclusion: 'failure' }] }]), false);
  // un job réellement rouge parmi d'autres morts : c'est un vrai échec
  assert.equal(
    estPanneRunner([{ conclusion: 'failure', steps: [{ conclusion: 'cancelled' }] }, { conclusion: 'failure', steps: [{ conclusion: 'failure' }] }]),
    false,
  );
});

test('construireMotif : préfixe et plafond de 600 caractères', () => {
  assert.equal(construireMotif(['A libre', '', 'B']), `${PREFIXE}A libre ; B`);
  assert.equal(construireMotif(['x'.repeat(2000)]).length, LONGUEUR_MAX);
});

test('preuveAPoser : ouverte, niveau tâche, ni preuve-attendue ni « Acceptée »', () => {
  assert.equal(preuveAPoser({ issue: tache(), commentaires: [] }), true);
  assert.equal(preuveAPoser({ issue: null, commentaires: [] }), false);
  assert.equal(preuveAPoser({ issue: tache({ state: 'closed' }), commentaires: [] }), false);
  assert.equal(preuveAPoser({ issue: tache({ labels: [{ name: 'niveau:tâche' }, { name: 'preuve-attendue' }] }), commentaires: [] }), false);
  assert.equal(preuveAPoser({ issue: tache({ labels: [{ name: 'niveau:mission' }] }), commentaires: [] }), false);
  assert.equal(preuveAPoser({ issue: tache(), commentaires: [{ user: humain, body: '**Acceptée** — PR #1' }] }), false);
  // un robot qui écrit « Acceptée » ne compte pas
  assert.equal(preuveAPoser({ issue: tache(), commentaires: [{ user: { login: 'x[bot]', type: 'Bot' }, body: '**Acceptée**' }] }), true);
});

test('tâche fermée : « D libre », jamais de tâche suivante ; abandon signalé', async () => {
  const { api } = faux();
  const a = await decider({ api, evt: { type: 'tache_fermee', depot: 'MoKarade/JobAI', issue: '90', raison: 'completed' } });
  assert.deepEqual(a, { action: 'reveiller', motif: 'RÉACTEUR : MoKarade/JobAI libre ; tâche MoKarade/JobAI#90 fermée' });
  const b = await decider({ api, evt: { type: 'tache_fermee', depot: 'MoKarade/JobAI', issue: '90', raison: 'not_planned' } });
  assert.match(b.motif, /abandonnée/);
});

test('PR fusionnée : « D libre » et preuve à poser sur la tâche citée', async () => {
  const { api } = faux({
    '/repos/MoKarade/JobAI/pulls/7': { body: 'Avant…\nTâche : #115', user: humain },
    '/repos/MoKarade/JobAI/issues/115': tache(),
    '/repos/MoKarade/JobAI/issues/115/comments': [],
  });
  const d = await decider({ api, evt: { type: 'pr_fusionnee', depot: 'MoKarade/JobAI', pr: '7' } });
  assert.equal(d.motif, 'RÉACTEUR : MoKarade/JobAI libre ; PR #7 fusionnée ; preuve à poser sur MoKarade/JobAI#115');
});

test('PR fusionnée : tâche déjà en preuve-attendue ou sans tâche (humain) : libre sans preuve à poser', async () => {
  const { api } = faux({
    '/repos/MoKarade/JobAI/pulls/7': { body: 'Tâche : #90', user: humain },
    '/repos/MoKarade/JobAI/issues/90': tache({ labels: [{ name: 'niveau:tâche' }, { name: 'preuve-attendue' }] }),
    '/repos/MoKarade/JobAI/pulls/8': { body: 'rien', user: humain },
  });
  assert.equal((await decider({ api, evt: { type: 'pr_fusionnee', depot: 'MoKarade/JobAI', pr: '7' } })).motif, 'RÉACTEUR : MoKarade/JobAI libre ; PR #7 fusionnée');
  assert.equal((await decider({ api, evt: { type: 'pr_fusionnee', depot: 'MoKarade/JobAI', pr: '8' } })).action, 'reveiller');
});

test('PR fusionnée : une PR de robot sans tâche ne réveille personne', async () => {
  const { api } = faux({ '/repos/MoKarade/JobAI/pulls/9': { body: 'Bump x', user: { login: 'dependabot[bot]', type: 'Bot' } } });
  const d = await decider({ api, evt: { type: 'pr_fusionnee', depot: 'MoKarade/JobAI', pr: '9' } });
  assert.equal(d.action, 'rien');
});

test('PR fusionnée : tâche d’un autre dépôt illisible : le réveil part quand même', async () => {
  const { api } = faux({
    '/repos/MoKarade/CarAI/pulls/3': { body: 'Tâche : MoKarade/.github#139', user: humain },
    '/repos/MoKarade/.github/issues/139': new Error('HTTP 403'),
  });
  const d = await decider({ api, evt: { type: 'pr_fusionnee', depot: 'MoKarade/CarAI', pr: '3' } });
  assert.equal(d.motif, 'RÉACTEUR : MoKarade/CarAI libre ; PR #3 fusionnée');
});

const roug = { type: 'ci_rouge', depot: 'MoKarade/DriveAI', evenement: 'pull_request', pr: '12', sha: 'abcdef1234567', run: '555', brancheDefaut: 'main' };

test('CI rouge sur PR : fermée, brouillon ou commit plus récent : rien', async () => {
  const run = { '/repos/MoKarade/DriveAI/actions/runs/555': { run_attempt: 2 } };
  const pr = (extra) => faux({ ...run, '/repos/MoKarade/DriveAI/pulls/12': { state: 'open', draft: false, head: { sha: 'abcdef1234567' }, ...extra } });
  assert.equal((await decider({ api: pr({ state: 'closed' }).api, evt: roug })).action, 'rien');
  assert.equal((await decider({ api: pr({ draft: true }).api, evt: roug })).action, 'rien');
  assert.equal((await decider({ api: pr({ head: { sha: 'autre' } }).api, evt: roug })).action, 'rien');
  assert.equal((await decider({ api: faux(run).api, evt: roug })).action, 'rien'); // PR introuvable
});

test('CI rouge sur PR : vraie panne = réveil avec numéro, empreinte courte et run', async () => {
  const { api } = faux({
    '/repos/MoKarade/DriveAI/pulls/12': { state: 'open', draft: false, head: { sha: 'abcdef1234567' } },
    '/repos/MoKarade/DriveAI/actions/runs/555': { run_attempt: 1 },
    '/repos/MoKarade/DriveAI/actions/runs/555/jobs': { jobs: [{ conclusion: 'failure', steps: [{ conclusion: 'failure' }] }] },
  });
  const d = await decider({ api, evt: roug });
  assert.equal(d.motif, 'RÉACTEUR : PR rouge MoKarade/DriveAI#12, sha abcdef1 ; run 555');
});

test('CI rouge : échec de charge du robot au premier essai = relance, pas de réveil ; au second essai = réveil', async () => {
  const pr = { '/repos/MoKarade/DriveAI/pulls/12': { state: 'open', draft: false, head: { sha: 'abcdef1234567' } } };
  const jobs = { '/repos/MoKarade/DriveAI/actions/runs/555/jobs': { jobs: [{ conclusion: 'failure', steps: [{ conclusion: 'cancelled' }] }] } };
  const premier = faux({ ...pr, ...jobs, '/repos/MoKarade/DriveAI/actions/runs/555': { run_attempt: 1 } });
  assert.deepEqual(await decider({ api: premier.api, evt: roug }), { action: 'relance', run: '555' });
  const second = faux({ ...pr, ...jobs, '/repos/MoKarade/DriveAI/actions/runs/555': { run_attempt: 2 } });
  assert.equal((await decider({ api: second.api, evt: roug })).action, 'reveiller');
});

test('CI rouge sur push : seule la branche par défaut compte ; planifié : toujours', async () => {
  const run = { '/repos/MoKarade/DriveAI/actions/runs/9': { run_attempt: 2 } };
  const base = { type: 'ci_rouge', depot: 'MoKarade/DriveAI', run: '9', sha: 's', brancheDefaut: 'main' };
  const { api } = faux(run);
  assert.equal((await decider({ api, evt: { ...base, evenement: 'push', brancheRun: 'claude/x' } })).action, 'rien');
  assert.equal((await decider({ api, evt: { ...base, evenement: 'push', brancheRun: 'main' } })).motif, 'RÉACTEUR : branche par défaut rouge sur MoKarade/DriveAI ; run 9');
  assert.equal((await decider({ api, evt: { ...base, evenement: 'schedule' } })).motif, 'RÉACTEUR : contrôle planifié rouge sur MoKarade/DriveAI ; run 9');
});

test('traiter : le réveil lance boite-reacteur.yml d’app-template avec le jeton de réveil, sur main', async () => {
  const { api, ecritures } = faux();
  const lignes = [];
  const r = await traiter({ api, evt: { type: 'tache_fermee', depot: 'MoKarade/CarAI', issue: '1', raison: 'completed' }, jetonReveil: 'jeton', journal: (l) => lignes.push(l) });
  assert.equal(r.reveille, true);
  assert.deepEqual(ecritures, [{
    methode: 'POST',
    chemin: `/repos/${DEPOT_BOITE}/actions/workflows/${WORKFLOW_BOITE}/dispatches`,
    corps: { ref: 'main', inputs: { texte: 'RÉACTEUR : MoKarade/CarAI libre ; tâche MoKarade/CarAI#1 fermée' } },
    jeton: 'jeton',
  }]);
});

test('traiter : sans jeton, aucun appel d’écriture et un avertissement qui le dit', async () => {
  const { api, ecritures } = faux();
  const lignes = [];
  const r = await traiter({ api, evt: { type: 'tache_fermee', depot: 'MoKarade/CarAI', issue: '1', raison: 'completed' }, jetonReveil: '', journal: (l) => lignes.push(l) });
  assert.equal(r.reveille, false);
  assert.equal(ecritures.length, 0);
  assert.match(lignes[0], /^::warning::.*REVEIL_TOKEN/);
});

test('traiter : une panne du robot de tests relance les jobs en échec une seule fois, sans réveil', async () => {
  const { api, ecritures } = faux({
    '/repos/MoKarade/DriveAI/pulls/12': { state: 'open', draft: false, head: { sha: 'abcdef1234567' } },
    '/repos/MoKarade/DriveAI/actions/runs/555': { run_attempt: 1 },
    '/repos/MoKarade/DriveAI/actions/runs/555/jobs': { jobs: [{ conclusion: 'timed_out', steps: [] }] },
  });
  await traiter({ api, evt: roug, jetonReveil: 'jeton', journal: () => {} });
  assert.deepEqual(ecritures.map((e) => `${e.methode} ${e.chemin}`), ['POST /repos/MoKarade/DriveAI/actions/runs/555/rerun-failed-jobs']);
});

// ---- Filet quotidien (tâche MoKarade/.github#143) ----
// Vendredi 16/10/2026 à 6 h au Québec (heure d'été, UTC-4) = 10:00 UTC ; jeudi 15/10 à 6 h = 10:00 UTC.
const VENDREDI_6H = new Date('2026-10-16T10:00:00Z');
const JEUDI_6H = new Date('2026-10-15T10:00:00Z');
const il = (minutes, extra = {}) => ({ name: 'Gate', conclusion: 'failure', completed_at: new Date(VENDREDI_6H.getTime() - minutes * 60_000).toISOString(), ...extra });
const evtFilet = (extra = {}) => ({ type: 'filet', depot: 'MoKarade/JobAI', brancheDefaut: 'main', ...extra });
const pr = (numero, extra = {}) => ({ number: numero, draft: false, user: humain, head: { sha: `sha${numero}` }, ...extra });

test('heureQuebec : heure d’été et d’hiver, jour de la semaine', () => {
  assert.deepEqual(heureQuebec(new Date('2026-10-16T10:00:00Z')), { heure: 6, jour: 'Fri' });
  assert.deepEqual(heureQuebec(new Date('2026-10-16T11:00:00Z')), { heure: 7, jour: 'Fri' });
  // après le retour à l'heure normale (1er novembre 2026), 6 h au Québec = 11:00 UTC
  assert.deepEqual(heureQuebec(new Date('2026-11-02T11:00:00Z')), { heure: 6, jour: 'Mon' });
  assert.deepEqual(heureQuebec(new Date('2026-11-02T10:00:00Z')), { heure: 5, jour: 'Mon' });
  assert.equal(heureQuebec(new Date('2026-10-16T04:30:00Z')).heure, 0); // minuit : 0, jamais 24
});

test('rougeDepuis : rouge depuis plus de 30 min seulement, Garde-fou exclu', () => {
  assert.equal(rougeDepuis([il(31)], VENDREDI_6H), true);
  assert.equal(rougeDepuis([il(10)], VENDREDI_6H), false);
  assert.equal(rougeDepuis([il(120, { conclusion: 'success' })], VENDREDI_6H), false);
  assert.equal(rougeDepuis([il(120, { conclusion: 'neutral' })], VENDREDI_6H), false);
  assert.equal(rougeDepuis([il(120, { name: 'Garde-fou' })], VENDREDI_6H), false);
  assert.equal(rougeDepuis([il(120, { conclusion: 'timed_out' })], VENDREDI_6H), true);
  assert.equal(rougeDepuis([il(120, { completed_at: null })], VENDREDI_6H), false);
  assert.equal(rougeDepuis([], VENDREDI_6H), false);
});

test('filet : hors de 6 h au Québec, rien (sans même lire GitHub) ; « forcer » passe outre', async () => {
  const lectures = [];
  const api = async (m, c) => { lectures.push(c); return []; };
  const r = await decider({ api, evt: evtFilet(), maintenant: new Date('2026-10-16T11:00:00Z') });
  assert.equal(r.action, 'rien');
  assert.deepEqual(lectures, []);
  const f = await decider({ api, evt: evtFilet({ forcer: 'true' }), maintenant: new Date('2026-10-16T11:00:00Z') });
  assert.equal(f.action, 'rien');
  assert.match(f.raison, /rien à signaler/);
  assert.ok(lectures.length > 0);
});

test('filet : rien à signaler, aucun réveil et aucune écriture', async () => {
  const { api, ecritures } = faux({
    '/repos/MoKarade/JobAI/pulls': [pr(3), pr(4, { draft: true })],
    '/repos/MoKarade/JobAI/commits/sha3/check-runs': { check_runs: [il(500, { conclusion: 'success' })] },
    '/repos/MoKarade/JobAI/issues': [],
    '/repos/MoKarade/JobAI/commits/main/check-runs': { check_runs: [il(500, { conclusion: 'success' })] },
  });
  const sortie = [];
  const r = await traiter({ api, evt: evtFilet(), jetonReveil: 'jeton', journal: (l) => sortie.push(l), maintenant: VENDREDI_6H });
  assert.equal(r.action, 'rien');
  assert.deepEqual(ecritures, []);
  assert.match(sortie.join(''), /rien à signaler/);
});

test('filet : PR rouge, incident et branche par défaut rouge, un seul réveil avec des numéros', async () => {
  const { api, ecritures } = faux({
    '/repos/MoKarade/JobAI/pulls': [
      pr(3),
      pr(4),
      pr(5, { draft: true }),
      pr(6, { user: { login: 'dependabot[bot]', type: 'Bot' } }),
      pr(7, { user: { login: 'mergify[bot]', type: 'Bot' } }),
      pr(8),
    ],
    '/repos/MoKarade/JobAI/commits/sha3/check-runs': { check_runs: [il(45)] },
    '/repos/MoKarade/JobAI/commits/sha4/check-runs': { check_runs: [il(5)] },
    '/repos/MoKarade/JobAI/commits/sha8/check-runs': { check_runs: [il(600, { name: 'Garde-fou' })] },
    '/repos/MoKarade/JobAI/issues': [{ number: 12 }, { number: 13, pull_request: {} }],
    '/repos/MoKarade/JobAI/commits/main/check-runs': { check_runs: [il(90)] },
  });
  const r = await traiter({ api, evt: evtFilet(), jetonReveil: 'jeton', journal: () => {}, maintenant: VENDREDI_6H });
  assert.equal(r.reveille, true);
  assert.equal(
    r.motif,
    'RÉACTEUR : PR rouge depuis plus de 30 min sur MoKarade/JobAI : #3 ; incident ouvert sur MoKarade/JobAI : #12 ; branche par défaut rouge sur MoKarade/JobAI',
  );
  assert.equal(ecritures.length, 1);
  assert.equal(ecritures[0].chemin, `/repos/${DEPOT_BOITE}/actions/workflows/${WORKFLOW_BOITE}/dispatches`);
  assert.deepEqual(ecritures[0].corps, { ref: 'main', inputs: { texte: r.motif } });
  assert.equal(ecritures[0].jeton, 'jeton');
});

test('filet : le rappel du jeudi ne vient que de .github, et seulement le jeudi', async () => {
  const vide = { '/repos/MoKarade/.github/pulls': [], '/repos/MoKarade/.github/issues': [], '/repos/MoKarade/JobAI/pulls': [], '/repos/MoKarade/JobAI/issues': [] };
  const { api } = faux(vide);
  const jeudiGithub = await decider({ api, evt: evtFilet({ depot: 'MoKarade/.github' }), maintenant: JEUDI_6H });
  assert.deepEqual(jeudiGithub, { action: 'reveiller', motif: 'RÉACTEUR : jeudi : remesure hebdo de la consommation Claude à lancer' });
  assert.equal((await decider({ api, evt: evtFilet({ depot: 'MoKarade/.github' }), maintenant: VENDREDI_6H })).action, 'rien');
  assert.equal((await decider({ api, evt: evtFilet(), maintenant: JEUDI_6H })).action, 'rien');
});

test('filet : un dépôt vide ou illisible (réponses nulles) ne casse pas le passage', async () => {
  const { api } = faux();
  const r = await decider({ api, evt: evtFilet(), maintenant: VENDREDI_6H });
  assert.deepEqual(r, { action: 'rien', raison: 'rien à signaler' });
});
