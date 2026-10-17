import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { DEPOT_BOITE, DEPOT_GITHUB, LONGUEUR_MAX, PREFIXE, WORKFLOW_BOITE, WORKFLOWS_BALAYAGE, WORKFLOWS_PR_OUVERTE, construireMotif, decider, estPanneRunner, heureQuebec, occupations, preuveAPoser, rougeDepuis, traiter } from './reveil-reacteur.mjs';

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

// « Libre » seulement si le dépôt l'est vraiment (tâche MoKarade/.github#164) : plus de commentaire sur un dépôt occupé.
const DEPOT = 'MoKarade/JobAI';
const issuesEnCours = (numeros) => numeros.map((number) => ({ number, labels: [{ name: 'en-cours' }] }));
const prOuverte = (number, corps, extra = {}) => ({ number, draft: false, body: corps, user: humain, head: { ref: `claude/x${number}` }, ...extra });

test('occupations : issue en-cours ou jules, PR ouverte (brouillon compris) ; robots et boîte du Réacteur ne comptent pas', async () => {
  assert.deepEqual(await occupations({ api: faux().api, depot: DEPOT }), []);
  assert.deepEqual(await occupations({ api: faux({ [`/repos/${DEPOT}/issues`]: issuesEnCours([12]) }).api, depot: DEPOT }), ['#12']);
  const prs = [
    prOuverte(30, 'Tâche : #12', { draft: true }),
    prOuverte(31, 'Bump', { user: { login: 'dependabot[bot]', type: 'Bot' } }),
    prOuverte(58, '', { draft: true, user: { login: 'github-actions[bot]', type: 'Bot' }, head: { ref: 'claude/boite-reacteur' } }),
  ];
  assert.deepEqual(await occupations({ api: faux({ [`/repos/${DEPOT}/pulls`]: prs }).api, depot: DEPOT }), ['PR #30']);
  // une pull request renvoyée par l'API des issues n'est pas une tâche prise
  assert.deepEqual(await occupations({ api: faux({ [`/repos/${DEPOT}/issues`]: [{ number: 5, pull_request: {} }] }).api, depot: DEPOT }), []);
});

test('occupations : la tâche de la PR qui fusionne ne compte pas, sauf si une autre PR ouverte la cite', async () => {
  const api = faux({ [`/repos/${DEPOT}/issues`]: issuesEnCours([12, 13]) }).api;
  assert.deepEqual(await occupations({ api, depot: DEPOT, tachesExclues: [12] }), ['#13']);
  const encore = faux({ [`/repos/${DEPOT}/issues`]: issuesEnCours([12]), [`/repos/${DEPOT}/pulls`]: [prOuverte(40, 'Tâche : #12')] }).api;
  assert.deepEqual(await occupations({ api: encore, depot: DEPOT, tachesExclues: [12] }), ['#12', 'PR #40']);
});

test('occupations : une lecture qui échoue rend « libre » (un réveil de trop plutôt qu’un dépôt libre tu)', async () => {
  assert.deepEqual(await occupations({ api: faux({ [`/repos/${DEPOT}/pulls`]: new Error('HTTP 403') }).api, depot: DEPOT }), []);
});

test('tâche fermée : dépôt occupé = aucun réveil ; libre = « libre » ; abandon réveille toujours, sans « libre » si occupé', async () => {
  const occupe = faux({ [`/repos/${DEPOT}/issues`]: issuesEnCours([20]) });
  const evt = { type: 'tache_fermee', depot: DEPOT, issue: '90', raison: 'completed' };
  assert.deepEqual(await decider({ api: occupe.api, evt }), { action: 'rien', raison: 'dépôt encore occupé' });
  assert.equal((await decider({ api: faux().api, evt })).motif, `RÉACTEUR : ${DEPOT} libre ; tâche ${DEPOT}#90 fermée`);
  const abandon = await decider({ api: occupe.api, evt: { ...evt, raison: 'not_planned' } });
  assert.equal(abandon.motif, `RÉACTEUR : tâche ${DEPOT}#90 fermée (abandonnée : vérifier la raison)`);
});

test('PR fusionnée : dépôt occupé par une autre tâche = aucun réveil ; la tâche de la PR fusionnée ne l’occupe plus', async () => {
  const base = { [`/repos/${DEPOT}/pulls/7`]: { body: 'Tâche : #12', user: humain }, [`/repos/${DEPOT}/issues/12`]: tache({ labels: [{ name: 'niveau:tâche' }, { name: 'preuve-attendue' }] }), [`/repos/${DEPOT}/issues/12/comments`]: [] };
  const evt = { type: 'pr_fusionnee', depot: DEPOT, pr: '7' };
  // seule la tâche #12 de la PR est encore étiquetée en-cours : le dépôt est libre
  assert.equal((await decider({ api: faux({ ...base, [`/repos/${DEPOT}/issues`]: issuesEnCours([12]) }).api, evt })).motif, `RÉACTEUR : ${DEPOT} libre ; PR #7 fusionnée`);
  // une autre tâche est en cours : rien
  assert.deepEqual(await decider({ api: faux({ ...base, [`/repos/${DEPOT}/issues`]: issuesEnCours([12, 21]) }).api, evt }), { action: 'rien', raison: 'dépôt encore occupé' });
  // une autre PR de tâche est ouverte : rien
  assert.equal((await decider({ api: faux({ ...base, [`/repos/${DEPOT}/pulls`]: [prOuverte(41, 'Tâche : #21')] }).api, evt })).action, 'rien');
});

test('PR fusionnée : dépôt occupé mais preuve à poser = réveil, sans la ligne « libre »', async () => {
  const { api } = faux({
    [`/repos/${DEPOT}/pulls/7`]: { body: 'Tâche : #115', user: humain },
    [`/repos/${DEPOT}/issues/115`]: tache(),
    [`/repos/${DEPOT}/issues/115/comments`]: [],
    [`/repos/${DEPOT}/issues`]: issuesEnCours([21]),
  });
  const d = await decider({ api, evt: { type: 'pr_fusionnee', depot: DEPOT, pr: '7' } });
  assert.equal(d.motif, `RÉACTEUR : PR #7 fusionnée ; preuve à poser sur ${DEPOT}#115`);
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
  // Le réveil d'abord, puis les deux balayages de .github (tâche #148), tous avec le jeton de réveil.
  assert.deepEqual(ecritures[0], {
    methode: 'POST',
    chemin: `/repos/${DEPOT_BOITE}/actions/workflows/${WORKFLOW_BOITE}/dispatches`,
    corps: { ref: 'main', inputs: { texte: 'RÉACTEUR : MoKarade/CarAI libre ; tâche MoKarade/CarAI#1 fermée' } },
    jeton: 'jeton',
  });
  assert.deepEqual(
    ecritures.slice(1),
    WORKFLOWS_BALAYAGE.map((w) => ({ methode: 'POST', chemin: `/repos/${DEPOT_GITHUB}/actions/workflows/${w}/dispatches`, corps: { ref: 'main' }, jeton: 'jeton' })),
  );
  assert.deepEqual(r.balayages, ['commentaire-tache-liee.yml', 'relecture-ia.yml']);
});

test('traiter : PR fusionnée et CI rouge lancent aussi les balayages ; le filet, un événement sans réveil ou sans jeton, jamais', async () => {
  const balayages = (ecritures) => ecritures.filter((e) => e.chemin.startsWith(`/repos/${DEPOT_GITHUB}/`)).length;
  const fusionnee = faux({ '/repos/MoKarade/CarAI/pulls/5': { body: '', user: { login: 'MoKarade' } } });
  await traiter({ api: fusionnee.api, evt: { type: 'pr_fusionnee', depot: 'MoKarade/CarAI', pr: '5' }, jetonReveil: 'jeton', journal: () => {} });
  assert.equal(balayages(fusionnee.ecritures), 2);

  const rouge = faux({
    '/repos/MoKarade/CarAI/pulls/6': { state: 'open', draft: false, head: { sha: 'abc1234def' } },
    '/repos/MoKarade/CarAI/actions/runs/9': { run_attempt: 2 },
  });
  await traiter({ api: rouge.api, evt: { type: 'ci_rouge', depot: 'MoKarade/CarAI', pr: '6', evenement: 'pull_request', sha: 'abc1234def', run: '9' }, jetonReveil: 'jeton', journal: () => {} });
  assert.equal(balayages(rouge.ecritures), 2);

  const robot = faux({ '/repos/MoKarade/CarAI/pulls/7': { body: '', user: { login: 'dependabot[bot]' } } });
  await traiter({ api: robot.api, evt: { type: 'pr_fusionnee', depot: 'MoKarade/CarAI', pr: '7' }, jetonReveil: 'jeton', journal: () => {} });
  assert.equal(robot.ecritures.length, 0);

  const sansJeton = faux();
  await traiter({ api: sansJeton.api, evt: { type: 'tache_fermee', depot: 'MoKarade/CarAI', issue: '1' }, jetonReveil: '', journal: () => {} });
  assert.equal(sansJeton.ecritures.length, 0);
});

test('traiter : jeton sans droit sur .github : avertissement, le réveil reste fait et rien ne lève', async () => {
  const ecritures = [];
  const api = async (methode, chemin, corps, jeton) => {
    if (methode !== 'GET') {
      ecritures.push(chemin);
      if (chemin.startsWith(`/repos/${DEPOT_GITHUB}/`)) throw new Error('HTTP 404 sur POST ' + chemin);
    }
    return null;
  };
  const lignes = [];
  const r = await traiter({ api, evt: { type: 'tache_fermee', depot: 'MoKarade/CarAI', issue: '1' }, jetonReveil: 'jeton', journal: (l) => lignes.push(l) });
  assert.equal(r.reveille, true);
  assert.deepEqual(r.balayages, []);
  assert.equal(ecritures.length, 3);
  assert.equal(lignes.filter((l) => l.startsWith('::warning::') && l.includes('commentaire-tache-liee.yml non lancé')).length, 1);
  assert.equal(lignes.filter((l) => l.startsWith('::warning::') && l.includes('relecture-ia.yml non lancé')).length, 1);
  assert.ok(lignes.some((l) => l.includes('Coordinateur réveillé')));
});

test('traiter : le réveil qui échoue ne retient pas les balayages, puis l\'erreur remonte', async () => {
  const ecritures = [];
  const api = async (methode, chemin) => {
    if (methode !== 'GET') {
      ecritures.push(chemin);
      if (chemin.includes(WORKFLOW_BOITE)) throw new Error('HTTP 500');
    }
    return null;
  };
  await assert.rejects(
    traiter({ api, evt: { type: 'tache_fermee', depot: 'MoKarade/CarAI', issue: '1' }, jetonReveil: 'jeton', journal: () => {} }),
    /HTTP 500/,
  );
  assert.equal(ecritures.length, 3);
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

// Tâche MoKarade/.github#194 : plus de garde « 6 h au Québec ». Le 17/10/2026 les crons sont partis avec 3 h de retard et la garde
// les a tous fait sauter. Le filet agit à toute heure ; un même signal n'est reposté qu'une fois par fenêtre de 6 h.
const SIGNAL = {
  '/repos/MoKarade/JobAI/pulls': [pr(3)],
  '/repos/MoKarade/JobAI/commits/sha3/check-runs': { check_runs: [il(45)] },
  '/repos/MoKarade/JobAI/issues': [],
  '/repos/MoKarade/JobAI/commits/main/check-runs': { check_runs: [il(500, { conclusion: 'success' })] },
};
const MOTIF_SIGNAL = 'RÉACTEUR : PR rouge depuis plus de 30 min sur MoKarade/JobAI : #3';
const BOITE = `/repos/${DEPOT_BOITE}/issues/58/comments`;
const commentaireBoite = (corps, il_y_a_h, login = 'github-actions[bot]') => ({
  body: corps,
  user: { login },
  created_at: new Date(NEUF_H_QUEBEC.getTime() - il_y_a_h * 3_600_000).toISOString(),
});
// 9 h au Québec (heure d'été) = 13:00 UTC : une heure où l'ancienne garde faisait sauter le filet.
const NEUF_H_QUEBEC = new Date('2026-10-16T13:00:00Z');

test('filet : à 9 h au Québec (cron en retard) il agit, sans garde d’heure', async () => {
  const { api, ecritures } = faux(SIGNAL);
  const r = await traiter({ api, evt: evtFilet(), jetonReveil: 'jeton', journal: () => {}, maintenant: NEUF_H_QUEBEC });
  assert.equal(r.action, 'reveiller');
  assert.equal(r.motif, MOTIF_SIGNAL);
  assert.equal(ecritures.length, 1);
  // et à minuit, ou à l'heure d'hiver : même chose
  for (const t of ['2026-10-17T04:00:00Z', '2026-11-02T16:30:00Z']) {
    assert.equal((await decider({ api, evt: evtFilet(), maintenant: new Date(t) })).action, 'reveiller');
  }
});

test('filet : un même signal posté il y a moins de 6 h ne réveille pas deux fois ; passé 6 h, oui', async () => {
  const dejaPose = (h) => faux({ ...SIGNAL, [BOITE]: [commentaireBoite(MOTIF_SIGNAL, h)] });
  const { api, ecritures } = dejaPose(3);
  const r = await traiter({ api, evt: evtFilet(), jetonReveil: 'jeton', journal: () => {}, maintenant: NEUF_H_QUEBEC });
  assert.equal(r.action, 'rien');
  assert.match(r.raison, /déjà signalé/);
  assert.deepEqual(ecritures, []);
  // 7 h plus tard : le lendemain de la panne, le signal est de nouveau dit
  assert.equal((await decider({ api: dejaPose(7).api, evt: evtFilet(), maintenant: NEUF_H_QUEBEC })).action, 'reveiller');
});

test('filet : seul le même motif posté par le robot compte ; un autre signal, un humain ou une lecture qui échoue réveillent', async () => {
  const cas = (commentaires) => faux({ ...SIGNAL, [BOITE]: commentaires }).api;
  const dec = (api, extra = {}) => decider({ api, evt: evtFilet(extra), maintenant: NEUF_H_QUEBEC });
  assert.equal((await dec(cas([commentaireBoite('RÉACTEUR : incident ouvert sur MoKarade/JobAI : #12', 1)]))).action, 'reveiller');
  assert.equal((await dec(cas([commentaireBoite(MOTIF_SIGNAL, 1, 'MoKarade')]))).action, 'reveiller');
  assert.equal((await dec(faux({ ...SIGNAL, [BOITE]: new Error('HTTP 500') }).api)).action, 'reveiller');
  // lancement manuel (« forcer ») : repose le réveil même si le signal vient d'être posté
  assert.equal((await dec(cas([commentaireBoite(MOTIF_SIGNAL, 1)]), { forcer: 'true' })).action, 'reveiller');
  assert.equal((await dec(cas([commentaireBoite(MOTIF_SIGNAL, 1)]))).action, 'rien');
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

test('pr_ouverte : lance seulement le commentaire tâche liée, ne commente rien sur la boîte et ne réveille personne', async () => {
  const { api, ecritures } = faux();
  const lignes = [];
  const r = await traiter({ api, evt: { type: 'pr_ouverte', depot: 'MoKarade/CarAI', pr: '12' }, jetonReveil: 'jeton', journal: (l) => lignes.push(l) });
  assert.equal(r.action, 'balayer');
  assert.notEqual(r.reveille, true);
  assert.deepEqual(r.balayages, WORKFLOWS_PR_OUVERTE);
  assert.deepEqual(ecritures, [{ methode: 'POST', chemin: `/repos/${DEPOT_GITHUB}/actions/workflows/commentaire-tache-liee.yml/dispatches`, corps: { ref: 'main' }, jeton: 'jeton' }]);
  assert.ok(!ecritures.some((e) => e.chemin.includes(DEPOT_BOITE) || e.chemin.includes(WORKFLOW_BOITE)));
  assert.ok(!lignes.some((l) => l.includes('Coordinateur réveillé')));
});

test('pr_ouverte : sans jeton un avertissement, aucune écriture ; balayage qui échoue = avertissement, jamais d’exception', async () => {
  const sansJeton = faux();
  const lignes = [];
  await traiter({ api: sansJeton.api, evt: { type: 'pr_ouverte', depot: 'MoKarade/CarAI', pr: '12' }, jetonReveil: '', journal: (l) => lignes.push(l) });
  assert.equal(sansJeton.ecritures.length, 0);
  assert.ok(lignes.some((l) => l.startsWith('::warning::') && l.includes('balayage impossible')));

  const api = async (methode, chemin) => { if (methode !== 'GET') throw new Error('HTTP 404 sur POST ' + chemin); return null; };
  const lignes2 = [];
  const r = await traiter({ api, evt: { type: 'pr_ouverte', depot: 'MoKarade/CarAI', pr: '12' }, jetonReveil: 'jeton', journal: (l) => lignes2.push(l) });
  assert.deepEqual(r.balayages, []);
  assert.ok(lignes2.some((l) => l.includes('commentaire-tache-liee.yml non lancé')));
});

// Le 17/10/2026 GitHub n'a lancé aucun passage planifié aux heures rondes (`0 10`, `0 11`) alors que les minutes décalées
// de ce dépôt tournaient : un filet quotidien ou hebdomadaire ne retombe jamais sur une minute ronde (MoKarade/.github#143).
test('horloges du filet : une minute fixe, ni ronde (0, 15, 30, 45), deux passages par jour', () => {
  const lire = (f) => readFileSync(new URL(`../.github/workflows/${f}`, import.meta.url), 'utf8');
  const crons = (f) => [...lire(f).matchAll(/^\s*- cron: '([^']+)'/gm)].map((m) => m[1].split(' '));

  const filet = crons('reacteur.yml');
  assert.deepEqual(filet.map((c) => c[1]).sort(), ['10', '11']);
  for (const c of filet) assert.match(c[0], /^\d+$/);

  for (const f of ['reacteur.yml', 'rapport-hebdo.yml']) {
    for (const [minute] of crons(f)) assert.ok(!['0', '15', '30', '45'].includes(minute), `${f} : minute ronde « ${minute} »`);
  }
});
