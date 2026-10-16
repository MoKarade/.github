import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENTETE_ACCEPTEE, LABEL_MANQUE, corpsReouverture, evaluer, lireCitation, servi, traiter, trouverPreuve, verifierDeploiement } from './preuve.mjs';

const SHA = 'ea239e9a1b2c3d4e5f60718293a4b5c6d7e8f901';
const FUSION = '2026-10-16T14:00:00Z';
const personne = { login: 'MoKarade', type: 'User' };
const robot = { login: 'github-actions[bot]', type: 'Bot' };
const jules = { login: 'google-labs-jules[bot]', type: 'Bot' };

const preuveOk =
  '**Acceptée** — PR #12 fusionnée (ea239e9), déploiement READY (dpl_1), preuve : GET /api/sante rend 200 et { ok: true } en production, lu à 10:05 (heure du Québec).';
const commentaire = (body, user = personne, created_at = '2026-10-16T14:10:00Z') => ({ body, user, created_at });
const pr = { merged: true, merged_at: FUSION, merge_commit_sha: SHA, head_sha: 'ffffffffffffffffffffffffffffffffffffffff' };
const deployeOk = { requis: true, ok: true, detail: 'déploiement 1' };

test('la preuve complète est acceptée', () => {
  const r = evaluer({ raison: 'completed', commentaires: [commentaire(preuveOk)], pr, fichiers: ['app/page.tsx'], deploiement: deployeOk });
  assert.deepEqual(r.motifs, []);
  assert.equal(r.ok, true);
});

test('aucun commentaire : refusé', () => {
  const r = evaluer({ raison: 'completed', commentaires: [], pr: null });
  assert.equal(r.ok, false);
  assert.match(r.motifs[0], /aucun commentaire/);
});

test('un robot ou Jules ne prouve rien', () => {
  for (const user of [robot, jules]) {
    assert.equal(evaluer({ raison: 'completed', commentaires: [commentaire(preuveOk, user)], pr, fichiers: ['docs/a.md'] }).ok, false);
  }
});

test('« Acceptée. » sans le gras ne passe pas : un seul format, le même que le Gantt', () => {
  assert.equal(ENTETE_ACCEPTEE.test('**Acceptée** — x'), true);
  assert.equal(ENTETE_ACCEPTEE.test('**Acceptée.**'), false);
  assert.equal(ENTETE_ACCEPTEE.test('Acceptée. Livrée par #209'), false);
});

test('un aveu de doute annule la preuve (cas FinanceAI#1156)', () => {
  const doute = preuveOk + '\n- Limite [Probable] : je n’ai pas lu le GET /hub/summary déployé.';
  const r = evaluer({ raison: 'completed', commentaires: [commentaire(doute)], pr, fichiers: ['docs/a.md'] });
  assert.equal(r.ok, false);
  assert.match(r.motifs.join(' '), /avoue un doute/);
});

test('« pas lu », « non testé », [À vérifier] sont des aveux', () => {
  for (const t of ['pas lu en production', 'non testé', 'je n’ai pas pu vérifier', '[À vérifier]', '[Supposition]']) {
    const r = evaluer({ raison: 'completed', commentaires: [commentaire(`${preuveOk} ${t}`)], pr, fichiers: ['docs/a.md'] });
    assert.equal(r.ok, false, t);
  }
});

test('« certain » et « testé » sans négation ne sont pas des aveux', () => {
  const r = evaluer({ raison: 'completed', commentaires: [commentaire(`${preuveOk} [Certain] testé en production.`)], pr, fichiers: ['docs/a.md'] });
  assert.equal(r.ok, true);
});

test('la ligne de preuve trop courte est refusée', () => {
  const r = evaluer({ raison: 'completed', commentaires: [commentaire('**Acceptée** — PR #12 fusionnée (ea239e9), preuve : ok')], pr, fichiers: ['docs/a.md'] });
  assert.equal(r.ok, false);
  assert.match(r.motifs.join(' '), /trop courte/);
});

test('ni PR ni « sans PR » : refusé', () => {
  const r = evaluer({ raison: 'completed', commentaires: [commentaire('**Acceptée** — preuve : ' + 'x'.repeat(80))] });
  assert.match(r.motifs.join(' '), /sans PR/);
});

test('« sans PR » avec une vraie preuve passe, avec une preuve courte non', () => {
  assert.equal(evaluer({ raison: 'completed', commentaires: [commentaire('**Acceptée** — sans PR (geste de Marc), preuve : ' + 'l’ancienne clé révoquée répond 401 à un appel de test fait depuis le PC, lu à 11:02 (heure du Québec).')] }).ok, true);
  assert.equal(evaluer({ raison: 'completed', commentaires: [commentaire('**Acceptée** — sans PR, preuve : fait par Marc')] }).ok, false);
});

test('PR introuvable, non fusionnée, mauvaise empreinte, preuve avant la fusion', () => {
  const c = [commentaire(preuveOk)];
  assert.match(evaluer({ raison: 'completed', commentaires: c, pr: null }).motifs.join(' '), /introuvable/);
  assert.match(evaluer({ raison: 'completed', commentaires: c, pr: { merged: false } }).motifs.join(' '), /non fusionnée/);
  assert.match(evaluer({ raison: 'completed', commentaires: [commentaire(preuveOk.replace('ea239e9', 'abc1234'))], pr, fichiers: [] }).motifs.join(' '), /aucune empreinte/);
  assert.match(evaluer({ raison: 'completed', commentaires: [commentaire(preuveOk, personne, '2026-10-16T13:00:00Z')], pr, fichiers: [] }).motifs.join(' '), /avant la fusion/);
  assert.match(evaluer({ raison: 'completed', commentaires: [commentaire(preuveOk.replace('(ea239e9)', ''))], pr, fichiers: [] }).motifs.join(' '), /empreinte/);
});

test('une PR qui change du servi exige un déploiement réussi', () => {
  const c = [commentaire(preuveOk)];
  const sans = evaluer({ raison: 'completed', commentaires: c, pr, fichiers: ['app/page.tsx'], deploiement: { requis: true, ok: false, detail: 'aucun déploiement' } });
  assert.equal(sans.ok, false);
  assert.match(sans.motifs.join(' '), /déploiement de production/);
  // Docs seules : pas de déploiement à prouver.
  assert.equal(evaluer({ raison: 'completed', commentaires: c, pr, fichiers: ['docs/a.md', 'tests/x.test.ts'], deploiement: { requis: true, ok: false, detail: '' } }).ok, true);
  // Dépôt sans déploiement (bibliothèque, .github) : jamais exigé.
  assert.equal(evaluer({ raison: 'completed', commentaires: c, pr, fichiers: ['src/index.ts'], deploiement: { requis: false, ok: null, detail: '' } }).ok, true);
});

test('le dernier commentaire de preuve fait foi', () => {
  const vieux = commentaire('**Acceptée** — vieux', personne, '2026-10-16T12:00:00Z');
  const neuf = commentaire(preuveOk, personne, '2026-10-16T15:00:00Z');
  assert.equal(trouverPreuve([vieux, neuf]), neuf);
});

test('abandon : il faut la raison, écrite par une personne', () => {
  assert.equal(evaluer({ raison: 'not_planned', commentaires: [] }).ok, false);
  assert.equal(evaluer({ raison: 'not_planned', commentaires: [commentaire('**Abandonnée** — doublon de #40, déjà livré par la PR #41')] }).ok, true);
  assert.equal(evaluer({ raison: 'not_planned', commentaires: [commentaire('**Abandonnée**')] }).ok, false);
  assert.equal(evaluer({ raison: 'duplicate', commentaires: [commentaire('**Abandonnée** — x', jules)] }).ok, false);
});

test('lireCitation lit PR, empreintes et preuve', () => {
  const c = lireCitation('**Acceptée** — PR MoKarade/Hubperso#12 fusionnée (ea239e9), run 38919470809, preuve : ça marche');
  assert.deepEqual(c.pr, { depot: 'Hubperso', numero: 12 });
  assert.deepEqual(c.shas, ['ea239e9']);
  assert.equal(c.preuve, 'ça marche');
  assert.equal(lireCitation('aucune').pr, null);
});

test('servi : docs, tests et CI ne comptent pas, le reste oui', () => {
  assert.equal(servi(['docs/a.md', '.github/workflows/x.yml', 'tests/a.test.ts', 'web/tests/b.ts', 'README.md', 'qualite/seuils.json']), false);
  assert.equal(servi(['docs/a.md', 'app/page.tsx']), true);
  assert.equal(servi(['scripts/migrer.mjs']), true);
  assert.equal(servi(['vercel.json']), true);
});

test('corpsReouverture dit quoi faire', () => {
  const t = corpsReouverture(['aucun commentaire'], 'completed');
  assert.match(t, /preuve-manquante/);
  assert.match(t, /\*\*Acceptée\*\*/);
  assert.match(t, /preuve-attendue/);
  assert.match(corpsReouverture(['x'], 'not_planned'), /Abandonnée/);
});

// --- I/O avec une fausse API -------------------------------------------------------------------------------

function fauxGitHub({ issue, commentaires = [], prs = {}, fichiers = {}, deploiements = [], statuts = {}, comparaisons = {}, runs = {}, jobs = {} }) {
  const appels = [];
  const api = async (chemin, init = {}) => {
    const methode = init.method ?? 'GET';
    appels.push({ methode, chemin, body: init.body });
    const [base] = chemin.split('?');
    if (methode !== 'GET') return null;
    let m;
    if (/^\/repos\/[^/]+\/[^/]+\/issues\/\d+$/.test(base)) return issue;
    if (/\/issues\/\d+\/comments$/.test(base)) return commentaires;
    if ((m = /\/pulls\/(\d+)\/files$/.exec(base))) return fichiers[m[1]] ?? [];
    if ((m = /\/pulls\/(\d+)$/.exec(base))) { if (!prs[m[1]]) throw new Error('HTTP 404'); return prs[m[1]]; }
    if (/\/deployments$/.test(base)) return deploiements;
    if ((m = /\/deployments\/(\d+)\/statuses$/.exec(base))) return statuts[m[1]] ?? [];
    if ((m = /\/compare\/(.+)$/.exec(base))) return { status: comparaisons[m[1]] ?? 'diverged' };
    if ((m = /\/actions\/workflows\/([^/]+)\/runs$/.exec(base))) return { workflow_runs: runs[m[1]] ?? [] };
    if ((m = /\/actions\/runs\/(\d+)\/jobs$/.exec(base))) return { jobs: jobs[m[1]] ?? [] };
    throw new Error(`appel inattendu ${methode} ${chemin}`);
  };
  return { api, appels };
}

const issueFermee = (extra = {}) => ({ state: 'closed', state_reason: 'completed', labels: [{ name: 'niveau:tâche' }], ...extra });
const prFusionnee = { merged: true, merged_at: FUSION, merge_commit_sha: SHA, head: { sha: 'ffffffffffffffffffffffffffffffffffffffff' } };
const cfg = { deploiement: 'vercel' };

test('traiter : fermeture sans commentaire → rouverte, étiquette et commentaire posés', async () => {
  const { api, appels } = fauxGitHub({ issue: issueFermee() });
  const r = await traiter({ api, depot: 'MoKarade/Hubperso', numero: 7, config: cfg });
  assert.equal(r.statut, 'rouverte');
  const ecrits = appels.filter((a) => a.methode !== 'GET');
  assert.deepEqual(ecrits.map((a) => a.methode), ['PATCH', 'POST', 'POST']);
  assert.deepEqual(ecrits[0].body, { state: 'open' });
  assert.deepEqual(ecrits[1].body, { labels: [LABEL_MANQUE] });
  assert.match(ecrits[2].body.body, /Garde-fou de preuve/);
});

test('traiter : preuve valide, docs seules → acceptée, rien n’est écrit', async () => {
  const { api, appels } = fauxGitHub({
    issue: issueFermee(),
    commentaires: [commentaire(preuveOk)],
    prs: { 12: prFusionnee },
    fichiers: { 12: [{ filename: 'docs/a.md' }] },
  });
  const r = await traiter({ api, depot: 'MoKarade/Hubperso', numero: 7, config: cfg });
  assert.equal(r.statut, 'acceptee');
  assert.equal(appels.filter((a) => a.methode !== 'GET').length, 0);
});

test('traiter : acceptée, l’étiquette preuve-manquante est retirée', async () => {
  const { api, appels } = fauxGitHub({
    issue: issueFermee({ labels: [{ name: 'niveau:tâche' }, { name: 'preuve-manquante' }, { name: 'preuve-attendue' }] }),
    commentaires: [commentaire(preuveOk)],
    prs: { 12: prFusionnee },
    fichiers: { 12: [{ filename: 'README.md' }] },
  });
  assert.equal((await traiter({ api, depot: 'MoKarade/Hubperso', numero: 7, config: cfg })).statut, 'acceptee');
  assert.deepEqual(appels.filter((a) => a.methode === 'DELETE').map((a) => a.chemin.split('/').pop()), ['preuve-manquante', 'preuve-attendue']);
});

test('traiter : acceptée, en-cours et qui:marc sont retirés aussi', async () => {
  const { api, appels } = fauxGitHub({
    issue: issueFermee({ labels: [{ name: 'niveau:tâche' }, { name: 'en-cours' }, { name: 'qui:marc' }, { name: 'prio:1' }] }),
    commentaires: [commentaire(preuveOk)],
    prs: { 12: prFusionnee },
    fichiers: { 12: [{ filename: 'README.md' }] },
  });
  assert.equal((await traiter({ api, depot: 'MoKarade/Hubperso', numero: 7, config: cfg })).statut, 'acceptee');
  assert.deepEqual(appels.filter((a) => a.methode === 'DELETE').map((a) => decodeURIComponent(a.chemin.split('/').pop())), ['en-cours', 'qui:marc']);
});

test('traiter : rouverte, en-cours et qui:marc ne sont PAS retirés (la tâche n’est pas finie)', async () => {
  const { api, appels } = fauxGitHub({ issue: issueFermee({ labels: [{ name: 'niveau:tâche' }, { name: 'en-cours' }] }) });
  assert.equal((await traiter({ api, depot: 'MoKarade/Hubperso', numero: 7, config: cfg })).statut, 'rouverte');
  assert.equal(appels.filter((a) => a.methode === 'DELETE').length, 0);
});

test('traiter : issue d’essai fermée not_planned → ignorée ; fermée completed sans preuve → rouverte', async () => {
  const essai = [{ name: 'niveau:tâche' }, { name: 'essai' }];
  const a = fauxGitHub({ issue: issueFermee({ state_reason: 'not_planned', labels: essai }) });
  assert.equal((await traiter({ api: a.api, depot: 'MoKarade/x', numero: 1, config: cfg })).statut, 'ignoree');
  assert.equal(a.appels.filter((x) => x.methode !== 'GET').length, 0);
  const b = fauxGitHub({ issue: issueFermee({ labels: essai }) });
  assert.equal((await traiter({ api: b.api, depot: 'MoKarade/x', numero: 1, config: cfg })).statut, 'rouverte');
});

test('traiter : code servi sans déploiement trouvé → rouverte ; avec déploiement réussi → acceptée', async () => {
  const base = { issue: issueFermee(), commentaires: [commentaire(preuveOk)], prs: { 12: prFusionnee }, fichiers: { 12: [{ filename: 'app/page.tsx' }] } };
  const sans = fauxGitHub(base);
  assert.equal((await traiter({ api: sans.api, depot: 'MoKarade/Hubperso', numero: 7, config: cfg })).statut, 'rouverte');

  const avec = fauxGitHub({
    ...base,
    deploiements: [{ id: 1, sha: SHA, created_at: '2026-10-16T14:01:00Z' }],
    statuts: { 1: [{ state: 'success' }] },
  });
  assert.equal((await traiter({ api: avec.api, depot: 'MoKarade/Hubperso', numero: 7, config: cfg })).statut, 'acceptee');
});

test('traiter : déploiement en échec ou antérieur à la fusion ne compte pas', async () => {
  const base = { issue: issueFermee(), commentaires: [commentaire(preuveOk)], prs: { 12: prFusionnee }, fichiers: { 12: [{ filename: 'app/page.tsx' }] } };
  const echec = fauxGitHub({ ...base, deploiements: [{ id: 1, sha: SHA, created_at: '2026-10-16T14:01:00Z' }], statuts: { 1: [{ state: 'failure' }] } });
  assert.equal((await traiter({ api: echec.api, depot: 'MoKarade/Hubperso', numero: 7, config: cfg })).statut, 'rouverte');
  const vieux = fauxGitHub({ ...base, deploiements: [{ id: 1, sha: SHA, created_at: '2026-10-16T09:00:00Z' }], statuts: { 1: [{ state: 'success' }] } });
  assert.equal((await traiter({ api: vieux.api, depot: 'MoKarade/Hubperso', numero: 7, config: cfg })).statut, 'rouverte');
});

test('traiter : un déploiement d’un commit plus récent qui contient la fusion compte', async () => {
  const r = await verifierDeploiement({
    api: fauxGitHub({
      deploiements: [{ id: 2, sha: 'b'.repeat(40), created_at: '2026-10-16T14:30:00Z' }],
      statuts: { 2: [{ state: 'success' }] },
      comparaisons: { [`${SHA}...${'b'.repeat(40)}`]: 'ahead' },
    }).api,
    depot: 'MoKarade/FinanceAI',
    sha: SHA,
    fusionLe: FUSION,
  });
  assert.equal(r.ok, true);
});

test('traiter : un workflow de déploiement réussi compte, pas une exécution dont le job est ignoré', async () => {
  const run = { 'deploy.yml': [{ id: 9, head_sha: SHA, created_at: '2026-10-16T14:05:00Z' }] };
  const ok = await verifierDeploiement({
    api: fauxGitHub({ runs: run, jobs: { 9: [{ name: 'Build & deploy to Cloud Run', conclusion: 'success' }] } }).api,
    depot: 'MoKarade/FinanceAI',
    sha: SHA,
    fusionLe: FUSION,
    workflows: ['deploy.yml'],
  });
  assert.equal(ok.ok, true);
  assert.match(ok.detail, /deploy\.yml/);
  const ignore = await verifierDeploiement({
    api: fauxGitHub({ runs: run, jobs: { 9: [{ name: 'Build & deploy to Cloud Run', conclusion: 'skipped' }, { name: 'Le serveur a changé et RIEN ne peut le déployer', conclusion: 'skipped' }] } }).api,
    depot: 'MoKarade/FinanceAI',
    sha: SHA,
    fusionLe: FUSION,
    workflows: ['deploy.yml'],
  });
  assert.equal(ignore.ok, false);
});

test('traiter : dépôt sans déploiement (config aucun) n’exige rien', async () => {
  const { api } = fauxGitHub({ issue: issueFermee(), commentaires: [commentaire(preuveOk)], prs: { 12: prFusionnee }, fichiers: { 12: [{ filename: 'src/index.ts' }] } });
  assert.equal((await traiter({ api, depot: 'MoKarade/hub-contract', numero: 7, config: { deploiement: 'aucun' } })).statut, 'acceptee');
});

test('traiter : issue sans niveau:tâche ou encore ouverte → ignorée, rien n’est écrit', async () => {
  const a = fauxGitHub({ issue: { state: 'closed', labels: [{ name: 'panne' }] } });
  assert.equal((await traiter({ api: a.api, depot: 'MoKarade/x', numero: 1, config: cfg })).statut, 'ignoree');
  const b = fauxGitHub({ issue: { state: 'open', labels: [{ name: 'niveau:tâche' }] } });
  assert.equal((await traiter({ api: b.api, depot: 'MoKarade/x', numero: 1, config: cfg })).statut, 'ignoree');
  assert.equal([...a.appels, ...b.appels].filter((x) => x.methode !== 'GET').length, 0);
});

test('traiter : abandon justifié → abandon ; sans raison → rouverte', async () => {
  const ok = fauxGitHub({ issue: issueFermee({ state_reason: 'not_planned' }), commentaires: [commentaire('**Abandonnée** — remplacée par la tâche #44, plus utile')] });
  assert.equal((await traiter({ api: ok.api, depot: 'MoKarade/x', numero: 1, config: cfg })).statut, 'abandon');
  const ko = fauxGitHub({ issue: issueFermee({ state_reason: 'not_planned' }) });
  assert.equal((await traiter({ api: ko.api, depot: 'MoKarade/x', numero: 1, config: cfg })).statut, 'rouverte');
});

test('traiter : PR d’un autre dépôt citée avec son nom', async () => {
  const { api } = fauxGitHub({
    issue: issueFermee(),
    commentaires: [commentaire(preuveOk.replace('PR #12', 'PR MoKarade/Hubperso#12'))],
    prs: { 12: prFusionnee },
    fichiers: { 12: [{ filename: 'docs/a.md' }] },
  });
  assert.equal((await traiter({ api, depot: 'MoKarade/.github', numero: 7, config: cfg })).statut, 'acceptee');
});

test('traiter : PR d’un autre dépôt illisible (privé) → pas de réouverture pour ça ; PR du même dépôt introuvable → rouverte', async () => {
  const autre = fauxGitHub({ issue: issueFermee(), commentaires: [commentaire(preuveOk.replace('PR #12', 'PR MoKarade/CarAI#12'))] });
  assert.equal((await traiter({ api: autre.api, depot: 'MoKarade/.github', numero: 7, config: { deploiement: 'aucun' } })).statut, 'acceptee');
  const meme = fauxGitHub({ issue: issueFermee(), commentaires: [commentaire(preuveOk)] });
  assert.equal((await traiter({ api: meme.api, depot: 'MoKarade/.github', numero: 7, config: { deploiement: 'aucun' } })).statut, 'rouverte');
});
