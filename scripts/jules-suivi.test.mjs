import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { marquerParJules, piedDeJules, retirerEtiquette, menageFermees, ETIQUETTES_FERMEES, toucheMcp, toucheEcran, deploiementProduction, commentaireAcceptee, controlesVerts, corpsNettoye, evaluerFusion, horsPermis, prDeLaTache, suivreDepot, tachesCitees, testsSeuls } from './jules-suivi.mjs';
import { tourJulesSuivi } from './filet-pc.mjs';
import { lireCitation, evaluer } from './preuve.mjs';

const CORPS_TACHE = `**Avant** : x\n\n**Fichiers permis** (aucun autre) :\n- \`tests/navigation.test.ts\`\n\n**À faire** :\n1. y\n`;
const T = { number: 196, labels: [{ name: 'niveau:tâche' }, { name: 'jules' }, { name: 'faisable-jules' }], body: CORPS_TACHE };
const MAINTENANT = new Date('2026-10-19T19:00:00Z');

test('tachesCitees : Fixes, Closes, Resolves et Tâche : #n, dédoublonnées, titre compris', () => {
  assert.deepEqual(tachesCitees({ title: 'test: x', body: 'Fixes #196\n\nTâche : #196\nCloses #7' }), [196, 7]);
  assert.deepEqual(tachesCitees({ title: '', body: 'rien' }), []);
});

test('testsSeuls : tests/, __tests__/, *.test.ts, *.spec.js ; un fichier servi ou aucun fichier : non', () => {
  assert.equal(testsSeuls(['tests/a.test.ts', 'lib/__tests__/b.ts', 'x/c.spec.mjs']), true);
  assert.equal(testsSeuls(['tests/a.test.ts', 'lib/navigation.ts']), false);
  assert.equal(testsSeuls([]), false);
  assert.equal(testsSeuls(['README.md']), false);
});

test('horsPermis : seuls les chemins exacts de « Fichiers permis » passent', () => {
  assert.deepEqual(horsPermis(['tests/navigation.test.ts'], CORPS_TACHE), []);
  assert.deepEqual(horsPermis(['tests/navigation.test.ts', 'lib/navigation.ts'], CORPS_TACHE), ['lib/navigation.ts']);
  assert.deepEqual(horsPermis(['tests/a.test.ts'], 'pas de gabarit'), ['tests/a.test.ts']);
});

test('corpsNettoye : retire les lignes fermantes, pose Tâche : #n, ne change rien sinon', () => {
  const sale = 'Avant / Après\n\nFixes #196\n\nresolves: #12 et plus';
  const propre = corpsNettoye(sale, 196);
  assert.doesNotMatch(propre, /fixes|resolves/i);
  assert.match(propre, /Tâche : #196\n$/);
  assert.equal(corpsNettoye(propre, 196), propre);
  const deja = 'Avant\n\nTâche : #196\n';
  assert.equal(corpsNettoye(deja, 196), deja);
  assert.match(corpsNettoye('', 5), /^Tâche : #5\n$/);
});

test('controlesVerts : Mergify ignoré, un contrôle en cours ou rouge = non, aucun contrôle = non', () => {
  const vert = (name) => ({ name, status: 'completed', conclusion: 'success' });
  assert.equal(controlesVerts([vert('Gate'), { name: 'Mergify Merge Queue', status: 'in_progress', conclusion: null }]).ok, true);
  assert.equal(controlesVerts([vert('Gate'), { name: 'Qualité', status: 'in_progress', conclusion: null }]).ok, false);
  assert.equal(controlesVerts([vert('Gate'), { name: 'Sécurité', status: 'completed', conclusion: 'failure' }]).pasVerts[0], 'Sécurité');
  assert.equal(controlesVerts([]).ok, false);
  assert.equal(controlesVerts([{ name: 'Mergify Merge Protections', status: 'completed', conclusion: 'neutral' }]).ok, false);
});

test('evaluerFusion : tests seuls dans les fichiers permis et contrôles verts = acceptable ; sinon la raison', () => {
  const runs = [{ name: 'Gate', status: 'completed', conclusion: 'success' }];
  const pr = { merged: true, merge_commit_sha: 'abcdef1234' };
  assert.equal(evaluerFusion({ tache: { body: CORPS_TACHE }, pr, fichiers: ['tests/navigation.test.ts'], runs }).ok, true);
  const code = evaluerFusion({ tache: { body: CORPS_TACHE }, pr, fichiers: ['tests/navigation.test.ts', 'lib/navigation.ts'], runs });
  assert.equal(code.ok, false);
  assert.match(code.raisons.join(' '), /hors « Fichiers permis »/);
  assert.match(evaluerFusion({ tache: { body: CORPS_TACHE }, pr, fichiers: ['tests/autre.test.ts'], runs }).raisons.join(' '), /hors « Fichiers permis »/);
  assert.match(evaluerFusion({ tache: { body: CORPS_TACHE }, pr: { merged: false }, fichiers: ['tests/navigation.test.ts'], runs }).raisons.join(' '), /non fusionnée/);
});

test('prDeLaTache : la PR fusionnée la plus récente et la PR ouverte la plus récente qui citent la tâche', () => {
  const prs = [
    { number: 1, body: 'Fixes #196', merged_at: '2026-10-19T10:00:00Z', state: 'closed' },
    { number: 2, body: 'Tâche : #196', merged_at: '2026-10-19T12:00:00Z', state: 'closed' },
    { number: 3, body: 'Tâche : #196', state: 'open', created_at: '2026-10-19T13:00:00Z' },
    { number: 4, body: 'Fixes #5', merged_at: '2026-10-19T14:00:00Z', state: 'closed' },
  ];
  const r = prDeLaTache(196, prs);
  assert.equal(r.fusionnee.number, 2);
  assert.equal(r.ouverte.number, 3);
});

test('le commentaire de preuve passe le garde-fou (scripts/preuve.mjs) : PR fusionnée, empreinte, sans déploiement, preuve ≥ 40 car.', () => {
  const pr = { number: 197, merge_commit_sha: 'a1b2c3d4e5f6a7b8', merged_at: '2026-10-19T18:50:00Z', head: { sha: '1234567890abcdef' } };
  const corps = commentaireAcceptee({ pr, fichiers: ['tests/navigation.test.ts'], controles: 6, date: '2026-10-19 19:00 UTC' });
  assert.match(corps, /^\*\*Acceptée\*\* — PR #197 fusionnée \(a1b2c3d\), sans déploiement : tests seuls/);
  const cite = lireCitation(corps);
  assert.equal(cite.pr.numero, 197);
  assert.ok(cite.preuve.length >= 40);
  assert.ok(cite.shas.some((s) => 'a1b2c3d4e5f6a7b8'.startsWith(s)));
  const verdict = evaluer({
    raison: 'completed',
    commentaires: [{ user: { type: 'User', login: 'MoKarade' }, body: corps, created_at: '2026-10-19T19:00:00Z' }],
    pr: { merged: true, merged_at: '2026-10-19T18:50:00Z', merge_commit_sha: 'a1b2c3d4e5f6a7b8', head_sha: '1234567890abcdef' },
    fichiers: ['tests/navigation.test.ts'],
  });
  assert.equal(verdict.ok, true, verdict.motifs?.join(' | '));
});

// ── I/O avec un GitHub simulé ───────────────────────────────────────────────────────────────────────────────────────
function github({ taches = [T], ouvertes = [], fermees = [], tachesFermees = [], deploiements = [], statuts = 'success', commentaires = [], patches = {}, fichiers = {}, runs = [{ name: 'Gate', status: 'completed', conclusion: 'success' }] }) {
  const appels = [];
  const gh = (methode, chemin, corps) => {
    appels.push({ methode, chemin, corps });
    if (methode === 'GET' && /\/issues\?labels=jules/.test(chemin)) return taches;
    if (methode === 'GET' && /\/issues\?state=closed/.test(chemin)) return tachesFermees;
    if (methode === 'GET' && /\/issues\?state=open/.test(chemin)) return [];
    if (methode === 'GET' && /\/pulls\?state=open/.test(chemin)) return ouvertes;
    if (methode === 'GET' && /\/pulls\?state=closed/.test(chemin)) return fermees;
    const f = /\/pulls\/(\d+)\/files/.exec(chemin);
    if (methode === 'GET' && f) return (fichiers[f[1]] ?? []).map((filename) => ({ filename, patch: patches[filename] }));
    if (methode === 'GET' && /\/deployments\?environment/.test(chemin)) return deploiements;
    if (methode === 'GET' && /\/deployments\/\d+\/statuses/.test(chemin)) return [{ state: statuts }];
    if (methode === 'GET' && /\/compare\//.test(chemin)) return { status: 'ahead' };
    if (methode === 'GET' && /\/issues\/\d+\/comments/.test(chemin)) return commentaires;
    if (methode === 'GET' && /\/check-runs/.test(chemin)) return { check_runs: runs };
    return {};
  };
  return { gh, appels };
}
const PR_FUSIONNEE = { number: 197, title: 'test: navigation', body: 'Fixes #196', state: 'closed', merged_at: '2026-10-19T18:50:00Z', merge_commit_sha: 'a1b2c3d4e5f6', head: { sha: '1234567890ab' }, labels: [] };

test('suivreDepot : PR de tests fusionnée = Acceptée posée, étiquettes retirées, tâche fermée', () => {
  const { gh, appels } = github({ fermees: [PR_FUSIONNEE], fichiers: { 197: ['tests/navigation.test.ts'] } });
  const r = suivreDepot({ depot: 'MoKarade/JobAI', gh, maintenant: MAINTENANT });
  assert.deepEqual(r.acceptees, ['JobAI#196']);
  const post = appels.find((a) => a.methode === 'POST');
  assert.match(post.corps.body, /^\*\*Acceptée\*\* — PR #197 fusionnée \(a1b2c3d\)/);
  assert.deepEqual(appels.filter((a) => a.methode === 'DELETE').map((a) => a.chemin.split('/').pop()).sort(), ['faisable-jules', 'jules']);
  const patch = appels.find((a) => a.methode === 'PATCH');
  assert.deepEqual(patch.corps, { state: 'closed', state_reason: 'completed' });
  assert.ok(appels.findIndex((a) => a.methode === 'POST') < appels.findIndex((a) => a.methode === 'PATCH'), 'la preuve est posée avant la fermeture');
});

test('suivreDepot : PR fusionnée qui touche du code servi = rien posé, un signalement', () => {
  const { gh, appels } = github({ fermees: [PR_FUSIONNEE], fichiers: { 197: ['tests/navigation.test.ts', 'lib/navigation.ts'] } });
  const r = suivreDepot({ depot: 'MoKarade/JobAI', gh, maintenant: MAINTENANT });
  assert.deepEqual(r.acceptees, []);
  assert.equal(r.signaux.length, 1);
  assert.match(r.signaux[0].raison, /non acceptée seule/);
  assert.ok(!appels.some((a) => ['POST', 'PATCH', 'DELETE'].includes(a.methode)));
});

test('suivreDepot : contrôles pas verts = pas d’Acceptée', () => {
  const { gh } = github({ fermees: [PR_FUSIONNEE], fichiers: { 197: ['tests/navigation.test.ts'] }, runs: [{ name: 'Gate', status: 'completed', conclusion: 'failure' }] });
  const r = suivreDepot({ depot: 'MoKarade/JobAI', gh, maintenant: MAINTENANT });
  assert.deepEqual(r.acceptees, []);
  assert.match(r.signaux[0].raison, /pas verts/);
});

test('suivreDepot : PR ouverte avec Fixes = corps nettoyé ; fichier hors permis = hold + signalement ; un hold déjà là n’est pas reposé', () => {
  const ouverte = { number: 200, title: 'test', body: 'Fixes #196', state: 'open', created_at: '2026-10-19T18:00:00Z', labels: [] };
  const { gh, appels } = github({ ouvertes: [ouverte], fichiers: { 200: ['tests/navigation.test.ts', 'lib/x.ts'] } });
  const r = suivreDepot({ depot: 'MoKarade/JobAI', gh, maintenant: MAINTENANT });
  assert.deepEqual(r.nettoyees, ['JobAI#200']);
  assert.deepEqual(r.holds, ['JobAI#200']);
  assert.equal(r.signaux.length, 1);
  const patch = appels.find((a) => a.methode === 'PATCH');
  assert.match(patch.corps.body, /Tâche : #196/);
  assert.doesNotMatch(patch.corps.body, /Fixes/);
  const deja = github({ ouvertes: [{ ...ouverte, body: 'Tâche : #196\n', labels: [{ name: 'hold' }] }], fichiers: { 200: ['lib/x.ts'] } });
  const r2 = suivreDepot({ depot: 'MoKarade/JobAI', gh: deja.gh, maintenant: MAINTENANT });
  assert.deepEqual(r2.holds, []);
  assert.deepEqual(r2.nettoyees, []);
});

test('suivreDepot : un signalement par PR et par 24 h ; à blanc : rien n’est écrit', () => {
  const ouverte = { number: 200, title: 'test', body: 'Tâche : #196\n', state: 'open', created_at: '2026-10-19T18:00:00Z', labels: [] };
  const { gh } = github({ ouvertes: [ouverte], fichiers: { 200: ['lib/x.ts'] } });
  const recent = { 'JobAI#196': { signale: '2026-10-19T10:00:00Z' } };
  assert.equal(suivreDepot({ depot: 'MoKarade/JobAI', gh, etat: recent, maintenant: MAINTENANT }).signaux.length, 0);
  const vieux = { 'JobAI#196': { signale: '2026-10-18T10:00:00Z' } };
  assert.equal(suivreDepot({ depot: 'MoKarade/JobAI', gh, etat: vieux, maintenant: MAINTENANT }).signaux.length, 1);
  const g = github({ fermees: [PR_FUSIONNEE], fichiers: { 197: ['tests/navigation.test.ts'] } });
  const blanc = suivreDepot({ depot: 'MoKarade/JobAI', gh: g.gh, maintenant: MAINTENANT, aBlanc: true });
  assert.deepEqual(blanc.acceptees, ['JobAI#196']);
  assert.ok(!g.appels.some((a) => ['POST', 'PATCH', 'DELETE'].includes(a.methode)));
});

test('suivreDepot : une tâche sans étiquette niveau:tâche, ou sans PR, est laissée', () => {
  const { gh, appels } = github({ taches: [{ number: 5, labels: [{ name: 'jules' }], body: '' }, T] });
  const r = suivreDepot({ depot: 'MoKarade/JobAI', gh, maintenant: MAINTENANT });
  assert.equal(r.vu, 1);
  assert.deepEqual(r.acceptees, []);
  assert.ok(!appels.some((a) => ['POST', 'PATCH', 'DELETE'].includes(a.methode)));
});

test('tourJulesSuivi : une ligne, l’état des signalements écrit, un réveil unique ; un dépôt illisible n’arrête pas les autres', () => {
  const dossier = mkdtempSync(join(tmpdir(), 'js-'));
  const f = join(dossier, 'etat.json');
  const ouverte = { number: 200, title: 'test', body: 'Tâche : #196\n', state: 'open', created_at: '2026-10-19T18:00:00Z', labels: [] };
  const { gh } = github({ ouvertes: [ouverte], fichiers: { 200: ['lib/x.ts'] } });
  const lances = [];
  const lancer = (cmd, args) => lances.push([cmd, ...args].join(' '));
  const gh2 = (m, c, b) => { if (/MemoryAI/.test(c)) throw new Error('404 introuvable'); return gh(m, c, b); };
  const ligne = tourJulesSuivi({ fichierEtat: f, executer: true, gh: gh2, lancer, maintenant: MAINTENANT, depots: ['MoKarade/JobAI', 'MoKarade/MemoryAI'] });
  assert.match(ligne, /^jules-suivi : 1 tâche\(s\) jules, 0 acceptée\(s\), 0 PR nettoyée\(s\), 1 hold, réveil envoyé \(1\), ÉCHEC MemoryAI/);
  assert.equal(lances.length, 1);
  assert.match(lances[0], /jules : JobAI#196 PR #200 ouverte avec fichier/);
  assert.ok(JSON.parse(readFileSync(f, 'utf8'))['JobAI#196'].signale);
  const ligne2 = tourJulesSuivi({ fichierEtat: f, executer: true, gh: gh2, lancer, maintenant: new Date(MAINTENANT.getTime() + 600_000), depots: ['MoKarade/JobAI'] });
  assert.equal(lances.length, 1);
  assert.match(ligne2, /0 hold|1 hold/);
});

test('tourJulesSuivi : sans --executer, rien n’est appliqué et la ligne le dit', () => {
  const g = github({ fermees: [PR_FUSIONNEE], fichiers: { 197: ['tests/navigation.test.ts'] } });
  const ligne = tourJulesSuivi({ fichierEtat: join(mkdtempSync(join(tmpdir(), 'js-')), 'e.json'), gh: g.gh, maintenant: MAINTENANT, depots: ['MoKarade/JobAI'] });
  assert.match(ligne, /1 acceptée\(s\) \(JobAI#196\).*\(non appliqué\)/);
  assert.ok(!g.appels.some((a) => ['POST', 'PATCH', 'DELETE'].includes(a.methode)));
});

test('menageFermees : retire en-cours, jules, faisable-jules, preuve-attendue des fermées ; jamais qui:marc, ni les PR, ni les ouvertes ; à blanc n’écrit rien', () => {
  const fermees = [
    { number: 10, labels: [{ name: 'niveau:tâche' }, { name: 'en-cours' }, { name: 'qui:marc' }, { name: 'jules' }] },
    { number: 11, labels: [{ name: 'niveau:tâche' }] },
    { number: 12, labels: [{ name: 'preuve-attendue' }], pull_request: {} },
  ];
  const g = github({ tachesFermees: fermees });
  const r = menageFermees({ depot: 'MoKarade/JobAI', gh: g.gh });
  assert.deepEqual(r, ['JobAI#10:en-cours', 'JobAI#10:jules']);
  assert.deepEqual(g.appels.filter((a) => a.methode === 'DELETE').map((a) => a.chemin), ['repos/MoKarade/JobAI/issues/10/labels/en-cours', 'repos/MoKarade/JobAI/issues/10/labels/jules']);
  assert.ok(!ETIQUETTES_FERMEES.includes('qui:marc'));
  const b = github({ tachesFermees: fermees });
  assert.equal(menageFermees({ depot: 'MoKarade/JobAI', gh: b.gh, aBlanc: true }).length, 2);
  assert.ok(!b.appels.some((a) => a.methode === 'DELETE'));
});

test('tourJulesSuivi : le ménage des fermées est dit sur la ligne, et n’est pas appliqué sans --executer', () => {
  const fermees = [{ number: 10, labels: [{ name: 'en-cours' }] }];
  const g = github({ taches: [], tachesFermees: fermees });
  const f = join(mkdtempSync(join(tmpdir(), 'js-')), 'e.json');
  const ligne = tourJulesSuivi({ fichierEtat: f, executer: true, gh: g.gh, maintenant: MAINTENANT, depots: ['MoKarade/JobAI'] });
  assert.match(ligne, /1 étiquette\(s\) retirée\(s\) sur tâches fermées/);
  assert.equal(g.appels.filter((a) => a.methode === 'DELETE').length, 1);
  const g2 = github({ taches: [], tachesFermees: fermees });
  const l2 = tourJulesSuivi({ fichierEtat: f, gh: g2.gh, maintenant: MAINTENANT, depots: ['MoKarade/JobAI'] });
  assert.match(l2, /étiquette\(s\) retirée\(s\).*\(non appliqué\)/);
  assert.equal(g2.appels.filter((a) => a.methode === 'DELETE').length, 0);
});

const CORPS_ECRAN = `${CORPS_TACHE.replace('`tests/navigation.test.ts`', '`app/page.tsx`\n- `lib/navigation.ts`')}`;
const TACHE_SERVIE = { ...T, body: CORPS_ECRAN };
const DEP = { id: 4242, sha: 'ffffffffffffffff', created_at: '2026-10-19T18:51:00Z' };

test('toucheMcp : chemins du serveur MCP et registerTool ajouté ; toucheEcran : css, tsx, components/', () => {
  assert.equal(toucheMcp(['app/api/mcp/route.ts']), true);
  assert.equal(toucheMcp(['lib/mcp/outils.ts']), true);
  assert.equal(toucheMcp(['lib/a.ts'], ['+  server.registerTool("reanalyser_profil", {})']), true);
  assert.equal(toucheMcp(['lib/a.ts'], ['-  server.registerTool("x")', ' contexte']), false);
  assert.equal(toucheMcp(['lib/a.ts'], [undefined]), false);
  assert.equal(toucheEcran(['app/page.tsx']), true);
  assert.equal(toucheEcran(['lib/a.ts']), false);
});

test('deploiementProduction : réussi après la fusion et contenant le commit = ok ; échec, trop ancien ou illisible = non', () => {
  const lire = (g) => deploiementProduction({ depot: 'MoKarade/JobAI', sha: 'a1b2c3d4e5f6', fusionLe: '2026-10-19T18:50:00Z', gh: g.gh });
  assert.deepEqual({ ok: lire(github({ deploiements: [DEP] })).ok, id: lire(github({ deploiements: [DEP] })).id }, { ok: true, id: 4242 });
  assert.equal(lire(github({ deploiements: [DEP], statuts: 'failure' })).ok, false);
  assert.equal(lire(github({ deploiements: [{ ...DEP, created_at: '2026-10-19T10:00:00Z' }] })).ok, false);
  assert.equal(lire(github({ deploiements: [] })).ok, false);
  assert.equal(deploiementProduction({ depot: 'MoKarade/JobAI', sha: 'a1', fusionLe: '2026-10-19T18:50:00Z', gh: () => { throw new Error('404'); } }).ok, false);
});

test('suivreDepot : code servi + déploiement réussi = Acceptée « déploiement READY (id) » ; le garde-fou la valide', () => {
  const g = github({ taches: [{ ...TACHE_SERVIE, body: CORPS_TACHE.replace('`tests/navigation.test.ts`', '`lib/navigation.ts`') }], fermees: [PR_FUSIONNEE], fichiers: { 197: ['lib/navigation.ts'] }, deploiements: [DEP] });
  const r = suivreDepot({ depot: 'MoKarade/JobAI', gh: g.gh, maintenant: MAINTENANT });
  assert.deepEqual(r.acceptees, ['JobAI#196']);
  const corps = g.appels.find((a) => a.methode === 'POST').corps.body;
  assert.match(corps, /^\*\*Acceptée\*\* — PR #197 fusionnée \(a1b2c3d\), déploiement READY \(4242\), preuve :/);
  const cite = lireCitation(corps);
  assert.ok(cite.preuve.length >= 40);
  assert.equal(evaluer({
    raison: 'completed', commentaires: [{ user: { type: 'User', login: 'MoKarade' }, body: corps, created_at: '2026-10-19T19:00:00Z' }],
    pr: { merged: true, merged_at: '2026-10-19T18:50:00Z', merge_commit_sha: 'a1b2c3d4e5f6', head_sha: '1234567890ab' }, fichiers: ['lib/navigation.ts'],
    deploiement: { requis: true, ok: true, detail: 'déploiement 4242' },
  }).ok, true);
});

test('suivreDepot : code servi sans déploiement = on attend sans bruit ; plus d’une heure après la fusion = un signalement', () => {
  const corps = CORPS_TACHE.replace('`tests/navigation.test.ts`', '`lib/navigation.ts`');
  const base = { taches: [{ ...T, body: corps }], fermees: [PR_FUSIONNEE], fichiers: { 197: ['lib/navigation.ts'] } };
  const tot = suivreDepot({ depot: 'MoKarade/JobAI', gh: github(base).gh, maintenant: MAINTENANT });
  assert.deepEqual([tot.acceptees, tot.signaux], [[], []]);
  const tard = suivreDepot({ depot: 'MoKarade/JobAI', gh: github(base).gh, maintenant: new Date('2026-10-19T20:00:00Z') });
  assert.equal(tard.signaux.length, 1);
  assert.match(tard.signaux[0].raison, /plus d'une heure.*déploiement de production/);
});

test('suivreDepot : un écran exige le commentaire de captures ; avec lui, le lien est dans l’Acceptée', () => {
  const corps = CORPS_ECRAN.replace('Ne pas modifier `lib/format.ts`.', 'Ne pas modifier `lib/format.ts`. Joindre captures avant/après et lancer tests/theme.test.ts.');
  const base = { taches: [{ ...T, body: corps }], fermees: [PR_FUSIONNEE], fichiers: { 197: ['app/page.tsx'] }, deploiements: [DEP] };
  const sans = suivreDepot({ depot: 'MoKarade/JobAI', gh: github(base).gh, maintenant: new Date('2026-10-19T19:00:00Z') });
  assert.deepEqual(sans.acceptees, []);
  const g = github({ ...base, commentaires: [{ body: '<!-- captures-avant-apres -->\nAvant / après', html_url: 'https://github.com/MoKarade/JobAI/pull/197#issuecomment-1' }] });
  const avec = suivreDepot({ depot: 'MoKarade/JobAI', gh: g.gh, maintenant: MAINTENANT });
  assert.deepEqual(avec.acceptees, ['JobAI#196']);
  assert.match(g.appels.find((a) => a.methode === 'POST').corps.body, /captures avant\/après : https:\/\/github\.com\/MoKarade\/JobAI\/pull\/197#issuecomment-1/);
});

test('suivreDepot : un outil MCP (registerTool ajouté ou app/api/mcp/) n’est jamais accepté seul', () => {
  const corps = CORPS_TACHE.replace('`tests/navigation.test.ts`', '`lib/outils.ts`');
  const g = github({ taches: [{ ...T, body: corps }], fermees: [PR_FUSIONNEE], fichiers: { 197: ['lib/outils.ts'] }, patches: { 'lib/outils.ts': '+server.registerTool("x", {})' }, deploiements: [DEP] });
  const r = suivreDepot({ depot: 'MoKarade/JobAI', gh: g.gh, maintenant: MAINTENANT });
  assert.deepEqual(r.acceptees, []);
  assert.match(r.signaux[0].raison, /outil MCP/);
  assert.ok(!g.appels.some((a) => ['POST', 'PATCH', 'DELETE'].includes(a.methode)));
});

test('docs seules (aucun fichier servi) : Acceptée « sans déploiement : docs, tests ou CI »', () => {
  const corps = CORPS_TACHE.replace('`tests/navigation.test.ts`', '`docs/guide.md`');
  const g = github({ taches: [{ ...T, body: corps }], fermees: [PR_FUSIONNEE], fichiers: { 197: ['docs/guide.md'] } });
  const r = suivreDepot({ depot: 'MoKarade/JobAI', gh: g.gh, maintenant: MAINTENANT });
  assert.deepEqual(r.acceptees, ['JobAI#196']);
  assert.match(g.appels.find((a) => a.methode === 'POST').corps.body, /sans déploiement : docs, tests ou CI, aucun fichier servi/);
});

test('retirerEtiquette : une étiquette déjà partie (404) n’est pas une erreur, une autre panne remonte', () => {
  const appels = [];
  const gh404 = (m, c) => { appels.push(`${m} ${c}`); throw Object.assign(new Error('Command failed: gh api -X DELETE'), { stderr: 'gh: Label does not exist (HTTP 404)' }); };
  retirerEtiquette(gh404, 'MoKarade/CarAI', 50, 'jules');
  assert.deepEqual(appels, ['DELETE repos/MoKarade/CarAI/issues/50/labels/jules']);
  const gh500 = () => { throw Object.assign(new Error('Command failed'), { stderr: 'gh: Server Error (HTTP 500)' }); };
  assert.throws(() => retirerEtiquette(gh500, 'MoKarade/CarAI', 50, 'jules'), /Command failed/);
});

// ── Étiquette par-jules (tâche #426) ──
function ghParJules({ ouvertes = [], fermees = [], commentaires = {}, sansEtiquette = true }) {
  const appels = [];
  const gh = (methode, chemin, charge) => {
    appels.push(`${methode} ${chemin}`);
    if (methode === 'GET' && chemin.includes('pulls?state=open')) return ouvertes;
    if (methode === 'GET' && chemin.includes('pulls?state=closed')) return fermees;
    const c = /issues\/(\d+)\/comments/.exec(chemin);
    if (methode === 'GET' && c) return commentaires[c[1]] ?? [];
    if (methode === 'POST' && chemin.endsWith('/labels') && charge.name) { if (!sansEtiquette) throw new Error('422'); return {}; }
    if (methode === 'POST' && /issues\/\d+\/labels$/.test(chemin)) return {};
    throw new Error(`appel inattendu ${methode} ${chemin}`);
  };
  return { gh, appels };
}
const PR = (n, o = {}) => ({ number: n, state: 'open', body: '', labels: [], ...o });
const PIED = '*PR created automatically by Jules for task [123](https://jules.google.com/task/123)*';

test('piedDeJules : le lien de tâche de Jules, nulle part ailleurs', () => {
  assert.equal(piedDeJules(`corps\n\n${PIED}`), true);
  assert.equal(piedDeJules('Tâche : #12'), false);
  assert.equal(piedDeJules('critère : le corps porte `jules.google.com/task/`, ou le bot a commenté'), false, 'le critère cité sans numéro de tâche (PR de Claude .github#425, #434)');
  assert.equal(piedDeJules(null), false);
});

test('marquerParJules : pied de page (ouverte ou fermée) et commentaire du bot (ouverte) posent par-jules ; une PR sans trace, rien', () => {
  const { gh, appels } = ghParJules({
    ouvertes: [PR(1, { body: PIED }), PR(2, { body: 'effacé' }), PR(3, { body: 'robot' })],
    fermees: [PR(4, { state: 'closed', body: PIED }), PR(5, { state: 'closed', body: 'effacé' })],
    commentaires: { 2: [{ user: { login: 'google-labs-jules[bot]' } }], 3: [{ user: { login: 'github-actions[bot]' } }] },
  });
  const r = marquerParJules({ depot: 'MoKarade/CarAI', gh });
  assert.deepEqual(r.marquees, ['CarAI#1', 'CarAI#2', 'CarAI#4']);
  assert.ok(appels.includes('POST repos/MoKarade/CarAI/issues/2/labels'));
  assert.ok(!appels.some((a) => a.includes('issues/5/') || a.includes('issues/3/labels')), 'ni la fermée sans pied, ni la PR sans trace');
  assert.equal(appels.filter((a) => a === 'POST repos/MoKarade/CarAI/labels').length, 1, 'l\'étiquette est créée une seule fois');
});

test('marquerParJules : une PR déjà étiquetée n\'est pas relue ; une étiquette qui existe déjà ne fait pas échouer', () => {
  const { gh, appels } = ghParJules({ ouvertes: [PR(1, { body: PIED, labels: [{ name: 'par-jules' }] }), PR(2, { body: PIED })], sansEtiquette: false });
  assert.deepEqual(marquerParJules({ depot: 'MoKarade/CarAI', gh }).marquees, ['CarAI#2']);
  assert.ok(!appels.some((a) => a.includes('issues/1/')));
});

test('marquerParJules : à blanc ne crée ni ne pose rien ; les commentaires lus sont bornés', () => {
  const { gh, appels } = ghParJules({ ouvertes: [PR(1, { body: PIED })] });
  assert.deepEqual(marquerParJules({ depot: 'MoKarade/CarAI', gh, aBlanc: true }).marquees, ['CarAI#1']);
  assert.ok(!appels.some((a) => a.startsWith('POST')));
  const beaucoup = ghParJules({ ouvertes: Array.from({ length: 30 }, (_, i) => PR(i + 1)) });
  marquerParJules({ depot: 'MoKarade/CarAI', gh: beaucoup.gh });
  assert.equal(beaucoup.appels.filter((a) => a.includes('/comments')).length, 20);
});
