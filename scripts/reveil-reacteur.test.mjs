import './places-deux.mjs';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { LABEL_ATTEND_MARC, TITRE_ATTEND_MARC, prAttendantMarc } from './attend-marc.mjs';
import { DEPOT_BOITE, DEPOT_GITHUB, LONGUEUR_MAX, PREFIXE, WORKFLOW_BOITE, TYPES_BALAYAGE, WORKFLOWS_BALAYAGE, WORKFLOWS_GARDE_FOU_ROUGE, WORKFLOWS_PR_OUVERTE, NUMERO_BOITE, construireMotif, decider, verifierAliasVercel, estPanneRunner, occupations, travaux, signeLibre, traiter } from './reveil-reacteur.mjs';

// Fausse API GitHub en mémoire : les lectures viennent de `donnees`, les écritures sont gardées.
function faux(donnees = {}) {
  const ecritures = [];
  const api = async (methode, chemin, corps, jeton) => {
    if (methode !== 'GET') { ecritures.push({ methode, chemin, corps, jeton }); return null; }
    const [base] = chemin.split('?');
    const cle = chemin in donnees ? chemin : base;
    if (!(cle in donnees)) return null;
    const v = donnees[cle];
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

test('tâche fermée : « D libre », sans tâche suivante ; abandon signalé', async () => {
  const { api } = faux();
  const a = await decider({ api, evt: { type: 'tache_fermee', depot: 'MoKarade/JobAI', issue: '90', raison: 'completed' } });
  assert.deepEqual(a, { action: 'lancer', motif: 'RÉACTEUR : MoKarade/JobAI libre ; tâche MoKarade/JobAI#90 fermée' });
  const b = await decider({ api, evt: { type: 'tache_fermee', depot: 'MoKarade/JobAI', issue: '90', raison: 'not_planned' } });
  assert.match(b.motif, /abandonnée/);
});

test('PR fusionnée : tâche déjà en preuve-attendue ou sans tâche (humain) : libre sans preuve à poser', async () => {
  const { api } = faux({
    '/repos/MoKarade/JobAI/pulls/7': { body: 'Tâche : #90', user: humain },
    '/repos/MoKarade/JobAI/issues/90': tache({ labels: [{ name: 'niveau:tâche' }, { name: 'preuve-attendue' }] }),
    '/repos/MoKarade/JobAI/pulls/8': { body: 'rien', user: humain },
  });
  assert.equal((await decider({ api, evt: { type: 'pr_fusionnee', depot: 'MoKarade/JobAI', pr: '7' } })).motif, 'RÉACTEUR : MoKarade/JobAI libre ; PR #7 fusionnée');
  assert.equal((await decider({ api, evt: { type: 'pr_fusionnee', depot: 'MoKarade/JobAI', pr: '8' } })).action, 'lancer');
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

test('occupations : issue en-cours, PR ouverte (brouillon compris) ; robots et boîte du Réacteur ne comptent pas', async () => {
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

test('occupations : une tâche jules et sa PR ne tiennent pas de place (23/10/2026)', async () => {
  const jules = [{ number: 412, labels: [{ name: 'jules' }] }];
  const donnees = { [`/repos/${DEPOT}/issues?labels=jules&state=open&per_page=30`]: jules };
  assert.deepEqual(await occupations({ api: faux(donnees).api, depot: DEPOT }), []);
  assert.equal(await travaux({ api: faux({ ...donnees, [`/repos/${DEPOT}/pulls`]: [prOuverte(60, 'Tâche : #412')] }).api, depot: DEPOT }), 0);
  // la PR d'un fil, elle, compte toujours, et une PR qui cite une tâche en-cours ET une tâche jules compte une fois
  const mixte = { ...donnees, [`/repos/${DEPOT}/issues?labels=en-cours&state=open&per_page=30`]: issuesEnCours([12]), [`/repos/${DEPOT}/pulls`]: [prOuverte(61, 'Tâche : #12'), prOuverte(62, 'Tâche : #412')] };
  assert.equal(await travaux({ api: faux(mixte).api, depot: DEPOT }), 1);
  assert.deepEqual(await occupations({ api: faux(mixte).api, depot: DEPOT }), ['#12', 'PR #61']);
});

test('occupations : la tâche de la PR qui fusionne ne compte pas, sauf si une autre PR ouverte la cite', async () => {
  const api = faux({ [`/repos/${DEPOT}/issues`]: issuesEnCours([12, 13]) }).api;
  assert.deepEqual(await occupations({ api, depot: DEPOT, tachesExclues: [12] }), ['#13']);
  const encore = faux({ [`/repos/${DEPOT}/issues`]: issuesEnCours([12]), [`/repos/${DEPOT}/pulls`]: [prOuverte(40, 'Tâche : #12')] }).api;
  assert.deepEqual(await occupations({ api: encore, depot: DEPOT, tachesExclues: [12] }), ['#12', 'PR #40']);
});

// Tâche #216 : même règle que prochaine-tache.mjs (#197), lue par scripts/attend-marc.mjs.
const gestePr = (pr) => ({ number: 900 + pr, state: 'open', title: `Garde-fou : la PR #${pr} attend un geste de Marc`, labels: [{ name: 'qui:marc' }] });
const GESTES = `/repos/${DEPOT}/issues?labels=qui:marc&state=open&per_page=100`;

test('occupations : une PR qui n’attend que Marc (et sa tâche en-cours) n’occupe pas le dépôt', async () => {
  const donnees = { [`/repos/${DEPOT}/issues`]: issuesEnCours([12]), [`/repos/${DEPOT}/pulls`]: [prOuverte(30, 'Tâche : #12')] };
  // sans l'issue de geste : dépôt occupé par la tâche et par la PR
  assert.deepEqual(await occupations({ api: faux({ ...donnees, [GESTES]: [] }).api, depot: DEPOT }), ['#12', 'PR #30']);
  // avec « la PR #30 attend un geste de Marc » : libre
  assert.deepEqual(await occupations({ api: faux({ ...donnees, [GESTES]: [gestePr(30)] }).api, depot: DEPOT }), []);
});

test('occupations : seule la PR qui attend Marc est écartée ; une autre PR, une PR rouge ordinaire ou un geste sur une autre PR occupent toujours', async () => {
  const prs = [prOuverte(30, 'Tâche : #12'), prOuverte(31, 'Tâche : #13', { draft: true })];
  const donnees = { [`/repos/${DEPOT}/issues`]: issuesEnCours([12, 13]), [`/repos/${DEPOT}/pulls`]: prs };
  assert.deepEqual(await occupations({ api: faux({ ...donnees, [GESTES]: [gestePr(30)] }).api, depot: DEPOT }), ['#13', 'PR #31']);
  assert.deepEqual(await occupations({ api: faux({ ...donnees, [GESTES]: [gestePr(99)] }).api, depot: DEPOT }), ['#12', '#13', 'PR #30', 'PR #31']);
  // une autre PR ouverte cite encore la tâche #12 : elle reste prise
  const double = { ...donnees, [`/repos/${DEPOT}/pulls`]: [...prs, prOuverte(32, 'Tâche : #12')], [GESTES]: [gestePr(30)] };
  assert.deepEqual(await occupations({ api: faux(double).api, depot: DEPOT }), ['#12', '#13', 'PR #31', 'PR #32']);
});

test('tâche fermée : le dépôt dont la seule PR attend Marc est « libre » pour le Réacteur, et réveille', async () => {
  const api = faux({ [`/repos/${DEPOT}/issues`]: issuesEnCours([12]), [`/repos/${DEPOT}/pulls`]: [prOuverte(30, 'Tâche : #12')], [GESTES]: [gestePr(30)] }).api;
  const d = await decider({ api, evt: { type: 'tache_fermee', depot: DEPOT, issue: '90' } });
  assert.equal(d.motif, `RÉACTEUR : ${DEPOT} libre ; tâche ${DEPOT}#90 fermée`);
  const rouge = faux({ [`/repos/${DEPOT}/issues`]: issuesEnCours([12]), [`/repos/${DEPOT}/pulls`]: [prOuverte(30, 'Tâche : #12')], [GESTES]: [] }).api;
  // PR sans geste de Marc : elle occupe une place sur deux, le dépôt n'est plus « libre » mais a une place libre
  assert.equal((await decider({ api: rouge, evt: { type: 'tache_fermee', depot: DEPOT, issue: '90' } })).motif, `RÉACTEUR : ${DEPOT} : une place libre ; tâche ${DEPOT}#90 fermée`);
});

test('occupations : une lecture qui échoue rend « libre » (un réveil de trop plutôt qu’un dépôt libre tu)', async () => {
  assert.deepEqual(await occupations({ api: faux({ [`/repos/${DEPOT}/pulls`]: new Error('HTTP 403') }).api, depot: DEPOT }), []);
});

test('tâche fermée : deux places prises = rien ; libre = « libre » ; une place = « une place libre » ; un abandon ne change rien à la règle', async () => {
  const occupe = faux({ [`/repos/${DEPOT}/issues`]: issuesEnCours([20, 21]) });
  const evt = { type: 'tache_fermee', depot: DEPOT, issue: '90', raison: 'completed' };
  assert.deepEqual(await decider({ api: occupe.api, evt }), { action: 'rien', raison: 'dépôt encore occupé' });
  assert.equal((await decider({ api: faux().api, evt })).motif, `RÉACTEUR : ${DEPOT} libre ; tâche ${DEPOT}#90 fermée`);
  const une = await decider({ api: faux({ [`/repos/${DEPOT}/issues`]: issuesEnCours([20]) }).api, evt });
  assert.equal(une.motif, `RÉACTEUR : ${DEPOT} : une place libre ; tâche ${DEPOT}#90 fermée`);
  const abandon = await decider({ api: occupe.api, evt: { ...evt, raison: 'not_planned' } });
  assert.equal(abandon.action, 'rien');
  assert.match((await decider({ api: faux().api, evt: { ...evt, raison: 'not_planned' } })).motif, /fermée \(abandonnée\)$/);
});

test('PR fusionnée : dépôt occupé par une autre tâche = aucun réveil ; la tâche de la PR fusionnée ne l’occupe plus', async () => {
  const base = { [`/repos/${DEPOT}/pulls/7`]: { body: 'Tâche : #12', user: humain }, [`/repos/${DEPOT}/issues/12`]: tache({ labels: [{ name: 'niveau:tâche' }, { name: 'preuve-attendue' }] }), [`/repos/${DEPOT}/issues/12/comments`]: [] };
  const evt = { type: 'pr_fusionnee', depot: DEPOT, pr: '7' };
  // seule la tâche #12 de la PR est encore étiquetée en-cours : le dépôt est libre
  assert.equal((await decider({ api: faux({ ...base, [`/repos/${DEPOT}/issues`]: issuesEnCours([12]) }).api, evt })).motif, `RÉACTEUR : ${DEPOT} libre ; PR #7 fusionnée`);
  // une autre tâche est en cours : une place reste libre (deux places par dépôt, 21/10/2026)
  assert.equal((await decider({ api: faux({ ...base, [`/repos/${DEPOT}/issues`]: issuesEnCours([12, 21]) }).api, evt })).motif, `RÉACTEUR : ${DEPOT} : une place libre ; PR #7 fusionnée`);
  // deux autres tâches en cours : rien
  assert.deepEqual(await decider({ api: faux({ ...base, [`/repos/${DEPOT}/issues`]: issuesEnCours([12, 21, 22]) }).api, evt }), { action: 'rien', raison: 'dépôt encore occupé' });
  // une autre PR de tâche est ouverte : une place libre ; deux autres PR : rien
  assert.equal((await decider({ api: faux({ ...base, [`/repos/${DEPOT}/pulls`]: [prOuverte(41, 'Tâche : #21')] }).api, evt })).motif, `RÉACTEUR : ${DEPOT} : une place libre ; PR #7 fusionnée`);
  assert.equal((await decider({ api: faux({ ...base, [`/repos/${DEPOT}/pulls`]: [prOuverte(41, 'Tâche : #21'), prOuverte(42, 'Tâche : #22')] }).api, evt })).action, 'rien');
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

test('CI rouge sur PR : vraie panne = personne n’est réveillé, seuls les balayages de .github partent', async () => {
  const { api } = faux({
    '/repos/MoKarade/DriveAI/pulls/12': { state: 'open', draft: false, head: { sha: 'abcdef1234567' } },
    '/repos/MoKarade/DriveAI/actions/runs/555': { run_attempt: 1 },
    '/repos/MoKarade/DriveAI/actions/runs/555/jobs': { jobs: [{ conclusion: 'failure', steps: [{ conclusion: 'failure' }] }] },
  });
  const d = await decider({ api, evt: roug });
  assert.deepEqual(d, { action: 'balayer', workflows: WORKFLOWS_BALAYAGE });
});

test('CI rouge : échec de charge du robot au premier essai = relance, pas de réveil ; au second essai = balayages seulement', async () => {
  const pr = { '/repos/MoKarade/DriveAI/pulls/12': { state: 'open', draft: false, head: { sha: 'abcdef1234567' } } };
  const jobs = { '/repos/MoKarade/DriveAI/actions/runs/555/jobs': { jobs: [{ conclusion: 'failure', steps: [{ conclusion: 'cancelled' }] }] } };
  const premier = faux({ ...pr, ...jobs, '/repos/MoKarade/DriveAI/actions/runs/555': { run_attempt: 1 } });
  assert.deepEqual(await decider({ api: premier.api, evt: roug }), { action: 'relance', run: '555' });
  const second = faux({ ...pr, ...jobs, '/repos/MoKarade/DriveAI/actions/runs/555': { run_attempt: 2 } });
  assert.equal((await decider({ api: second.api, evt: roug })).action, 'balayer');
});

test('CI rouge sur push : seule la branche par défaut compte ; planifié : toujours', async () => {
  const run = { '/repos/MoKarade/DriveAI/actions/runs/9': { run_attempt: 2 } };
  const base = { type: 'ci_rouge', depot: 'MoKarade/DriveAI', run: '9', sha: 's', brancheDefaut: 'main' };
  const { api } = faux(run);
  assert.equal((await decider({ api, evt: { ...base, evenement: 'push', brancheRun: 'claude/x' } })).action, 'rien');
  assert.equal((await decider({ api, evt: { ...base, evenement: 'push', brancheRun: 'main' } })).action, 'balayer');
  assert.equal((await decider({ api, evt: { ...base, evenement: 'schedule' } })).action, 'balayer');
});

test('traiter : une tâche fermée n’écrit plus sur aucune boîte ; elle lance les deux balayages de .github avec le jeton de réveil', async () => {
  const { api, ecritures } = faux();
  const lignes = [];
  const r = await traiter({ api, evt: { type: 'tache_fermee', depot: 'MoKarade/CarAI', issue: '1', raison: 'completed' }, jetonReveil: 'jeton', journal: (l) => lignes.push(l) });
  assert.equal(r.action, 'lancer');
  assert.equal(r.reveille, undefined);
  assert.deepEqual(
    ecritures,
    WORKFLOWS_BALAYAGE.map((w) => ({ methode: 'POST', chemin: `/repos/${DEPOT_GITHUB}/actions/workflows/${w}/dispatches`, corps: { ref: 'main' }, jeton: 'jeton' })),
  );
  assert.ok(!ecritures.some((e) => e.chemin.includes(DEPOT_BOITE) || e.chemin.includes(WORKFLOW_BOITE)));
  assert.deepEqual(r.balayages, ['commentaire-tache-liee.yml', 'relecture-ia.yml']);
  assert.ok(lignes.includes('Réacteur : RÉACTEUR : MoKarade/CarAI libre ; tâche MoKarade/CarAI#1 fermée'));
  assert.ok(!lignes.some((l) => l.includes('Coordinateur réveillé')));
});

test('traiter : PR fusionnée et CI rouge lancent aussi les balayages ; le filet, un événement sans réveil ou sans jeton, jamais', async () => {
  const balayages = (ecritures) => ecritures.filter((e) => e.chemin.startsWith(`/repos/${DEPOT_GITHUB}/`)).length;
  const fusionnee = faux({ '/repos/MoKarade/CarAI/pulls/5': { body: '', user: { login: 'MoKarade' } } });
  await traiter({ boites: {}, api: fusionnee.api, evt: { type: 'pr_fusionnee', depot: 'MoKarade/CarAI', pr: '5' }, jetonReveil: 'jeton', journal: () => {} });
  assert.equal(balayages(fusionnee.ecritures), 2);

  const rouge = faux({
    '/repos/MoKarade/CarAI/pulls/6': { state: 'open', draft: false, head: { sha: 'abc1234def' } },
    '/repos/MoKarade/CarAI/actions/runs/9': { run_attempt: 2 },
  });
  await traiter({ boites: {}, api: rouge.api, evt: { type: 'ci_rouge', depot: 'MoKarade/CarAI', pr: '6', evenement: 'pull_request', sha: 'abc1234def', run: '9' }, jetonReveil: 'jeton', journal: () => {} });
  assert.equal(balayages(rouge.ecritures), 2);

  const robot = faux({ '/repos/MoKarade/CarAI/pulls/7': { body: '', user: { login: 'dependabot[bot]' } } });
  await traiter({ boites: {}, api: robot.api, evt: { type: 'pr_fusionnee', depot: 'MoKarade/CarAI', pr: '7' }, jetonReveil: 'jeton', journal: () => {} });
  assert.equal(robot.ecritures.length, 0);

  const sansJeton = faux();
  await traiter({ boites: {}, api: sansJeton.api, evt: { type: 'tache_fermee', depot: 'MoKarade/CarAI', issue: '1' }, jetonReveil: '', journal: () => {} });
  // Sans jeton : aucune écriture (plus d'alerte « réveil impossible », plus de boîte locale).
  assert.deepEqual(sansJeton.ecritures, []);
});

test('traiter : jeton sans droit sur .github : avertissement et rien ne lève', async () => {
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
  assert.equal(r.action, 'lancer');
  assert.deepEqual(r.balayages, []);
  assert.equal(ecritures.length, 2);
  assert.equal(lignes.filter((l) => l.startsWith('::warning::') && l.includes('commentaire-tache-liee.yml non lancé')).length, 1);
  assert.equal(lignes.filter((l) => l.startsWith('::warning::') && l.includes('relecture-ia.yml non lancé')).length, 1);
});

test('traiter : sans jeton, aucune écriture (ni balayage, ni boîte)', async () => {
  const { api, ecritures } = faux();
  const r = await traiter({ api, evt: { type: 'tache_fermee', depot: 'MoKarade/CarAI', issue: '1', raison: 'completed' }, jetonReveil: '', journal: () => {} });
  assert.equal(r.action, 'lancer');
  assert.deepEqual(r.balayages, []);
  assert.deepEqual(ecritures, []);
});

test('traiter : une panne du robot de tests relance les jobs en échec une seule fois, sans réveil', async () => {
  const { api, ecritures } = faux({
    '/repos/MoKarade/DriveAI/pulls/12': { state: 'open', draft: false, head: { sha: 'abcdef1234567' } },
    '/repos/MoKarade/DriveAI/actions/runs/555': { run_attempt: 1 },
    '/repos/MoKarade/DriveAI/actions/runs/555/jobs': { jobs: [{ conclusion: 'timed_out', steps: [] }] },
  });
  await traiter({ boites: {}, api, evt: roug, jetonReveil: 'jeton', journal: () => {} });
  assert.deepEqual(ecritures.map((e) => `${e.methode} ${e.chemin}`), ['POST /repos/MoKarade/DriveAI/actions/runs/555/rerun-failed-jobs']);
});

// ---- Filet (tâche MoKarade/.github#143) : plus aucun signal pour le Coordinateur depuis le nettoyage du 29/10/2026.
const evtFilet = (extra = {}) => ({ type: 'filet', depot: 'MoKarade/JobAI', brancheDefaut: 'main', ...extra });
const BOITE = `/repos/${DEPOT_BOITE}/issues/58/comments`;

test('filet : plus de signal pour le Coordinateur (PR rouge, incident, branche rouge, jeudi), aucune écriture ; les preuves différées restent', async () => {
  const { api, ecritures } = faux({
    '/repos/MoKarade/JobAI/pulls': [{ number: 3, draft: false, user: humain, head: { sha: 'sha3' } }],
    '/repos/MoKarade/JobAI/commits/sha3/check-runs': { check_runs: [{ name: 'Gate', conclusion: 'failure', completed_at: '2026-10-16T09:00:00Z' }] },
    '/repos/MoKarade/JobAI/issues': [{ number: 12 }],
  });
  const sortie = [];
  const r = await traiter({ api, evt: evtFilet(), jetonReveil: 'jeton', journal: (l) => sortie.push(l), maintenant: new Date('2026-10-15T10:00:00Z'), accepterDifferees: async () => ({ acceptees: [], ignorees: [] }) });
  assert.equal(r.action, 'rien');
  assert.deepEqual(ecritures, []);
  assert.match(sortie.join(''), /filet : preuves différées seulement/);
  const appels = [];
  const d = await decider({ api, evt: evtFilet(), accepterDifferees: async (o) => { appels.push(o); return { acceptees: [201], ignorees: [] }; } });
  assert.deepEqual(d.differees, { acceptees: [201], ignorees: [] }, 'le filet lit toujours les preuves différées dues');
  assert.equal(appels.length, 1);
});

test('pr_ouverte : lance seulement le commentaire tâche liée, ne commente rien sur la boîte et ne réveille personne', async () => {
  const { api, ecritures } = faux();
  const lignes = [];
  const r = await traiter({ boites: {}, api, evt: { type: 'pr_ouverte', depot: 'MoKarade/CarAI', pr: '12' }, jetonReveil: 'jeton', journal: (l) => lignes.push(l) });
  assert.equal(r.action, 'balayer');
  assert.notEqual(r.reveille, true);
  assert.deepEqual(r.balayages, WORKFLOWS_PR_OUVERTE);
  assert.deepEqual(ecritures, [{ methode: 'POST', chemin: `/repos/${DEPOT_GITHUB}/actions/workflows/commentaire-tache-liee.yml/dispatches`, corps: { ref: 'main' }, jeton: 'jeton' }]);
  assert.ok(!ecritures.some((e) => e.chemin.includes(DEPOT_BOITE) || e.chemin.includes(WORKFLOW_BOITE)));
  assert.ok(!lignes.some((l) => l.includes('Coordinateur réveillé')));
});

// MoKarade/.github#633 : le Garde-fou d'une PR qui finit en échec lance la relecture IA, et seulement elle (plus de minuteur, #626).
test('garde_fou_rouge : lance seulement relecture-ia.yml, ne commente rien sur la boîte et ne réveille personne', async () => {
  const { api, ecritures } = faux();
  const lignes = [];
  const r = await traiter({ boites: {}, api, evt: { type: 'garde_fou_rouge', depot: 'MoKarade/CarAI', pr: '12', evenement: 'pull_request_target' }, jetonReveil: 'jeton', journal: (l) => lignes.push(l) });
  assert.equal(r.action, 'balayer');
  assert.notEqual(r.reveille, true);
  assert.deepEqual(r.balayages, WORKFLOWS_GARDE_FOU_ROUGE);
  assert.deepEqual(ecritures, [{ methode: 'POST', chemin: `/repos/${DEPOT_GITHUB}/actions/workflows/relecture-ia.yml/dispatches`, corps: { ref: 'main' }, jeton: 'jeton' }]);
  assert.ok(!ecritures.some((e) => e.chemin.includes(DEPOT_BOITE) || e.chemin.includes(WORKFLOW_BOITE) || e.chemin.includes('commentaire-tache-liee')));
  assert.ok(!lignes.some((l) => l.includes('Coordinateur réveillé')));
});

test('garde_fou_rouge : sans jeton un avertissement et aucune écriture ; le type CI rouge garde son comportement', async () => {
  const sansJeton = faux();
  const lignes = [];
  await traiter({ boites: {}, api: sansJeton.api, evt: { type: 'garde_fou_rouge', depot: 'MoKarade/CarAI', pr: '12' }, jetonReveil: '', journal: (l) => lignes.push(l) });
  assert.deepEqual(sansJeton.ecritures, []);
  assert.ok(lignes.some((l) => l.startsWith('::warning::') && l.includes('REVEIL_TOKEN')));
  assert.deepEqual(WORKFLOWS_GARDE_FOU_ROUGE, ['relecture-ia.yml']);
  assert.ok(!TYPES_BALAYAGE.has('garde_fou_rouge'), 'garde_fou_rouge ne passe pas par le balayage des deux workflows');
});

test('garde_fou_rouge : reacteur.yml écoute le Garde-fou et le commun reveil-reacteur.yml envoie le type', () => {
  const lire = (f) => readFileSync(new URL(`../.github/workflows/${f}`, import.meta.url), 'utf8');
  const reacteur = lire('reacteur.yml');
  assert.match(reacteur, /workflow_run:\s*\n(?:\s*#[^\n]*\n)*\s*workflows: \[CI, Garde-fou\]/);
  assert.match(reacteur, /github\.event\.workflow_run\.name == 'Garde-fou' && 'garde_fou_rouge' \|\| 'ci_rouge'/);
  assert.match(lire('reveil-reacteur.yml'), /pr_fusionnee \| pr_ouverte \| tache_fermee \| tache_ouverte \| deploiement \| preuve_page \| commentaire \| fin_de_cron \| note_lia \| ci_rouge \| garde_fou_rouge \| filet/);
});

test('pr_ouverte : sans jeton un avertissement, aucune écriture ; balayage qui échoue = avertissement, jamais d’exception', async () => {
  const sansJeton = faux();
  const lignes = [];
  await traiter({ boites: {}, api: sansJeton.api, evt: { type: 'pr_ouverte', depot: 'MoKarade/CarAI', pr: '12' }, jetonReveil: '', journal: (l) => lignes.push(l) });
  assert.equal(sansJeton.ecritures.length, 0);
  assert.ok(lignes.some((l) => l.startsWith('::warning::') && l.includes('balayage impossible')));

  const api = async (methode, chemin) => { if (methode !== 'GET') throw new Error('HTTP 404 sur POST ' + chemin); return null; };
  const lignes2 = [];
  const r = await traiter({ boites: {}, api, evt: { type: 'pr_ouverte', depot: 'MoKarade/CarAI', pr: '12' }, jetonReveil: 'jeton', journal: (l) => lignes2.push(l) });
  assert.deepEqual(r.balayages, []);
  assert.ok(lignes2.some((l) => l.includes('commentaire-tache-liee.yml non lancé')));
});

// Le 17/10/2026 GitHub n'a lancé aucun passage planifié aux heures rondes (`0 10`, `0 11`) alors que les minutes décalées
// de ce dépôt tournaient : un filet quotidien ou hebdomadaire ne retombe jamais sur une minute ronde (MoKarade/.github#143).
test('horloges : reacteur.yml n’a plus aucun minuteur (tâche #712), et les crons qui restent ailleurs ne tombent jamais sur une minute ronde', () => {
  const lire = (f) => readFileSync(new URL(`../.github/workflows/${f}`, import.meta.url), 'utf8');
  const crons = (f) => [...lire(f).matchAll(/^\s*- cron: '([^']+)'/gm)].map((m) => m[1].split(' '));

  assert.deepEqual(crons('reacteur.yml'), []);
  assert.doesNotMatch(lire('reacteur.yml').replace(/^\s*#.*$/gm, ''), /^\s*schedule:/m);

});

test('reacteur.yml écoute chaque événement qui remplace un minuteur, et envoie le bon type', () => {
  const reacteur = readFileSync(new URL('../.github/workflows/reacteur.yml', import.meta.url), 'utf8');
  const types = /issues:\s*\n\s*types:\s*\[([^\]]+)\]/.exec(reacteur);
  assert.ok(types);
  for (const a of ['closed', 'opened', 'edited', 'labeled', 'unlabeled']) assert.ok(types[1].split(',').map((x) => x.trim()).includes(a), `issues « ${a} » non écouté`);
  for (const evt of ['deployment_status:', 'issue_comment:', 'repository_dispatch:']) assert.ok(reacteur.includes(`\n  ${evt}`), `${evt} non écouté`);
  assert.match(reacteur, /repository_dispatch:\s*\n\s*types: \[fin-de-cron, note-lia, filet\]/);
  for (const t of ['tache_ouverte', 'deploiement', 'commentaire', 'fin_de_cron', 'note_lia']) assert.ok(reacteur.includes(`'${t}'`), `type ${t} non envoyé`);
  // La preuve ne se lit qu'à la fermeture ; une rafale d'étiquettes ne lance qu'un passage, sans jamais annuler une fermeture.
  assert.match(reacteur, /github\.event\.action == 'closed' && contains\(github\.event\.issue\.labels\.\*\.name, 'niveau:tâche'\)\n    permissions/);
  assert.match(reacteur, /cancel-in-progress: \$\{\{ github\.event_name == 'issues' && github\.event\.action != 'closed' \}\}/);
  // Un seul signal venu de l'app passe, nettoyé par le script ; la charge brute n'entre jamais dans le texte.
  assert.match(reacteur, /signal: \$\{\{ format\('\{0\}', github\.event\.client_payload\.note \|\| github\.event\.client_payload\.cron\) \}\}/);
});

// MoKarade/.github#625 : le commentaire tâche liée part sur l'événement de la PR ; il ne garde qu'un filet quotidien.
// Une PR modifiée (corps) ou rouverte lance le même balayage qu'une PR ouverte, et l'ancienne horloge toutes les 10 minutes ne revient pas.
test('commentaire tâche liée : une PR modifiée (corps) lance le balayage, et le workflow n’a plus qu’un filet quotidien hors minute ronde', () => {
  const lire = (f) => readFileSync(new URL(`../.github/workflows/${f}`, import.meta.url), 'utf8');

  const reacteur = lire('reacteur.yml');
  const types = /pull_request:\s*\n\s*types:\s*\[([^\]]+)\]/.exec(reacteur);
  assert.ok(types, 'types de pull_request introuvables dans reacteur.yml');
  const actions = types[1].split(',').map((x) => x.trim());
  for (const a of ['opened', 'reopened', 'ready_for_review', 'edited']) assert.ok(actions.includes(a), `reacteur.yml ne réveille pas sur « ${a} »`);
  // Tout ce qui n'est pas « closed » devient `pr_ouverte`, donc lance le commentaire tâche liée.
  assert.match(reacteur, /github\.event\.action == 'closed' && 'pr_fusionnee' \|\| 'pr_ouverte'/);

  const crons = [...lire('commentaire-tache-liee.yml').matchAll(/^\s*- cron: '([^']+)'/gm)].map((m) => m[1].split(' '));
  assert.equal(crons.length, 1, 'un seul cron attendu');
  const [minute, heure, jour, mois, semaine] = crons[0];
  assert.match(minute, /^\d+$/);
  assert.ok(!['0', '15', '30', '45'].includes(minute), `minute ronde « ${minute} »`);
  assert.match(heure, /^\d+$/);
  assert.deepEqual([jour, mois, semaine], ['*', '*', '*']);
});

// scripts/attend-marc.mjs (tâche #216) : testé ici, car ce fichier est celui que lance le workflow `tests.yml`.
const issueGeste = (extra = {}) => ({ number: 1, state: 'open', title: 'Garde-fou : la PR #12 attend un geste de Marc', labels: [{ name: 'qui:marc' }], ...extra });

test('attend-marc : prAttendantMarc : lit le numéro de la PR dans le titre de l’issue ouverte qui:marc, trié, sans doublon', () => {
  assert.deepEqual(prAttendantMarc([issueGeste(), issueGeste({ number: 2, title: 'Garde-fou : la PR #7 attend un geste de Marc' }), issueGeste({ number: 3 })]), [7, 12]);
});

test('attend-marc : prAttendantMarc : rejette autre titre, issue fermée, étiquette absente, pull request, entrée vide', () => {
  assert.deepEqual(prAttendantMarc([
    issueGeste({ title: 'Geste : fusionner la PR #12' }),
    issueGeste({ state: 'closed' }),
    issueGeste({ labels: [{ name: 'prio:1' }] }),
    issueGeste({ pull_request: {} }),
    issueGeste({ title: 'Garde-fou : la PR #12 attend un geste de Marc (bis)' }),
  ]), []);
  assert.deepEqual(prAttendantMarc(undefined), []);
  assert.equal(LABEL_ATTEND_MARC, 'qui:marc');
});

test('attend-marc : le relevé du Gantt (fetch.py) lit le même titre que le Réacteur : aucune dérive entre les deux expressions', () => {
  const py = readFileSync(new URL('../outils/gantt-pc/fetch.py', import.meta.url), 'utf8');
  const m = /^ATTEND_MARC = re\.compile\(r'(.+)'\)$/m.exec(py);
  assert.ok(m, 'ATTEND_MARC introuvable dans fetch.py');
  assert.equal(m[1], TITRE_ATTEND_MARC.source);
  assert.match(py, /l\['name'\] == 'qui:marc'/);
});

test('travaux : une tâche en-cours et sa PR ouverte comptent pour un, une PR sans tâche occupée pour un de plus', async () => {
  const n = (donnees) => travaux({ api: faux(donnees).api, depot: DEPOT });
  assert.equal(await n({}), 0);
  assert.equal(await n({ [`/repos/${DEPOT}/issues`]: issuesEnCours([12]), [`/repos/${DEPOT}/pulls`]: [prOuverte(30, 'Tâche : #12')] }), 1);
  assert.equal(await n({ [`/repos/${DEPOT}/issues`]: issuesEnCours([12]), [`/repos/${DEPOT}/pulls`]: [prOuverte(30, 'Tâche : #12'), prOuverte(31, 'Tâche : #13')] }), 2);
  assert.equal(await n({ [`/repos/${DEPOT}/issues`]: issuesEnCours([12, 13]) }), 2);
  assert.equal(await travaux({ api: faux({ [`/repos/${DEPOT}/pulls`]: new Error('HTTP 403') }).api, depot: DEPOT }), 0, 'lecture ratée : libre');
});

test('signeLibre : libre, une place libre, rien', () => {
  assert.equal(signeLibre('D', 0), 'D libre');
  assert.equal(signeLibre('D', 1), 'D : une place libre');
  assert.equal(signeLibre('D', 2), '');
  assert.equal(signeLibre('D', 3), '');
});

test('PR fusionnée : une tâche acceptée seule le dit dans le réveil et n’a plus de « preuve à poser »', async () => {
  const { api } = faux({
    '/repos/MoKarade/JobAI/pulls/7': { body: 'Avant…\nTâche : #115', user: humain },
    '/repos/MoKarade/JobAI/issues/115': tache({ state: 'closed' }),
  });
  const appels = [];
  const accepter = async (arg) => {
    appels.push(arg);
    return { statut: 'acceptee', motifs: [], tache: 115 };
  };
  const d = await decider({ api, evt: { type: 'pr_fusionnee', depot: 'MoKarade/JobAI', pr: '7', deploiement: 'aucun', workflows: 'deploy.yml, b.yml' }, accepter });
  assert.equal(d.motif, 'RÉACTEUR : MoKarade/JobAI libre ; PR #7 fusionnée ; tâche MoKarade/JobAI#115 acceptée seule');
  assert.equal(d.acceptation.statut, 'acceptee');
  assert.deepEqual(appels, [{ api, depot: 'MoKarade/JobAI', numeroPr: 7, config: { deploiement: 'aucun', workflows: ['deploy.yml', 'b.yml'] } }]);
});

test('PR fusionnée : l’acceptation automatique qui échoue ne retarde ni n’empêche la suite', async () => {
  const { api } = faux({
    '/repos/MoKarade/JobAI/pulls/7': { body: 'Avant…\nTâche : #115', user: humain },
    '/repos/MoKarade/JobAI/issues/115': tache(),
    '/repos/MoKarade/JobAI/issues/115/comments': [],
  });
  const d = await decider({ api, evt: { type: 'pr_fusionnee', depot: 'MoKarade/JobAI', pr: '7' }, accepter: async () => { throw new Error('HTTP 403 sur POST'); } });
  assert.equal(d.motif, 'RÉACTEUR : MoKarade/JobAI libre ; PR #7 fusionnée');
  assert.deepEqual(d.acceptation, { statut: 'erreur', motifs: ['HTTP 403 sur POST'] });
  // un refus ordinaire (« ignoree ») ne sort pas de la décision
  const e = await decider({ api, evt: { type: 'pr_fusionnee', depot: 'MoKarade/JobAI', pr: '7' }, accepter: async () => ({ statut: 'ignoree', motifs: ['x'] }) });
  assert.equal('acceptation' in e, false);
});

test('preuves différées : lues sur la PR fusionnée, la tâche fermée et le filet, jamais sur une CI rouge ; rien de neuf, le résultat ne change pas', async () => {
  const appels = [];
  const accepterDifferees = async (o) => { appels.push(o); return { acceptees: [201], ignorees: [] }; };
  const jamais = async () => ({ statut: 'ignoree', motifs: [] });
  for (const evt of [{ type: 'pr_fusionnee', pr: '7' }, { type: 'tache_fermee', issue: '90', raison: 'completed' }, { type: 'filet' }]) {
    const d = await decider({ api: faux().api, evt: { depot: 'MoKarade/JobAI', ...evt }, accepter: jamais, accepterDifferees, jetonLecture: 'jeton' });
    assert.deepEqual(d.differees, { acceptees: [201], ignorees: [] }, evt.type);
  }
  assert.equal(appels.length, 3);
  assert.equal(appels[0].jeton, 'jeton');
  assert.ok(appels[2].lues > appels[0].lues, 'le filet lit plus de tâches qu’un événement');
  assert.equal(appels[0].config.deploiement, 'vercel');
  const avant = appels.length;
  const rouge = await decider({ api: faux().api, evt: { type: 'pr_ouverte', depot: 'MoKarade/JobAI', pr: '7' }, accepterDifferees });
  assert.deepEqual(rouge, { action: 'balayer' });
  assert.equal(appels.length, avant);
  const rien = await decider({ api: faux().api, evt: { type: 'tache_fermee', depot: 'MoKarade/JobAI', issue: '90', raison: 'completed' }, accepterDifferees: async () => ({ acceptees: [], ignorees: [{ tache: 5, motifs: ['x'] }] }) });
  assert.deepEqual(rien, { action: 'lancer', motif: 'RÉACTEUR : MoKarade/JobAI libre ; tâche MoKarade/JobAI#90 fermée' });
});

test('preuves différées : une erreur est un avertissement, la suite part quand même', async () => {
  const journal = [];
  const api = async () => null;
  const r = await traiter({ api, evt: { type: 'tache_fermee', depot: 'MoKarade/JobAI', issue: '90', raison: 'completed' }, jetonReveil: 'x', journal: (l) => journal.push(l), accepterDifferees: async () => { throw new Error('HTTP 502'); } });
  assert.equal(r.action, 'lancer');
  assert.ok(journal.some((l) => l.startsWith('::warning::') && l.includes('HTTP 502')));
  const bon = [];
  await traiter({ api, evt: { type: 'tache_fermee', depot: 'MoKarade/JobAI', issue: '90', raison: 'completed' }, jetonReveil: 'x', journal: (l) => bon.push(l), accepterDifferees: async () => ({ acceptees: [201], ignorees: [] }) });
  assert.ok(bon.some((l) => l.includes('#201') && l.includes('acceptée automatiquement')));
});

// ---- La file du dépôt à l'événement (tâche MoKarade/.github#711) : le réveil nomme la suivante, par son numéro seulement.
const LISTE = `/repos/${DEPOT}/issues?state=open&per_page=100&page=1`;
const tachePrete = (n, extra = {}) => ({
  number: n, title: `Titre secret de la tâche ${n}`, state: 'open', created_at: '2026-10-28T10:00:00Z', html_url: `https://github.com/${DEPOT}/issues/${n}`,
  labels: [{ name: 'niveau:tâche' }], body: `**Fini quand** : la route répond 200\n\n**Fichiers touchés** :\n- \`src/t${n}.mjs\`\n\n**Attend** : aucune\n`, ...extra,
});

test('tâche fermée : le réveil nomme la tâche suivante par son numéro, jamais par son titre (règle .github#136)', async () => {
  const api = faux({ [LISTE]: [tachePrete(12), tachePrete(14)] }).api;
  const d = await decider({ api, evt: { type: 'tache_fermee', depot: DEPOT, issue: '90', raison: 'completed' } });
  assert.equal(d.action, 'lancer');
  assert.equal(d.motif, `RÉACTEUR : ${DEPOT} libre ; suivante : #12 ; tâche ${DEPOT}#90 fermée`);
  assert.doesNotMatch(d.motif, /Titre secret/);
  assert.equal(d.file.suivante, 12);
});

test('tâche fermée : dépôt libre sans tâche prenable, dépendance illisible ou lecture en panne = le réveil d’avant, sans suivante', async () => {
  const evt = { type: 'tache_fermee', depot: DEPOT, issue: '90', raison: 'completed' };
  const sans = await decider({ api: faux({ [LISTE]: [] }).api, evt });
  assert.equal(sans.motif, `RÉACTEUR : ${DEPOT} libre ; tâche ${DEPOT}#90 fermée`);
  assert.equal(sans.file, undefined);
  const illisible = tachePrete(12, { body: tachePrete(12).body.replace('aucune', 'MoKarade/Prive#5') });
  const dep = await decider({ api: faux({ [LISTE]: [illisible] }).api, evt });
  assert.equal(dep.motif, `RÉACTEUR : ${DEPOT} libre ; tâche ${DEPOT}#90 fermée`);
  const panne = await decider({ api: faux({ [LISTE]: new Error('HTTP 502') }).api, evt });
  assert.equal(panne.motif, `RÉACTEUR : ${DEPOT} libre ; tâche ${DEPOT}#90 fermée`);
});

test('PR fusionnée : la tâche qu’elle vient de livrer ne tient plus de place, la suivante est nommée', async () => {
  const livree = tachePrete(40, { labels: [{ name: 'niveau:tâche' }, { name: 'en-cours' }] });
  const donnees = {
    [`/repos/${DEPOT}/pulls/7`]: { number: 7, body: 'Tâche : #40', user: humain, merged_at: '2026-10-28T20:00:00Z' },
    [`/repos/${DEPOT}/issues/40`]: tache({ number: 40 }),
    [LISTE]: [livree, tachePrete(12)],
  };
  const d = await decider({ api: faux(donnees).api, evt: { type: 'pr_fusionnee', depot: DEPOT, pr: '7' }, accepter: async () => ({ statut: 'ignoree' }) });
  assert.equal(d.action, 'lancer');
  assert.match(d.motif, /^RÉACTEUR : .* ; suivante : #12 ; PR #7 fusionnée/);
  assert.doesNotMatch(d.motif, /Titre secret/);
});

test('le Réacteur nomme la suivante sans que le PC tourne : aucune lecture de prochaines.json ni de Drive', () => {
  const source = readFileSync(new URL('./file-depot.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from 'node:fs'|googleapis|from '.*drive/i);
  assert.doesNotMatch(source, /readFileSync|existsSync/);
});

// ---- Les événements ajoutés pour que rien n'attende un minuteur (tâche MoKarade/.github#712).
const evtOuverte = (issue = '12') => ({ type: 'tache_ouverte', depot: DEPOT, issue });

test('tâche ouverte : si elle devient la suivante d’un dépôt qui a une place, le Coordinateur le sait, par son numéro', async () => {
  const donnees = { [LISTE]: [tachePrete(12)], [`/repos/${DEPOT}/issues/12`]: tachePrete(12), [BOITE]: [] };
  const d = await decider({ api: faux(donnees).api, evt: evtOuverte(), maintenant: new Date('2026-10-28T21:00:00Z') });
  assert.equal(d.action, 'lancer');
  assert.equal(d.motif, `RÉACTEUR : ${DEPOT} libre ; suivante : #12 ; tâche ${DEPOT}#12 prête`);
  assert.doesNotMatch(d.motif, /Titre secret/);
});

test('tâche ouverte : pas la suivante, dépôt plein, tâche fermée ou autre chose qu’une tâche = personne n’est réveillé', async () => {
  const quand = new Date('2026-10-28T21:00:00Z');
  const rien = async (donnees, evt = evtOuverte()) => { const d = await decider({ api: faux(donnees).api, evt, maintenant: quand }); assert.equal(d.action, 'rien'); return d; };
  await rien({ [LISTE]: [tachePrete(12), tachePrete(14)], [`/repos/${DEPOT}/issues/14`]: tachePrete(14) }, evtOuverte('14'));
  const enCours = (n, f) => tachePrete(n, { labels: [{ name: 'niveau:tâche' }, { name: 'en-cours' }], body: `**Fini quand** : ok\n\n**Fichiers touchés** :\n- \`${f}\`\n\n**Attend** : aucune\n` });
  const deux = [enCours(50, 'app/a.ts'), enCours(51, 'app/b.ts')];
  await rien({ [LISTE]: [...deux, tachePrete(12)], [`/repos/${DEPOT}/issues?labels=en-cours&state=open&per_page=30`]: deux, [`/repos/${DEPOT}/issues/12`]: tachePrete(12) });
  await rien({ [LISTE]: [], [`/repos/${DEPOT}/issues/12`]: tachePrete(12, { state: 'closed' }) });
  await rien({ [LISTE]: [], [`/repos/${DEPOT}/issues/12`]: { number: 12, state: 'open', labels: [{ name: 'bug' }] } });
});

test('verifierAliasVercel : même commit -> valide ; commit différent -> fige ; sans commit -> non_couvert ; injoignable -> erreur', async () => {
  const apps = [{ nom: 'emploi', depot: 'MoKarade/JobAI', sante: 'https://emploi.hubperso.com/api/sante' }];
  const rep = (body) => ({ ok: true, text: async () => typeof body === 'string' ? body : JSON.stringify(body) });

  // Même commit -> valide
  const v1 = await verifierAliasVercel({ depot: 'MoKarade/JobAI', sha: 'abc12345678', apps, fetchImpl: async () => rep({ ok: true, commit: 'abc1234' }), pause: async () => {} });
  assert.equal(v1.statut, 'valide');
  assert.equal(v1.commitServi, 'abc1234');

  // apps non fourni : lecture via api (contents/surveillance/apps.json en base64)
  const fApp = faux({
    '/repos/MoKarade/.github/contents/surveillance/apps.json': {
      content: Buffer.from(JSON.stringify(apps)).toString('base64'),
    },
  });
  const vApi = await verifierAliasVercel({
    api: fApp.api,
    depot: 'MoKarade/JobAI',
    sha: 'abc12345678',
    fetchImpl: async () => rep({ ok: true, commit: 'abc1234' }),
    pause: async () => {},
  });
  assert.equal(vApi.statut, 'valide');

  // Propagation : 1er essai différent, 2e essai même commit -> valide
  let n = 0;
  const vPropag = await verifierAliasVercel({
    depot: 'MoKarade/JobAI',
    sha: 'abc12345678',
    apps,
    fetchImpl: async () => rep({ ok: true, commit: ++n === 1 ? 'old1234' : 'abc1234' }),
    pause: async () => {},
  });
  assert.equal(vPropag.statut, 'valide');

  // Commit différent aux 2 essais -> fige
  const v2 = await verifierAliasVercel({ depot: 'MoKarade/JobAI', sha: 'abc12345678', apps, fetchImpl: async () => rep({ ok: true, commit: 'old1234' }), pause: async () => {} });
  assert.equal(v2.statut, 'fige');
  assert.equal(v2.commitServi, 'old1234');
  assert.equal(v2.commitDeploye, 'abc1234');

  // Champ commit absent -> non_couvert
  const v3 = await verifierAliasVercel({ depot: 'MoKarade/JobAI', sha: 'abc12345678', apps, fetchImpl: async () => rep({ ok: true }), pause: async () => {} });
  assert.equal(v3.statut, 'non_couvert');

  // Domaine injoignable (erreur fetch) -> erreur (jamais vert)
  const v4 = await verifierAliasVercel({ depot: 'MoKarade/JobAI', sha: 'abc12345678', apps, fetchImpl: async () => { throw new Error('ENOTFOUND'); }, pause: async () => {} });
  assert.equal(v4.statut, 'erreur');

  // Corps invalide -> erreur (jamais vert)
  const v5 = await verifierAliasVercel({ depot: 'MoKarade/JobAI', sha: 'abc12345678', apps, fetchImpl: async () => rep('Erreur serveur 500 html'), pause: async () => {} });
  assert.equal(v5.statut, 'erreur');
});

test('verifierAliasVercel : un commit servi plus récent que le déploiement n\'est pas un alias figé ; le doute reste « figé » (#864)', async () => {
  const apps = [{ nom: 'emploi', depot: 'MoKarade/JobAI', sante: 'https://emploi.hubperso.com/api/sante' }];
  const rep = (body) => ({ ok: true, text: async () => JSON.stringify(body) });
  const servi = (commit) => async () => rep({ ok: true, commit });
  const compare = 'abc12345678...new1234';
  const lancer = (api, fetchImpl) => verifierAliasVercel({ api, depot: 'MoKarade/JobAI', sha: 'abc12345678', apps, fetchImpl, pause: async () => {}, journal: () => {} });
  // `ahead` : le domaine sert un commit descendant du déploiement -> valide, pas d'incident
  const ahead = await lancer(faux({ [`/repos/MoKarade/JobAI/compare/${compare}`]: { status: 'ahead' } }).api, servi('new1234'));
  assert.deepEqual(ahead, { statut: 'valide', commitServi: 'new1234', commitDeploye: 'abc1234', plusRecent: true });
  // `behind`, `diverged`, introuvable (null), erreur de l'API : figé
  for (const reponse of [{ status: 'behind' }, { status: 'diverged' }, null, new Error('HTTP 404')]) {
    const r = await lancer(faux({ [`/repos/MoKarade/JobAI/compare/${compare}`]: reponse }).api, servi('new1234'));
    assert.equal(r.statut, 'fige', JSON.stringify(reponse));
  }
  // même commit : aucun appel compare
  const appels = [];
  const identique = await lancer(async (...a) => { appels.push(a); return null; }, servi('abc1234'));
  assert.equal(identique.statut, 'valide');
  assert.deepEqual(appels, []);
});

test('déploiement : un déploiement plus récent déjà en ligne n\'ouvre aucun incident', async () => {
  const apps = [{ nom: 'emploi', depot: 'MoKarade/JobAI', sante: 'https://emploi.hubperso.com/api/sante' }];
  const f = faux({ '/repos/MoKarade/JobAI/compare/old12345678...new1234': { status: 'ahead' } });
  const d = await decider({
    api: f.api,
    evt: { type: 'deploiement', depot: 'MoKarade/JobAI', sha: 'old12345678' },
    apps,
    fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ ok: true, commit: 'new1234' }) }),
    pause: async () => {},
    journal: () => {},
  });
  assert.equal(d.alias.statut, 'valide');
  assert.equal(f.ecritures.find((e) => e.chemin === '/repos/MoKarade/JobAI/issues'), undefined);
  assert.equal(d.action, 'rien');
});

test('déploiement : alias figé ouvre un incident avec le remède, sans réveiller personne', async () => {
  const apps = [{ nom: 'emploi', depot: 'MoKarade/JobAI', sante: 'https://emploi.hubperso.com/api/sante' }];
  const rep = (body) => ({ ok: true, text: async () => JSON.stringify(body) });
  const f = faux();
  const d = await decider({
    api: f.api,
    evt: { type: 'deploiement', depot: 'MoKarade/JobAI', sha: 'new1234567' },
    apps,
    fetchImpl: async () => rep({ ok: true, commit: 'old1234' }),
    pause: async () => {},
  });

  assert.equal(d.action, 'rien');
  assert.equal(d.alias.statut, 'fige');
  assert.match(d.raison, /alias figé sur old1234, dernier READY new1234/);
  assert.match(d.raison, /promouvoir le dernier READY avec l’outil Vercel de la session, puis relire \/api\/sante/);
  const ecritureIssue = f.ecritures.find((e) => e.chemin === '/repos/MoKarade/JobAI/issues');
  assert.ok(ecritureIssue);
  assert.equal(ecritureIssue.corps.title, 'alias figé sur old1234, dernier READY new1234');
  assert.deepEqual(ecritureIssue.corps.labels, ['incident']);
  assert.match(ecritureIssue.corps.body, /promouvoir le dernier READY/);
});

test('déploiement réussi : la tâche de la PR fusionnée sur ce commit s’accepte seule, et le réveil le dit', async () => {
  const donnees = { [`/repos/${DEPOT}/commits/abc1234/pulls`]: [{ number: 7, merged_at: '2026-10-28T20:00:00Z' }], [LISTE]: [tachePrete(12)] };
  const appels = [];
  const accepter = async (a) => { appels.push(a); return { statut: 'acceptee', tache: 40 }; };
  const d = await decider({
    api: faux(donnees).api,
    evt: { type: 'deploiement', depot: DEPOT, sha: 'abc1234' },
    accepter,
    maintenant: new Date('2026-10-28T21:00:00Z'),
    pause: async () => {},
    fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ ok: true, commit: 'abc1234' }) }),
  });
  assert.equal(appels[0].numeroPr, 7);
  assert.equal(appels[0].essais, 1, 'un événement n’attend pas : le déploiement est déjà là');
  assert.equal(d.action, 'lancer');
  assert.equal(d.motif, `RÉACTEUR : ${DEPOT} libre ; suivante : #12 ; tâche ${DEPOT}#40 acceptée seule`);
});

test('déploiement réussi : rien à accepter = personne n’est réveillé', async () => {
  const donnees = { [`/repos/${DEPOT}/commits/abc1234/pulls`]: [{ number: 7, merged_at: '2026-10-28T20:00:00Z' }], [`/repos/${DEPOT}/commits/abc1234/pulls`]: [{ number: 7, merged_at: '2026-10-28T20:00:00Z' }, { number: 8, merged_at: null }] };
  const d = await decider({
    api: faux(donnees).api,
    evt: { type: 'deploiement', depot: DEPOT, sha: 'abc1234' },
    accepter: async () => ({ statut: 'ignoree' }),
    pause: async () => {},
    fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ ok: true, commit: 'abc1234' }) }),
  });
  assert.equal(d.action, 'rien');
  const panne = await decider({
    api: faux({ [`/repos/${DEPOT}/commits/abc1234/pulls`]: new Error('HTTP 502') }).api,
    evt: { type: 'deploiement', depot: DEPOT, sha: 'abc1234' },
    accepter: async () => ({ statut: 'ignoree' }),
    pause: async () => {},
    fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ ok: true, commit: 'abc1234' }) }),
  });
  assert.equal(panne.action, 'rien');
});

test('commentaire et fin de cron : la preuve différée due se lit ; ce qu’elle accepte libère une place et le réveil le dit', async () => {
  const donnees = { [LISTE]: [tachePrete(12)] };
  for (const type of ['commentaire', 'fin_de_cron']) {
    const sans = await decider({ api: faux(donnees).api, evt: { type, depot: DEPOT, signal: 'apprentissage' }, accepterDifferees: async () => ({ acceptees: [], ignorees: [] }) });
    assert.equal(sans.action, 'rien');
    const avec = await decider({ api: faux(donnees).api, evt: { type, depot: DEPOT, signal: 'apprentissage' }, accepterDifferees: async () => ({ acceptees: [201], ignorees: [] }), maintenant: new Date('2026-10-28T21:00:00Z') });
    assert.equal(avec.action, 'lancer', type);
    assert.equal(avec.motif, `RÉACTEUR : ${DEPOT} libre ; suivante : #12 ; tâche ${DEPOT}#201 acceptée seule`);
  }
});

test('note LIA : le type est accepté mais ne réveille plus personne', async () => {
  const f = faux({});
  const d = await decider({ api: f.api, evt: { type: 'note_lia', depot: DEPOT, signal: 'n-4521' } });
  assert.deepEqual(d, { action: 'rien', raison: 'note LIA : plus de réveil du Coordinateur' });
  assert.deepEqual(f.ecritures, []);
});


// Hubperso a deux fils : la boîte de la Page chantier (app-template#210) reçoit les tâches qui touchent le chantier (tâche MoKarade/.github#769).

const HUB = 'MoKarade/Hubperso';
const issueChantier = { labels: [{ name: 'niveau:tâche' }], body: '**Avant** : x\n**Fichiers touchés** :\n- `app/chantier/page.tsx`\n- `tests/chantier.test.ts`\n**Source** : y' };
const issueDepot = { labels: [{ name: 'niveau:tâche' }], body: '**Fichiers touchés** :\n- `lib/acces.ts`\n**Source** : un mot chantier/ ici ne compte pas' };

// Repli sans jeton (tâche MoKarade/.github#772) : la boîte locale du dépôt, commentée avec le jeton du job.

const MEM = 'MoKarade/MemoryAI';
const boiteLocale = (extra = {}) => ({ number: 440, draft: true, head: { ref: BRANCHE_BOITE_LOCALE }, ...extra });

// Classe B (scripts/fini-quand.mjs, scripts/preuve-page.mjs, tâche MoKarade/.github#781).
const FINI_B = '**Fini quand** (classe B) : la page des totaux s’affiche.\n**Lecture de page** : GET /totaux → 200, contient « Total »';

test('preuve_page : lecture refusée = la tâche reste ouverte, personne n’est réveillé ; sans numéro = rien ; acceptée = dépôt libre, suivante nommée', async () => {
  const { api } = faux();
  const echec = await decider({ api, evt: { type: 'preuve_page', depot: 'MoKarade/JobAI', issue: '115', pr: '7', raison: 'echec' } });
  assert.equal(echec.action, 'rien');
  assert.match(echec.raison, /preuve de page MoKarade\/JobAI#115 non acceptée/);
  assert.equal((await decider({ api, evt: { type: 'preuve_page', depot: 'MoKarade/JobAI', issue: '', raison: 'echec' } })).action, 'rien');
  const ok = await decider({ api, evt: { type: 'preuve_page', depot: 'MoKarade/JobAI', issue: '115', pr: '7', raison: 'acceptee' } });
  assert.equal(ok.action, 'lancer');
  assert.match(ok.motif, /tâche MoKarade\/JobAI#115 acceptée seule/);
});

// Routine « Prendre une tâche » (tâche MoKarade/.github#860) : lancée par le Réacteur pour la suivante d'un dépôt sans fil à l'écoute.
const URL_ROUTINE = 'https://api.anthropic.com/v1/claude_code/routines/trig_01ABCDEFGHJKLMNOPQRSTUVW/fire';
const routineTest = { url: URL_ROUTINE, token: 'jeton-de-test' };
const donneesRoutine = {
  '/repos/MoKarade/app-template/issues/212': { state: 'open', labels: [{ name: 'niveau:tâche' }] },
  '/repos/MoKarade/app-template/issues/212/comments': [],
};
const decisionPrete = (extra = {}) => ({ action: 'lancer', motif: construireMotif(['MoKarade/app-template libre', 'suivante : #212']), file: { statut: 'libre', suivante: 212 }, ...extra });
function fauxLancement(statut = 200) {
  const appels = [];
  const appeler = async (url, options) => { appels.push({ url, options }); return { ok: statut < 300, status: statut, json: async () => ({ claude_code_session_url: 'https://claude.ai/code/session_01X' }) }; };
  return { appeler, appels };
}

test('routine : suivante prête dans un dépôt sans fil → une session lancée et la ligne « routine : #n lancée » dans le message de la décision', async () => {
  const { api } = faux(donneesRoutine);
  const { appeler, appels } = fauxLancement();
  const r = await traiter({ boites: {}, api, appeler, routine: routineTest, evt: { type: 'tache_fermee', depot: 'MoKarade/app-template', issue: '9' }, decisionImposee: decisionPrete(), jetonReveil: 'jeton', journal: () => {} });
  assert.equal(appels.length, 1);
  assert.deepEqual(JSON.parse(appels[0].options.body), { text: 'MoKarade/app-template#212' });
  assert.ok(r.motif.endsWith('routine : #212 lancée'));
  assert.equal(r.routine.n, 212);
});

test('routine : sans secrets, le message est identique et aucun appel ne part', async () => {
  const { api } = faux(donneesRoutine);
  const { appeler, appels } = fauxLancement();
  const r = await traiter({ boites: {}, api, appeler, routine: null, evt: { type: 'tache_fermee', depot: 'MoKarade/app-template', issue: '9' }, decisionImposee: decisionPrete(), jetonReveil: 'jeton', journal: () => {} });
  assert.equal(appels.length, 0);
  assert.equal(r.motif, decisionPrete().motif);
});

test('routine : dépôt dont un fil écoute la boîte (CarAI) → la session neuve part quand même, une seule fois (tâche #871)', async () => {
  const { api, ecritures } = faux({ '/repos/MoKarade/CarAI/issues/212': { state: 'open', labels: [{ name: 'niveau:tâche' }] }, '/repos/MoKarade/CarAI/issues/212/comments': [] });
  const { appeler, appels } = fauxLancement();
  const r = await traiter({ boites: {}, api, appeler, routine: routineTest, evt: { type: 'tache_fermee', depot: 'MoKarade/CarAI', issue: '9' }, decisionImposee: decisionPrete(), jetonReveil: 'jeton', journal: () => {} });
  assert.equal(appels.length, 1);
  assert.deepEqual(JSON.parse(appels[0].options.body), { text: 'MoKarade/CarAI#212' });
  assert.ok(r.motif.endsWith('routine : #212 lancée'));
  assert.equal(r.routine.n, 212);
});

test('routine : file occupée ou tâche écartée par une étiquette (en-cours) dans un dépôt avec fil → aucun appel (tâche #871)', async () => {
  for (const [file, labels] of [[{ statut: 'occupe', suivante: 212 }, ['niveau:tâche']], [{ statut: 'libre', suivante: 212 }, ['niveau:tâche', 'en-cours']]]) {
    const { api } = faux({ '/repos/MoKarade/CarAI/issues/212': { state: 'open', labels: labels.map((name) => ({ name })) }, '/repos/MoKarade/CarAI/issues/212/comments': [] });
    const { appeler, appels } = fauxLancement();
    await traiter({ boites: {}, api, appeler, routine: routineTest, evt: { type: 'tache_fermee', depot: 'MoKarade/CarAI', issue: '9' }, decisionImposee: decisionPrete({ file }), jetonReveil: 'jeton', journal: () => {} });
    assert.equal(appels.length, 0);
  }
});

test('routine : lancement refusé (500) → avertissement, message inchangé, aucune exception', async () => {
  const { api } = faux(donneesRoutine);
  const { appeler } = fauxLancement(500);
  const lignes = [];
  const r = await traiter({ boites: {}, api, appeler, routine: routineTest, evt: { type: 'tache_fermee', depot: 'MoKarade/app-template', issue: '9' }, decisionImposee: decisionPrete(), jetonReveil: 'jeton', journal: (l) => lignes.push(l) });
  assert.ok(lignes.some((l) => l.startsWith('::warning::Routine')));
  assert.equal(r.motif, decisionPrete().motif);
  assert.equal(r.routine, undefined);
});

test('routine : session déjà lancée (marqueur récent, `en-cours` pas encore posé) → aucun second appel, le message le dit', async () => {
  const marqueur = { user: { login: 'github-actions[bot]', type: 'Bot' }, body: '<!-- routine-lancee -->\nlancée', created_at: new Date(Date.now() - 3600 * 1000).toISOString() };
  const { api, ecritures } = faux({ ...donneesRoutine, '/repos/MoKarade/app-template/issues/212/comments': [marqueur] });
  const { appeler, appels } = fauxLancement();
  const r = await traiter({ boites: {}, api, appeler, routine: routineTest, evt: { type: 'tache_fermee', depot: 'MoKarade/app-template', issue: '9' }, decisionImposee: decisionPrete(), jetonReveil: 'jeton', journal: () => {} });
  assert.equal(appels.length, 0);
  assert.ok(r.motif.endsWith('routine : #212 déjà lancée'));
  assert.equal(r.routine.n, 212);
});
