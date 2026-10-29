import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { ETAPES, PAR_EVENEMENT, corpsJson, etapesPour, ghSynchrone, lignesDesSignaux, piloteDuJob, pilotage } from './pilotage-evenement.mjs';
import { traiter } from './reveil-reacteur.mjs';

const MAINTENANT = new Date('2026-10-29T12:00:00Z');
const DEPOT = 'MoKarade/JobAI';
const CORPS_LIBRE = `**Avant** : \`app/tendances/page.tsx\` place la carte en haut.\n\n**Après** : la consommation passe en premier.\n\n**Fini quand** : un test verrouille l'ordre.\n\n**Attend** : aucune.\n`;
const CORPS_JULES = `**Avant** : x\n\n**Fichiers permis** (aucun autre) :\n- \`tests/navigation.test.ts\`\n\n**À faire** :\n1. y\n`;

const etiquettes = (...noms) => noms.map((name) => ({ name }));
const tache = (n, { body = CORPS_LIBRE, labels = ['niveau:tâche', 'prio:2'] } = {}) => ({ number: n, title: `Tâche ${n}`, body, labels: etiquettes(...labels), state: 'open', updated_at: '2026-10-29T10:00:00Z' });

/** Un dépôt simulé ET avec mémoire : un PATCH change le corps et l'heure de mise à jour, comme GitHub. Garde tous les appels. */
function github({ issues = [], fermees = [], ouvertes = [], fermeesPr = [], fichiers = ['app/tendances/page.tsx'], fichiersPr = {}, commentaires = {} } = {}) {
  const appels = [];
  const gh = (methode, chemin, corps) => {
    appels.push({ methode, chemin, corps });
    const issue = (n) => [...issues, ...fermees].find((i) => i.number === Number(n));
    if (methode === 'GET' && /\/issues\?labels=jules/.test(chemin)) return issues.filter((i) => i.labels.some((l) => l.name === 'jules'));
    if (methode === 'GET' && /\/issues\?state=open&labels=faisable-jules/.test(chemin)) return issues.filter((i) => i.labels.some((l) => l.name === 'faisable-jules'));
    if (methode === 'GET' && /\/issues\?state=closed/.test(chemin)) return fermees;
    if (methode === 'GET' && /\/issues\?state=open/.test(chemin)) return issues;
    if (methode === 'GET' && /\/pulls\?state=open/.test(chemin)) return ouvertes;
    if (methode === 'GET' && /\/pulls\?state=closed/.test(chemin)) return fermeesPr;
    if (methode === 'GET' && /\/dependencies\/blocked_by$/.test(chemin)) return [];
    const f = /\/pulls\/(\d+)\/files/.exec(chemin);
    if (methode === 'GET' && f) return (fichiersPr[f[1]] ?? []).map((filename) => ({ filename }));
    const c = /\/issues\/(\d+)\/comments/.exec(chemin);
    if (methode === 'GET' && c) return commentaires[c[1]] ?? [];
    if (methode === 'GET' && /\/git\/trees\/HEAD/.test(chemin)) return { truncated: false, tree: fichiers.map((path) => ({ path, type: 'blob' })) };
    const ct = /\/contents\/(.+)$/.exec(chemin);
    if (methode === 'GET' && ct) {
      if (fichiers.includes(decodeURIComponent(ct[1]))) return { type: 'file' };
      throw Object.assign(new Error('Command failed'), { stderr: 'gh: Not Found (HTTP 404)' });
    }
    const un = /\/issues\/(\d+)$/.exec(chemin);
    if (methode === 'GET' && un) return issue(un[1]);
    if (methode === 'PATCH' && un && corps?.body !== undefined) {
      const i = issue(un[1]);
      i.body = corps.body;
      i.updated_at = `2026-10-29T12:0${appels.length % 10}:00Z`;
      return {};
    }
    return {};
  };
  return { gh, appels, ecritures: () => appels.filter((a) => a.methode !== 'GET') };
}

test('chaque événement du Réacteur a ses étapes, et un type inconnu n’en a aucune', () => {
  assert.deepEqual(etapesPour('tache_ouverte'), ['perimees', 'completer', 'acceptation', 'marquer', 'immobiles']);
  assert.deepEqual(etapesPour('tache_fermee'), ['menage', 'immobiles']);
  assert.deepEqual(etapesPour('pr_ouverte'), ['suivi', 'parJules']);
  assert.deepEqual(etapesPour('pr_fusionnee'), ['suivi', 'parJules', 'immobiles']);
  assert.deepEqual(etapesPour('deploiement'), ['suivi']);
  assert.deepEqual(etapesPour('filet'), ETAPES);
  assert.deepEqual(etapesPour('ci_rouge'), []);
  assert.deepEqual(etapesPour('inconnu'), []);
  for (const etapes of Object.values(PAR_EVENEMENT)) for (const e of etapes) assert.ok(ETAPES.includes(e), e);
});

test('tâche ouverte au gabarit complet : corps complété, puis réservée à Jules (faisable-jules + commentaire)', () => {
  const complete = `**Avant** : \`tests/navigation.test.ts\` n'a aucun test.\n\n**Après** : un test couvre la navigation.\n\n**Fini quand** : \`npm run test -- navigation\` affiche 3 tests verts.\n\n**Fichiers permis** (aucun autre) :\n- \`tests/navigation.test.ts\`\n\n**À faire** :\n1. Écrire trois cas.\n\n**À ne pas faire** : ne pas modifier le code.\n\n**Vérifier** : \`npm run test -- navigation\`\n\n**À citer dans la PR** : \`Tâche : #20\` ; sujet de commit : \`test: navigation\`\n**Attend** : aucune\n`;
  const g = github({ issues: [tache(20, { body: complete })], fichiers: ['tests/navigation.test.ts'] });
  const r = pilotage({ evt: { type: 'tache_ouverte', depot: DEPOT, issue: '20' }, gh: g.gh, maintenant: MAINTENANT });
  assert.deepEqual(r.erreurs, []);
  const pose = g.ecritures().find((a) => a.chemin.endsWith('/issues/20/labels') && a.corps?.['labels[]'] === 'faisable-jules');
  assert.ok(pose, 'faisable-jules posé');
  const note = g.ecritures().find((a) => a.chemin.endsWith('/issues/20/comments'));
  assert.match(note.corps.body, /par le Réacteur/);
  assert.doesNotMatch(note.corps.body, /filet du PC/);
  assert.ok(r.lignes.some((l) => /faisable-jules posé \(JobAI#20\)/.test(l)));
});

test('tâche fermée : ses étiquettes de travail sont retirées', () => {
  const fermee = { ...tache(30, { labels: ['niveau:tâche', 'en-cours', 'preuve-attendue', 'prio:2'] }), state: 'closed' };
  const g = github({ fermees: [fermee] });
  const r = pilotage({ evt: { type: 'tache_fermee', depot: DEPOT, issue: '30' }, gh: g.gh, maintenant: MAINTENANT });
  assert.deepEqual(g.ecritures().filter((a) => a.methode === 'DELETE').map((a) => a.chemin.split('/').pop()).sort(), ['en-cours', 'preuve-attendue']);
  assert.ok(r.lignes.some((l) => /ménage : 2 étiquette/.test(l)));
});

const T_JULES = tache(196, { body: CORPS_JULES, labels: ['niveau:tâche', 'jules'] });
const PR_JULES = { number: 197, title: 'test: navigation', body: 'Fixes #196\n\nhttps://jules.google.com/task/1234567890', state: 'open', draft: false, created_at: '2026-10-29T11:55:00Z', labels: [] };

test('PR de Jules ouverte avec « Fixes #n » : le corps est nettoyé et la PR porte par-jules', () => {
  const g = github({ issues: [T_JULES], ouvertes: [PR_JULES], fichiersPr: { 197: ['tests/navigation.test.ts'] } });
  const r = pilotage({ evt: { type: 'pr_ouverte', depot: DEPOT, pr: '197' }, gh: g.gh, maintenant: MAINTENANT });
  assert.deepEqual(r.erreurs, []);
  const corps = g.ecritures().find((a) => a.methode === 'PATCH' && a.chemin.endsWith('/pulls/197'));
  assert.doesNotMatch(corps.corps.body, /fixes/i);
  assert.match(corps.corps.body, /Tâche : #196/);
  assert.ok(g.ecritures().some((a) => a.chemin.endsWith('/issues/197/labels') && a.corps?.['labels[]'] === 'par-jules'));
  assert.deepEqual(r.signaux, []);
});

test('PR de Jules qui sort de « Fichiers permis » : hold posé et un signal pour le Coordinateur', () => {
  const g = github({ issues: [T_JULES], ouvertes: [PR_JULES], fichiersPr: { 197: ['tests/navigation.test.ts', 'lib/navigation.ts'] } });
  const r = pilotage({ evt: { type: 'pr_ouverte', depot: DEPOT, pr: '197' }, gh: g.gh, maintenant: MAINTENANT });
  assert.ok(g.ecritures().some((a) => a.chemin.endsWith('/issues/197/labels') && a.corps?.['labels[]'] === 'hold'));
  assert.equal(r.signaux.length, 1);
  assert.match(lignesDesSignaux(r.signaux)[0], /^jules : JobAI#196 PR #197 ouverte avec fichier\(s\) hors/);
});

test('l’événement d’une PR n’étiquette pas les autres PR de Jules (une seule lecture de commentaires : la sienne)', () => {
  const autre = { ...PR_JULES, number: 198, body: 'autre', created_at: '2026-10-29T11:59:00Z' };
  const g = github({ issues: [], ouvertes: [autre, { ...autre, number: 199 }], commentaires: { 198: [{ user: { login: 'google-labs-jules[bot]' } }], 199: [{ user: { login: 'google-labs-jules[bot]' } }] } });
  pilotage({ evt: { type: 'pr_ouverte', depot: DEPOT, pr: '198' }, gh: g.gh, maintenant: MAINTENANT });
  const etiquetees = g.ecritures().filter((a) => a.corps?.['labels[]'] === 'par-jules').map((a) => a.chemin);
  assert.deepEqual(etiquetees, ['repos/MoKarade/JobAI/issues/198/labels']);
  assert.equal(g.appels.filter((a) => /issues\/\d+\/comments/.test(a.chemin)).length, 1);
});

test('PR de tests de Jules fusionnée : « Acceptée » posée au format du garde-fou, étiquettes retirées, tâche fermée', () => {
  const fusionnee = { number: 197, title: 'test: navigation', body: 'Fixes #196', state: 'closed', merged_at: '2026-10-29T11:50:00Z', merge_commit_sha: 'a1b2c3d4e5f6', head: { sha: '1234567890ab' }, labels: [] };
  const g = github({ issues: [T_JULES], fermeesPr: [fusionnee], fichiersPr: { 197: ['tests/navigation.test.ts'] } });
  const gh = (m, c, b) => (m === 'GET' && /check-runs/.test(c) ? { check_runs: [{ name: 'Gate', status: 'completed', conclusion: 'success' }] } : g.gh(m, c, b));
  const r = pilotage({ evt: { type: 'pr_fusionnee', depot: DEPOT, pr: '197' }, gh, maintenant: MAINTENANT });
  assert.deepEqual(r.erreurs, []);
  const preuve = g.ecritures().find((a) => a.chemin.endsWith('/issues/196/comments'));
  assert.match(preuve.corps.body, /^\*\*Acceptée\*\* — PR #197 fusionnée \(a1b2c3d\)/);
  assert.ok(g.ecritures().some((a) => a.methode === 'PATCH' && a.chemin.endsWith('/issues/196') && a.corps.state === 'closed'));
  assert.ok(r.lignes.some((l) => /1 tâche\(s\) acceptée\(s\) \(JobAI#196\)/.test(l)));
});

test('une étape qui échoue est dite, les autres passent', () => {
  const g = github({ issues: [tache(10)] });
  const gh = (m, c, b) => {
    if (/\/issues\?state=open&labels=faisable-jules/.test(c)) throw new Error('HTTP 502');
    return g.gh(m, c, b);
  };
  const r = pilotage({ evt: { type: 'tache_ouverte', depot: DEPOT, issue: '10' }, gh, maintenant: MAINTENANT });
  assert.equal(r.erreurs.length, 1);
  assert.match(r.erreurs[0], /^perimees \(HTTP 502\)/);
  assert.deepEqual(r.etapes, ['perimees', 'completer', 'acceptation', 'marquer', 'immobiles'], 'les autres étapes ont passé malgré l’échec');
});

test('un type sans étape ne lit rien', () => {
  const g = github();
  const r = pilotage({ evt: { type: 'ci_rouge', depot: DEPOT }, gh: g.gh, maintenant: MAINTENANT });
  assert.deepEqual(r.etapes, []);
  assert.equal(g.appels.length, 0);
});

test('piloteDuJob ne lève jamais : une panne de lecture complète est dite', async () => {
  const pilote = piloteDuJob({ gh: () => { throw new Error('gh absent'); } });
  const r = await pilote({ evt: { type: 'tache_ouverte', depot: DEPOT }, maintenant: MAINTENANT });
  assert.ok(r.erreurs.length > 0);
});

// ── Le Réacteur appelle le pilotage, et dit au Coordinateur ce que le suivi de Jules a vu ─────────────────────────────
function reacteur({ commentairesBoite = [] } = {}) {
  const appels = [];
  const api = async (methode, chemin, corps) => {
    appels.push({ methode, chemin, corps });
    if (methode === 'GET' && /\/repos\/MoKarade\/app-template\/issues\/58\/comments/.test(chemin)) return commentairesBoite;
    return null;
  };
  return { api, appels, reveils: () => appels.filter((a) => a.methode === 'POST' && /boite-reacteur\.yml\/dispatches$/.test(a.chemin)).map((a) => a.corps.inputs.texte) };
}
const SIGNAL = { ref: 'JobAI#196', raison: 'PR #197 ouverte avec fichier(s) hors « Fichiers permis » (lib/navigation.ts), hold posé' };
const evtFin = { type: 'tache_fermee', depot: 'MoKarade/hub-contract', issue: '5', raison: 'completed' };

test('traiter : le pilotage tourne avant la décision et son signal réveille le Coordinateur, une fois', async () => {
  const vus = [];
  const pilote = async ({ evt }) => { vus.push(evt.type); return { etapes: ['menage'], lignes: ['ménage : 1 étiquette'], signaux: [SIGNAL], erreurs: [] }; };
  const r1 = reacteur();
  const journal = [];
  const res = await traiter({ api: r1.api, evt: { ...evtFin, depot: DEPOT }, jetonReveil: 'jeton', journal: (l) => journal.push(l), maintenant: MAINTENANT, pilote });
  assert.deepEqual(vus, ['tache_fermee']);
  assert.ok(journal.some((l) => /pilotage \(tache_fermee\) : ménage : 1 étiquette/.test(l)));
  assert.ok(r1.reveils().some((t) => t === `RÉACTEUR : jules : ${SIGNAL.ref} ${SIGNAL.raison}`), r1.reveils().join(' | '));
  assert.equal(res.signauxDits, 1);

  // Le même signal est déjà sur la boîte depuis moins de 6 h : rien de plus.
  const r2 = reacteur({ commentairesBoite: [{ body: `RÉACTEUR : jules : ${SIGNAL.ref} ${SIGNAL.raison}`, user: { login: 'github-actions[bot]' }, created_at: '2026-10-29T10:00:00Z' }] });
  const res2 = await traiter({ api: r2.api, evt: { ...evtFin, depot: DEPOT }, jetonReveil: 'jeton', journal: () => {}, maintenant: MAINTENANT, pilote });
  assert.ok(!r2.reveils().some((t) => t.includes(SIGNAL.ref)));
  assert.equal(res2.signauxDits, undefined);
});

test('traiter : une étape du pilotage en échec est un avertissement du journal et reste dans le résultat', async () => {
  const pilote = async () => ({ etapes: ['suivi'], lignes: [], signaux: [], erreurs: ['suivi (HTTP 502)'] });
  const journal = [];
  const res = await traiter({ api: reacteur().api, evt: { type: 'ci_rouge', depot: DEPOT, pr: '', run: '' }, jetonReveil: 'jeton', journal: (l) => journal.push(l), maintenant: MAINTENANT, pilote });
  assert.ok(journal.some((l) => /^::warning::Réacteur : pilotage, étape en échec : suivi \(HTTP 502\)/.test(l)));
  assert.deepEqual(res.pilotage.erreurs, ['suivi (HTTP 502)']);
});

test('traiter sans pilotage se comporte comme avant (aucune clé de plus)', async () => {
  const res = await traiter({ api: reacteur().api, evt: { type: 'inconnu', depot: DEPOT }, jetonReveil: 'jeton', journal: () => {}, maintenant: MAINTENANT });
  assert.equal(res.action, 'rien');
  assert.equal(res.pilotage, undefined);
});

// ── Le client synchrone n'a besoin d'aucune CLI `gh` (DriveAI#798 : « spawnSync gh ENOENT » sur le robot du PC) ─────────────────────────────────────────
test('corpsJson : les clés en [] deviennent une liste, les autres gardent leur valeur', () => {
  assert.deepEqual(corpsJson({ 'labels[]': 'hold' }), { labels: ['hold'] });
  assert.deepEqual(corpsJson({ state: 'closed', state_reason: 'completed' }), { state: 'closed', state_reason: 'completed' });
  assert.equal(corpsJson(undefined), undefined);
});

const reponseDe = (statut, texte) => () => ({ stdout: JSON.stringify({ statut, texte }), stderr: '' });

test('ghSynchrone : une réponse vide (204) rend {}, une liste rend la liste, un statut 4xx lève avec « 404 Not Found »', () => {
  assert.deepEqual(ghSynchrone({ jeton: 'x', lancer: reponseDe(204, '') })('DELETE', 'repos/o/r/issues/1/labels/a'), {});
  assert.deepEqual(ghSynchrone({ jeton: 'x', lancer: reponseDe(200, '[{"number":1}]') })('GET', 'repos/o/r/issues'), [{ number: 1 }]);
  assert.throws(() => ghSynchrone({ jeton: 'x', lancer: reponseDe(404, '{}') })('GET', 'repos/o/r/contents/a'), (e) => /404 Not Found/.test(e.message) && /404 Not Found/.test(e.stderr));
  assert.throws(() => ghSynchrone({ jeton: 'x', lancer: reponseDe(502, 'bad') })('GET', 'repos/o/r'), /HTTP 502/);
});

test('ghSynchrone : le processus enfant qui ne démarre pas, ou une sortie illisible, lèvent une erreur claire (jamais de silence)', () => {
  assert.throws(() => ghSynchrone({ jeton: 'x', lancer: () => ({ error: new Error('spawn ENOENT') }) })('GET', 'repos/o/r'), /spawn ENOENT/);
  assert.throws(() => ghSynchrone({ jeton: 'x', lancer: () => ({ stdout: 'pas du json', stderr: '' }) })('GET', 'repos/o/r'), /illisible/);
});

test('ghSynchrone : le vrai processus enfant fait la requête (serveur local, sans réseau ni gh), jeton et corps compris', async () => {
  const serveur = spawn(process.execPath, ['-e', `
    const http = require('node:http');
    const s = http.createServer((req, res) => {
      let corps = '';
      req.on('data', (c) => { corps += c; });
      req.on('end', () => {
        if (req.url === '/repos/o/r/absent') { res.statusCode = 404; res.end('{}'); return; }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ methode: req.method, url: req.url, auth: req.headers.authorization, corps: corps ? JSON.parse(corps) : null }));
      });
    }).listen(0, '127.0.0.1', () => console.log(s.address().port));
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const port = await new Promise((ok, ko) => { serveur.stdout.once('data', (d) => ok(Number(String(d).trim()))); serveur.once('error', ko); });
    const gh = ghSynchrone({ jeton: 'jeton-essai', base: `http://127.0.0.1:${port}` });
    const r = gh('POST', 'repos/o/r/issues/5/labels', { 'labels[]': 'hold' });
    assert.deepEqual(r, { methode: 'POST', url: '/repos/o/r/issues/5/labels', auth: 'Bearer jeton-essai', corps: { labels: ['hold'] } });
    assert.throws(() => gh('GET', 'repos/o/r/absent'), /404 Not Found/);
  } finally {
    serveur.kill();
  }
});
