import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { DEPOT_BOITE, DEPOT_GITHUB, LONGUEUR_MAX, PREFIXE, WORKFLOW_BOITE, WORKFLOWS_BALAYAGE, WORKFLOWS_GARDE_FOU_ROUGE, WORKFLOWS_PR_OUVERTE, NUMERO_BOITE, construireMotif, decider, verifierAliasVercel, estPanneRunner, traiter } from './reveil-reacteur.mjs';

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



test('PR fusionnée : une PR de robot sans tâche ne réveille personne', async () => {
  const { api } = faux({ '/repos/MoKarade/JobAI/pulls/9': { body: 'Bump x', user: { login: 'dependabot[bot]', type: 'Bot' } } });
  const d = await decider({ api, evt: { type: 'pr_fusionnee', depot: 'MoKarade/JobAI', pr: '9' } });
  assert.equal(d.action, 'rien');
});

test('PR fusionnée : tâche d’un autre dépôt illisible : les balayages partent quand même', async () => {
  const { api } = faux({
    '/repos/MoKarade/CarAI/pulls/3': { body: 'Tâche : MoKarade/.github#139', user: humain },
    '/repos/MoKarade/.github/issues/139': new Error('HTTP 403'),
  });
  const d = await decider({ api, evt: { type: 'pr_fusionnee', depot: 'MoKarade/CarAI', pr: '3' } });
  assert.equal(d.action, 'balayer');
  assert.deepEqual(d.workflows, WORKFLOWS_BALAYAGE);
});

const DEPOT = 'MoKarade/JobAI';







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
  assert.equal(r.action, 'balayer');
  assert.equal(r.reveille, undefined);
  assert.deepEqual(
    ecritures,
    WORKFLOWS_BALAYAGE.map((w) => ({ methode: 'POST', chemin: `/repos/${DEPOT_GITHUB}/actions/workflows/${w}/dispatches`, corps: { ref: 'main' }, jeton: 'jeton' })),
  );
  assert.ok(!ecritures.some((e) => e.chemin.includes(DEPOT_BOITE) || e.chemin.includes(WORKFLOW_BOITE)));
  assert.deepEqual(r.balayages, ['commentaire-tache-liee.yml', 'relecture-ia.yml']);
  assert.ok(lignes.includes('Réacteur : balayages lancés (commentaire-tache-liee.yml, relecture-ia.yml)'));
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
  assert.equal(r.action, 'balayer');
  assert.deepEqual(r.balayages, []);
  assert.equal(ecritures.length, 2);
  assert.equal(lignes.filter((l) => l.startsWith('::warning::') && l.includes('commentaire-tache-liee.yml non lancé')).length, 1);
  assert.equal(lignes.filter((l) => l.startsWith('::warning::') && l.includes('relecture-ia.yml non lancé')).length, 1);
});

test('traiter : sans jeton, aucune écriture (ni balayage, ni boîte)', async () => {
  const { api, ecritures } = faux();
  const r = await traiter({ api, evt: { type: 'tache_fermee', depot: 'MoKarade/CarAI', issue: '1', raison: 'completed' }, jetonReveil: '', journal: () => {} });
  assert.equal(r.action, 'balayer');
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
  assert.ok(!WORKFLOWS_GARDE_FOU_ROUGE.includes('commentaire-tache-liee.yml'), 'garde_fou_rouge ne passe pas par le balayage des deux workflows');
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

test('PR fusionnée : une tâche acceptée seule est dite dans la décision, et les balayages de .github partent', async () => {
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
  assert.equal(d.action, 'balayer');
  assert.equal(d.acceptation.statut, 'acceptee');
  assert.deepEqual(appels, [{ api, depot: 'MoKarade/JobAI', numeroPr: 7, config: { deploiement: 'aucun', workflows: ['deploy.yml', 'b.yml'] } }]);
});

test('PR fusionnée : l’acceptation automatique qui échoue n’empêche pas les balayages', async () => {
  const { api } = faux({
    '/repos/MoKarade/JobAI/pulls/7': { body: 'Avant…\nTâche : #115', user: humain },
    '/repos/MoKarade/JobAI/issues/115': tache(),
    '/repos/MoKarade/JobAI/issues/115/comments': [],
  });
  const d = await decider({ api, evt: { type: 'pr_fusionnee', depot: 'MoKarade/JobAI', pr: '7' }, accepter: async () => { throw new Error('HTTP 403 sur POST'); } });
  assert.equal(d.action, 'balayer');
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
  assert.deepEqual(rien, { action: 'balayer', workflows: WORKFLOWS_BALAYAGE });
});

test('preuves différées : une erreur est un avertissement, les balayages partent quand même', async () => {
  const journal = [];
  const api = async () => null;
  const r = await traiter({ api, evt: { type: 'tache_fermee', depot: 'MoKarade/JobAI', issue: '90', raison: 'completed' }, jetonReveil: 'x', journal: (l) => journal.push(l), accepterDifferees: async () => { throw new Error('HTTP 502'); } });
  assert.equal(r.action, 'balayer');
  assert.ok(journal.some((l) => l.startsWith('::warning::') && l.includes('HTTP 502')));
  const bon = [];
  await traiter({ api, evt: { type: 'tache_fermee', depot: 'MoKarade/JobAI', issue: '90', raison: 'completed' }, jetonReveil: 'x', journal: (l) => bon.push(l), accepterDifferees: async () => ({ acceptees: [201], ignorees: [] }) });
  assert.ok(bon.some((l) => l.includes('#201') && l.includes('acceptée automatiquement')));
});

// ---- Événements ajoutés pour que rien n'attende un minuteur (tâche MoKarade/.github#712).
test('tâche ouverte : la décision ne lance plus rien (le pilotage agit seul), ni routine ni réveil', async () => {
  const f = faux({});
  const d = await decider({ api: f.api, evt: { type: 'tache_ouverte', depot: DEPOT, issue: '12' } });
  assert.equal(d.action, 'rien');
  assert.deepEqual(f.ecritures, []);
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

test('déploiement réussi : la tâche de la PR fusionnée sur ce commit s’accepte seule, sans réveil', async () => {
  const donnees = { [`/repos/${DEPOT}/commits/abc1234/pulls`]: [{ number: 7, merged_at: '2026-10-28T20:00:00Z' }] };
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
  assert.equal(d.action, 'rien');
  assert.equal(d.acceptation.tache, 40);
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

test('commentaire et fin de cron : la preuve différée due se lit ; ce qu’elle accepte ne lance rien d’autre', async () => {
  const donnees = {};
  for (const type of ['commentaire', 'fin_de_cron']) {
    const sans = await decider({ api: faux(donnees).api, evt: { type, depot: DEPOT, signal: 'apprentissage' }, accepterDifferees: async () => ({ acceptees: [], ignorees: [] }) });
    assert.equal(sans.action, 'rien');
    const avec = await decider({ api: faux(donnees).api, evt: { type, depot: DEPOT, signal: 'apprentissage' }, accepterDifferees: async () => ({ acceptees: [201], ignorees: [] }), maintenant: new Date('2026-10-28T21:00:00Z') });
    assert.equal(avec.action, 'rien', type);
    assert.deepEqual(avec.differees.acceptees, [201]);
  }
});

test('note LIA : le type est accepté mais ne réveille plus personne', async () => {
  const f = faux({});
  const d = await decider({ api: f.api, evt: { type: 'note_lia', depot: DEPOT, signal: 'n-4521' } });
  assert.deepEqual(d, { action: 'rien', raison: 'note LIA : plus de réveil du Coordinateur' });
  assert.deepEqual(f.ecritures, []);
});


// Classe B (scripts/fini-quand.mjs, scripts/preuve-page.mjs, tâche MoKarade/.github#781).
const FINI_B = '**Fini quand** (classe B) : la page des totaux s’affiche.\n**Lecture de page** : GET /totaux → 200, contient « Total »';

test('preuve_page : lecture refusée = la tâche reste ouverte, personne n’est réveillé ; sans numéro = rien ; acceptée = rien de plus', async () => {
  const { api } = faux();
  const echec = await decider({ api, evt: { type: 'preuve_page', depot: 'MoKarade/JobAI', issue: '115', pr: '7', raison: 'echec' } });
  assert.equal(echec.action, 'rien');
  assert.match(echec.raison, /preuve de page MoKarade\/JobAI#115 non acceptée/);
  assert.equal((await decider({ api, evt: { type: 'preuve_page', depot: 'MoKarade/JobAI', issue: '', raison: 'echec' } })).action, 'rien');
  const ok = await decider({ api, evt: { type: 'preuve_page', depot: 'MoKarade/JobAI', issue: '115', pr: '7', raison: 'acceptee' } });
  assert.equal(ok.action, 'rien');
  assert.match(ok.raison, /acceptée par la classe B/);
});
