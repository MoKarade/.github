import './places-deux.mjs';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { LABEL_ATTEND_MARC, TITRE_ATTEND_MARC, prAttendantMarc } from './attend-marc.mjs';
import { DEPOT_BOITE, DEPOT_GITHUB, LONGUEUR_MAX, PREFIXE, WORKFLOW_BOITE, TYPES_BALAYAGE, WORKFLOWS_BALAYAGE, WORKFLOWS_GARDE_FOU_ROUGE, WORKFLOWS_PR_OUVERTE, construireMotif, decider, estPanneRunner, heureQuebec, occupations, travaux, signeLibre, preuveAPoser, rougeDepuis, traiter } from './reveil-reacteur.mjs';

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

test('tâche fermée : deux places prises = aucun réveil ; libre = « libre » ; une place = « une place libre » ; abandon réveille toujours, sans « libre » si occupé', async () => {
  const occupe = faux({ [`/repos/${DEPOT}/issues`]: issuesEnCours([20, 21]) });
  const evt = { type: 'tache_fermee', depot: DEPOT, issue: '90', raison: 'completed' };
  assert.deepEqual(await decider({ api: occupe.api, evt }), { action: 'rien', raison: 'dépôt encore occupé' });
  assert.equal((await decider({ api: faux().api, evt })).motif, `RÉACTEUR : ${DEPOT} libre ; tâche ${DEPOT}#90 fermée`);
  const une = await decider({ api: faux({ [`/repos/${DEPOT}/issues`]: issuesEnCours([20]) }).api, evt });
  assert.equal(une.motif, `RÉACTEUR : ${DEPOT} : une place libre ; tâche ${DEPOT}#90 fermée`);
  const abandon = await decider({ api: occupe.api, evt: { ...evt, raison: 'not_planned' } });
  assert.equal(abandon.motif, `RÉACTEUR : tâche ${DEPOT}#90 fermée (abandonnée : vérifier la raison)`);
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

test('PR fusionnée : dépôt occupé mais preuve à poser = réveil, sans la ligne « libre »', async () => {
  const { api } = faux({
    [`/repos/${DEPOT}/pulls/7`]: { body: 'Tâche : #115', user: humain },
    [`/repos/${DEPOT}/issues/115`]: tache(),
    [`/repos/${DEPOT}/issues/115/comments`]: [],
    [`/repos/${DEPOT}/issues`]: issuesEnCours([21, 22]),
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

// MoKarade/.github#633 : le Garde-fou d'une PR qui finit en échec lance la relecture IA, et seulement elle (plus de minuteur, #626).
test('garde_fou_rouge : lance seulement relecture-ia.yml, ne commente rien sur la boîte et ne réveille personne', async () => {
  const { api, ecritures } = faux();
  const lignes = [];
  const r = await traiter({ api, evt: { type: 'garde_fou_rouge', depot: 'MoKarade/CarAI', pr: '12', evenement: 'pull_request_target' }, jetonReveil: 'jeton', journal: (l) => lignes.push(l) });
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
  await traiter({ api: sansJeton.api, evt: { type: 'garde_fou_rouge', depot: 'MoKarade/CarAI', pr: '12' }, jetonReveil: '', journal: (l) => lignes.push(l) });
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
  assert.match(lire('reveil-reacteur.yml'), /pr_fusionnee \| pr_ouverte \| tache_fermee \| ci_rouge \| garde_fou_rouge \| filet/);
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

// scripts/attend-marc.mjs (tâche #216) : testé ici, car ce fichier est celui que lance le contrôle `tests-reveil-reacteur`.
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

test('PR fusionnée : l’acceptation automatique qui échoue ne retarde ni n’empêche le réveil', async () => {
  const { api } = faux({
    '/repos/MoKarade/JobAI/pulls/7': { body: 'Avant…\nTâche : #115', user: humain },
    '/repos/MoKarade/JobAI/issues/115': tache(),
    '/repos/MoKarade/JobAI/issues/115/comments': [],
  });
  const d = await decider({ api, evt: { type: 'pr_fusionnee', depot: 'MoKarade/JobAI', pr: '7' }, accepter: async () => { throw new Error('HTTP 403 sur POST'); } });
  assert.equal(d.motif, 'RÉACTEUR : MoKarade/JobAI libre ; PR #7 fusionnée ; preuve à poser sur MoKarade/JobAI#115');
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
  assert.deepEqual(rien, { action: 'reveiller', motif: 'RÉACTEUR : MoKarade/JobAI libre ; tâche MoKarade/JobAI#90 fermée' });
});

test('preuves différées : une erreur est un avertissement, le réveil part quand même', async () => {
  const journal = [];
  const envoyes = [];
  const api = async (methode, chemin, corps) => { if (methode === 'POST') { envoyes.push(chemin); return null; } return null; };
  const r = await traiter({ api, evt: { type: 'tache_fermee', depot: 'MoKarade/JobAI', issue: '90', raison: 'completed' }, jetonReveil: 'x', journal: (l) => journal.push(l), accepterDifferees: async () => { throw new Error('HTTP 502'); } });
  assert.equal(r.reveille, true);
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
  assert.equal(d.action, 'reveiller');
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
  assert.equal(d.action, 'reveiller');
  assert.match(d.motif, /^RÉACTEUR : .* ; suivante : #12 ; PR #7 fusionnée/);
  assert.doesNotMatch(d.motif, /Titre secret/);
});

test('le Réacteur nomme la suivante sans que le PC tourne : aucune lecture de prochaines.json ni de Drive', () => {
  const source = readFileSync(new URL('./file-depot.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from 'node:fs'|googleapis|from '.*drive/i);
  assert.doesNotMatch(source, /readFileSync|existsSync/);
});

// ---- Jules à l'événement (tâche MoKarade/.github#704) : la première tâche réservée est confiée par le Réacteur, sans le tour du PC.
const corpsJules = (n) => [
  ['Avant', '`lib/format.ts` n\'a aucun test.'], ['Après', 'Un test couvre `formatKm`.'], ['Fini quand', '`npm run test -- format` affiche 3 tests verts.'],
  ['Fichiers permis', '(aucun autre) :\n- `lib/format.test.ts`'], ['À faire', '1. Écrire trois cas.'], ['À ne pas faire', 'Ne pas modifier `lib/format.ts`.'],
  ['Vérifier', '`npm run test -- format`'], ['À citer dans la PR', `\`Tâche : #${n}\` ; sujet de commit : \`test: ajouter les cas\``],
].map(([k, v]) => (k === 'Fichiers permis' ? `**${k}** ${v}` : `**${k}** : ${v}`)).join('\n\n') + '\n\n**Attend** : aucune\n';
const reservee = (n = 31, extra = {}) => ({
  number: n, title: `Titre secret ${n}`, state: 'open', created_at: '2026-10-28T10:00:00Z', html_url: `https://github.com/${DEPOT}/issues/${n}`,
  labels: [{ name: 'niveau:tâche' }, { name: 'faisable-jules' }], body: corpsJules(n), ...extra,
});
const donneesJules = (extra = {}, depot = DEPOT) => ({
  [`/repos/${depot}/issues?state=open&per_page=100&page=1`]: [reservee()],
  [`/repos/${depot}/issues/31`]: reservee(),
  [`/repos/${depot}/issues/31/comments`]: [],
  '/search/issues': { total_count: 0 },
  ...extra,
});
const ecritureJules = (ecritures) => ecritures.filter((e) => /\/issues\/31\/(labels|comments)$/.test(e.chemin));

test('tâche fermée : la tâche réservée est confiée à Jules par le Réacteur, et le réveil le dit par son numéro', async () => {
  const f = faux(donneesJules());
  const d = await decider({ api: f.api, evt: { type: 'tache_fermee', depot: DEPOT, issue: '90', raison: 'completed' } });
  assert.equal(d.jules.n, 31);
  assert.match(d.motif, /jules : #31 confiée/);
  assert.doesNotMatch(d.motif, /Titre secret/);
  const e = ecritureJules(f.ecritures);
  assert.equal(e[0].chemin, `/repos/${DEPOT}/issues/31/labels`);
  assert.deepEqual(e[0].corps, { labels: ['jules'] });
  assert.match(e[1].corps.body, /^Confiée à Jules automatiquement/);
});

test('Jules part même dans un dépôt dont les deux places sont prises ; le Coordinateur n’est pas réveillé pour autant', async () => {
  const enCours = (n, f) => tachePrete(n, { labels: [{ name: 'niveau:tâche' }, { name: 'en-cours' }], body: `**Fini quand** : ok\n\n**Fichiers touchés** :\n- \`${f}\`\n\n**Attend** : aucune\n` });
  const deux = [enCours(50, 'app/a.ts'), enCours(51, 'app/b.ts')];
  const f = faux(donneesJules({ [`/repos/${DEPOT}/issues?labels=en-cours&state=open&per_page=30`]: deux, [`/repos/${DEPOT}/issues?state=open&per_page=100&page=1`]: [...deux, reservee()] }));
  const d = await decider({ api: f.api, evt: { type: 'tache_fermee', depot: DEPOT, issue: '90', raison: 'completed' } });
  assert.equal(d.action, 'rien');
  assert.equal(d.raison, 'dépôt encore occupé');
  assert.equal(d.jules.n, 31);
  assert.equal(ecritureJules(f.ecritures).length, 2);
});

test('PR fusionnée : la tâche réservée part chez Jules, sans fichier d’état ni tour du PC', async () => {
  const f = faux(donneesJules({ [`/repos/${DEPOT}/pulls/7`]: { number: 7, body: 'Tâche : #40', user: humain, merged_at: '2026-10-28T20:00:00Z' }, [`/repos/${DEPOT}/issues/40`]: tache({ number: 40 }) }));
  const d = await decider({ api: f.api, evt: { type: 'pr_fusionnee', depot: DEPOT, pr: '7' }, accepter: async () => ({ statut: 'ignoree' }) });
  assert.match(d.motif, /jules : #31 confiée ; PR #7 fusionnée/);
  assert.equal(ecritureJules(f.ecritures).length, 2);
});

test('tâche réservée (étiquette posée) : Jules la prend tout de suite, personne n’est réveillé', async () => {
  const f = faux(donneesJules());
  const d = await decider({ api: f.api, evt: { type: 'tache_reservee', depot: DEPOT, issue: '31' } });
  assert.equal(d.action, 'rien');
  assert.equal(d.raison, 'tâche #31 confiée à Jules');
  const journal = [];
  await traiter({ api: faux(donneesJules()).api, evt: { type: 'tache_reservee', depot: DEPOT, issue: '31' }, jetonReveil: 'x', journal: (l) => journal.push(l) });
  assert.ok(journal.some((l) => l.includes('#31') && l.includes('confiée à Jules')));
});

test('filet : une tâche réservée dont l’événement a été manqué part ici ; rien à signaler = aucun réveil', async () => {
  const f = faux(donneesJules());
  const d = await decider({ api: f.api, evt: { type: 'filet', depot: DEPOT, brancheDefaut: 'main' } });
  assert.equal(d.action, 'rien');
  assert.equal(d.raison, 'rien à signaler');
  assert.equal(d.jules.n, 31);
});

test('Jules : plafond de trois, dépôt gelé, tâche déjà confiée deux fois ou corps incomplet = rien n’est écrit', async () => {
  const evt = { type: 'tache_reservee', depot: DEPOT, issue: '31' };
  const rien = async (api, e = evt) => { const f = faux(api); const d = await decider({ api: f.api, evt: e }); assert.equal(d.jules, undefined); assert.equal(f.ecritures.length, 0); return d; };
  await rien(donneesJules({ '/search/issues': { total_count: 3 } }));
  await rien(donneesJules({ '/search/issues': new Error('HTTP 403') }));
  await rien(donneesJules({}, 'MoKarade/MemoryAI'), { ...evt, depot: 'MoKarade/MemoryAI' });
  const marque = { body: 'Confiée à Jules automatiquement par le filet du PC (ancien texte).' };
  await rien(donneesJules({ [`/repos/${DEPOT}/issues/31/comments`]: [marque, marque] }));
  await rien(donneesJules({ [`/repos/${DEPOT}/issues/31`]: reservee(31, { body: 'Faire le truc.' }) }));
});

test('Jules : le plafond compte les Jules des autres dépôts, hors le dépôt lui-même', async () => {
  const f = faux(donneesJules({ '/search/issues': { total_count: 2 } }));
  const d = await decider({ api: f.api, evt: { type: 'tache_reservee', depot: DEPOT, issue: '31' } });
  assert.equal(d.jules.n, 31, 'deux ailleurs, un de plus = trois');
  const plein = faux(donneesJules({ '/search/issues': { total_count: 3 } }));
  assert.equal((await decider({ api: plein.api, evt: { type: 'tache_reservee', depot: DEPOT, issue: '31' } })).jules, undefined);
});

test('le Réacteur confie à Jules sans le PC : ni prochaines.json ni fichier d’état dans le tour', () => {
  for (const f of ['jules-auto.mjs', 'reveil-reacteur.mjs']) {
    const source = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /readFileSync|writeFileSync|existsSync|execFileSync/, f);
  }
});

test('Jules : une réservée non prête est dite au journal avec sa première raison, sans réveiller personne', async () => {
  const journal = [];
  const api = faux(donneesJules({ [`/repos/${DEPOT}/issues/31`]: reservee(31, { body: 'Faire le truc.' }) })).api;
  const d = await traiter({ api, evt: { type: 'tache_reservee', depot: DEPOT, issue: '31' }, jetonReveil: 'x', journal: (l) => journal.push(l) });
  assert.equal(d.action, 'rien');
  assert.ok(journal.some((l) => l.includes('Jules n\'a rien pris') && l.includes('sections absentes')), journal.join('\n'));
  const sans = [];
  await traiter({ api: faux({ [`/repos/${DEPOT}/issues?state=open&per_page=100&page=1`]: [] }).api, evt: { type: 'tache_reservee', depot: DEPOT, issue: '31' }, jetonReveil: 'x', journal: (l) => sans.push(l) });
  assert.ok(!sans.some((l) => l.includes('Jules n\'a rien pris')), 'aucune réservée : rien à dire');
});
