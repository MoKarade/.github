import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { DEPOTS_FILET, dateQuebec, evaluerQuotidien, lancerFilet, reveiller, tourQuotidien, evaluerFile, motifDeLaFile, tourFile, versionDuCode, MODULES_VERSION, tourAcceptationMarquee, tourPreuvesRetard, ligneAppels } from './filet-pc.mjs';

const T0 = new Date('2026-10-17T18:00:00Z');
const apres = (min, base = T0) => new Date(base.getTime() + min * 60_000);
const iso = (d) => d.toISOString();

test('reveiller lance boite-reacteur.yml d\'app-template avec le motif, sans shell', () => {
  const appels = [];
  reveiller('RÉACTEUR : x', (cmd, args, opts) => appels.push({ cmd, args, opts }));
  assert.equal(appels[0].cmd, 'gh');
  assert.deepEqual(appels[0].args, ['workflow', 'run', 'boite-reacteur.yml', '--repo', 'MoKarade/app-template', '--ref', 'main', '-f', 'texte=RÉACTEUR : x']);
  assert.notEqual(appels[0].opts.shell, true);
});

// --- passage quotidien du Réacteur (MoKarade/.github#143) ---
function dossier() {
  const d = mkdtempSync(join(tmpdir(), 'filet-pc-'));
  return { etat: join(d, 'etat.json'), d };
}
const QC = (iso8601) => new Date(iso8601); // 10:25Z = 6 h 25 à Québec en heure d'été (UTC-4), 11:25Z = 6 h 25 en heure d'hiver (UTC-5)

test('dateQuebec : heure d\'été puis heure d\'hiver, et le jour change à minuit du Québec, pas d\'UTC', () => {
  assert.deepEqual(dateQuebec(QC('2026-10-18T10:25:00Z')), { jour: '2026-10-18', minutes: 6 * 60 + 25 });
  assert.deepEqual(dateQuebec(QC('2026-11-02T11:25:00Z')), { jour: '2026-11-02', minutes: 6 * 60 + 25 });
  assert.deepEqual(dateQuebec(QC('2026-10-19T03:30:00Z')), { jour: '2026-10-18', minutes: 23 * 60 + 30 });
});

test('quotidien : avant 6 h du Québec rien ; dès 6 h les onze dépôts, le jour même une seule fois', () => {
  assert.equal(evaluerQuotidien({ maintenant: QC('2026-10-18T09:59:00Z') }).a_lancer.length, 0);
  assert.match(evaluerQuotidien({ maintenant: QC('2026-10-18T09:59:00Z') }).raison, /avant 6 h/);
  const r = evaluerQuotidien({ maintenant: QC('2026-10-18T10:00:00Z') });
  assert.deepEqual(r.a_lancer, DEPOTS_FILET);
  assert.equal(DEPOTS_FILET.length, 11);
  assert.equal(new Set(DEPOTS_FILET).size, 11);
  assert.ok(DEPOTS_FILET.includes('MoKarade/lia-ui'));
  const fait = { ...r.etat, faits: [...DEPOTS_FILET] };
  const apres = evaluerQuotidien({ etat: fait, maintenant: QC('2026-10-18T15:00:00Z') });
  assert.deepEqual(apres.a_lancer, []);
  assert.match(apres.raison, /déjà fait/);
  assert.equal(evaluerQuotidien({ etat: fait, maintenant: QC('2026-10-19T10:05:00Z') }).a_lancer.length, 11); // le lendemain, tout repart
});

test('quotidien : un dépôt en échec est retenté, trois essais au plus par jour', () => {
  let etat = {};
  for (let i = 0; i < 4; i += 1) {
    const r = evaluerQuotidien({ etat, maintenant: QC('2026-10-18T10:30:00Z'), depots: ['MoKarade/JobAI'] });
    assert.equal(r.a_lancer.length, i < 3 ? 1 : 0);
    etat = { ...r.etat, essais: { 'MoKarade/JobAI': i + 1 } };
  }
});

test('lancerFilet lance reacteur.yml du dépôt sur sa branche par défaut, sans shell', () => {
  const appels = [];
  lancerFilet('MoKarade/batchchef-', (cmd, args, opts) => appels.push({ cmd, args, opts }));
  assert.equal(appels[0].cmd, 'gh');
  assert.deepEqual(appels[0].args, ['workflow', 'run', 'reacteur.yml', '--repo', 'MoKarade/batchchef-']);
  assert.notEqual(appels[0].opts.shell, true);
});

test('tourQuotidien : onze lancements au premier tour, rien aux suivants du même jour', () => {
  const f = dossier();
  const appels = [];
  const lancer = (...a) => appels.push(a);
  const s1 = tourQuotidien({ fichierEtat: f.etat, executer: true, maintenant: QC('2026-10-18T10:20:00Z'), lancer });
  const s2 = tourQuotidien({ fichierEtat: f.etat, executer: true, maintenant: QC('2026-10-18T10:30:00Z'), lancer });
  assert.equal(appels.length, 11);
  assert.match(s1, /11 lancé\(s\) sur 11, 11\/11 faits/);
  assert.match(s2, /rien \(passage du jour déjà fait\)/);
});

test('tourQuotidien : un échec se dit, ne lève pas, et seul le dépôt en échec est retenté', () => {
  const f = dossier();
  let appels = 0;
  const lancer = (cmd, args) => { appels += 1; if (args.includes('MoKarade/CarAI')) { const e = new Error('boom'); e.stderr = 'HTTP 404: Not Found'; throw e; } };
  const s1 = tourQuotidien({ fichierEtat: f.etat, executer: true, maintenant: QC('2026-10-18T10:20:00Z'), lancer });
  assert.match(s1, /10 lancé\(s\) sur 11.*ÉCHEC \(MoKarade\/CarAI : HTTP 404/);
  const s2 = tourQuotidien({ fichierEtat: f.etat, executer: true, maintenant: QC('2026-10-18T10:30:00Z'), lancer });
  assert.match(s2, /0 lancé\(s\) sur 1/);
  assert.equal(appels, 12);
});

test('tourQuotidien --a-blanc : n\'envoie rien et n\'écrit pas l\'état', () => {
  const f = dossier();
  const s = tourQuotidien({ fichierEtat: f.etat, aBlanc: true, maintenant: QC('2026-10-18T10:20:00Z'), lancer: () => assert.fail('aucun envoi à blanc') });
  assert.match(s, /à blanc, lancerait 11/);
  assert.throws(() => readFileSync(f.etat, 'utf8'));
});

test('tourQuotidien : état illisible ou dossier absent = une ligne, jamais une exception', () => {
  const f = dossier();
  writeFileSync(f.etat, '{pas du json');
  assert.match(tourQuotidien({ fichierEtat: f.etat, executer: true, maintenant: QC('2026-10-18T10:20:00Z'), lancer: () => {} }), /11 lancé/);
  assert.match(tourQuotidien({ fichierEtat: join(f.d, 'absent', 'e.json'), executer: true, maintenant: QC('2026-10-18T10:20:00Z'), lancer: () => {} }), /ÉCHEC/);
});


// --- Jules : confié par le Réacteur depuis le 28/10/2026 (tâche #704) ---
import * as filetPc from './filet-pc.mjs';

test('le tour du PC ne confie plus rien à Jules : le Réacteur le fait à l’événement (tâche #704)', () => {
  assert.equal(filetPc.tourJules, undefined);
});

// ── File Mergify (tâche #285) : remettre en file les PR vertes sorties de la file ───────────────────────────────────────
const MIN_F = 60_000;
const t0F = new Date('2026-10-19T18:00:00Z');
const apresF = (min) => new Date(t0F.getTime() + min * MIN_F);
const PRF = (ref, extra = {}) => ({ ref, draft: false, labels: ['dequeued'], etat_fusion: 'clean', ...extra });

test('file : une PR sortie de la file depuis moins de 10 min est seulement notée', () => {
  const r = evaluerFile({ prs: [PRF('.github#270')], etat: {}, maintenant: t0F });
  assert.deepEqual(r.actions, []);
  assert.equal(r.etat.prs['.github#270'].vu, t0F.toISOString());
});

test('file : après 10 min hors file, la PR est mise à jour', () => {
  const e1 = evaluerFile({ prs: [PRF('.github#270')], etat: {}, maintenant: t0F }).etat;
  const r = evaluerFile({ prs: [PRF('.github#270')], etat: e1, maintenant: apresF(10) });
  assert.deepEqual(r.actions, [{ ref: '.github#270', faire: 'mettre-a-jour', raison: '' }]);
});

test('file : brouillon, étiquette hold ou PR déjà revenue en file (plus de `dequeued`) : rien, et plus suivie', () => {
  const vieux = { prs: { 'a#1': { vu: t0F.toISOString() }, 'a#2': { vu: t0F.toISOString() }, 'a#3': { vu: t0F.toISOString() } } };
  const r = evaluerFile({ prs: [PRF('a#1', { draft: true }), PRF('a#2', { labels: ['dequeued', 'hold'] }), PRF('a#3', { labels: ['queued'] })], etat: vieux, maintenant: apresF(30) });
  assert.deepEqual(r.actions, []);
  assert.deepEqual(r.etat.prs, {});
});

test('file : conflit de fusion = signalement (pas de mise à jour), puis silence 2 h', () => {
  const e1 = evaluerFile({ prs: [PRF('a#1', { etat_fusion: 'dirty' })], etat: {}, maintenant: t0F }).etat;
  const r = evaluerFile({ prs: [PRF('a#1', { etat_fusion: 'dirty' })], etat: e1, maintenant: apresF(12) });
  assert.deepEqual(r.actions, [{ ref: 'a#1', faire: 'signaler', raison: 'conflit de fusion' }]);
  r.etat.prs['a#1'].signale = apresF(12).toISOString();
  assert.deepEqual(evaluerFile({ prs: [PRF('a#1', { etat_fusion: 'dirty' })], etat: r.etat, maintenant: apresF(60) }).actions, []);
  assert.equal(evaluerFile({ prs: [PRF('a#1', { etat_fusion: 'dirty' })], etat: r.etat, maintenant: apresF(12 + 121) }).actions.length, 1);
});

test('file : un seul essai de mise à jour par heure ; ensuite, toujours hors file = signalement', () => {
  const etat = { prs: { 'a#1': { vu: t0F.toISOString(), essai: apresF(10).toISOString() } } };
  assert.deepEqual(evaluerFile({ prs: [PRF('a#1')], etat, maintenant: apresF(40) }).actions.map((a) => a.faire), ['signaler']);
  assert.deepEqual(evaluerFile({ prs: [PRF('a#1')], etat, maintenant: apresF(71) }).actions.map((a) => a.faire), ['mettre-a-jour']);
});

test('file : le message nomme la PR et la raison, sans commande Mergify', () => {
  const m = motifDeLaFile([{ ref: 'a#1', raison: 'conflit de fusion' }]);
  assert.match(m, /^RÉACTEUR : file Mergify : a#1 hors file \(conflit de fusion\)$/);
  assert.doesNotMatch(m, /@mergifyio/);
});

function ghSimule({ prs, detail = {}, put = () => ({}) }) {
  const appels = [];
  const gh = (methode, chemin) => {
    appels.push(`${methode} ${chemin}`);
    if (methode === 'GET' && /\/pulls\?state=open/.test(chemin)) return prs[chemin.match(/repos\/MoKarade\/([^/]+)\//)[1]] ?? [];
    if (methode === 'GET') return { mergeable_state: detail[chemin] ?? 'clean' };
    if (methode === 'PUT') return put(chemin);
    throw new Error('appel inattendu ' + chemin);
  };
  return { gh, appels };
}
const dossierFile = () => join(mkdtempSync(join(tmpdir(), 'file-')), 'etat.json');

test('tourFile : sur 2 tours, la PR sortie de la file est mise à jour par update-branch, sans commande Mergify', () => {
  const f = dossierFile();
  const { gh, appels } = ghSimule({ prs: { '.github': [{ number: 270, draft: false, labels: [{ name: 'dequeued' }] }, { number: 9, draft: false, labels: [] }] } });
  const opts = { fichierEtat: f, executer: true, gh, depots: ['MoKarade/.github'] };
  assert.match(tourFile({ ...opts, maintenant: t0F }), /1 hors file, rien à faire encore/);
  assert.match(tourFile({ ...opts, maintenant: apresF(10) }), /1 mise\(s\) à jour \(\.github#270\)/);
  assert.ok(appels.includes('PUT repos/MoKarade/.github/pulls/270/update-branch'));
  assert.ok(!appels.some((a) => /mergify/i.test(a)));
  assert.equal(JSON.parse(readFileSync(f, 'utf8')).prs['.github#270'].essai, apresF(10).toISOString());
});

test('tourFile : branche déjà à jour (422) = un réveil du Coordinateur, enregistré, pas deux', () => {
  const f = dossierFile();
  const { gh } = ghSimule({
    prs: { '.github': [{ number: 262, draft: false, labels: [{ name: 'dequeued' }] }] },
    put: () => { throw Object.assign(new Error('gh: Update branch failed (HTTP 422)'), { stderr: 'HTTP 422 There are no new commits on the base branch.' }); },
  });
  const lances = [];
  const lancer = (cmd, args) => lances.push([cmd, ...args].join(' '));
  const opts = { fichierEtat: f, executer: true, gh, lancer, depots: ['MoKarade/.github'] };
  tourFile({ ...opts, maintenant: t0F });
  const ligne = tourFile({ ...opts, maintenant: apresF(10) });
  assert.match(ligne, /réveil envoyé \(\.github#262\)/);
  assert.equal(lances.length, 1);
  assert.match(lances[0], /file Mergify : \.github#262 hors file \(branche déjà à jour/);
  tourFile({ ...opts, maintenant: apresF(20) });
  assert.equal(lances.length, 1);
});

test('tourFile : à blanc ne touche à rien ; une erreur GitHub se dit sans faire échouer le tour', () => {
  const f = dossierFile();
  const { gh, appels } = ghSimule({ prs: { '.github': [{ number: 5, draft: false, labels: [{ name: 'dequeued' }] }] } });
  tourFile({ fichierEtat: f, executer: true, gh, depots: ['MoKarade/.github'], maintenant: t0F });
  const blanc = tourFile({ fichierEtat: f, aBlanc: true, gh, depots: ['MoKarade/.github'], maintenant: apresF(11) });
  assert.match(blanc, /\.github#5 mettre-a-jour \(à blanc\)/);
  assert.ok(!appels.some((a) => a.startsWith('PUT')));
  const ko = tourFile({ fichierEtat: f, executer: true, gh: () => { throw new Error('réseau coupé'); }, depots: ['MoKarade/.github'], maintenant: apresF(12) });
  assert.match(ko, /^file : ÉCHEC \(réseau coupé\)/);
});

test('versionDuCode : le sha git de chaque fichier, comme git hash-object ; un fichier absent est dit « absent »', () => {
  const ligne = versionDuCode((nom) => { if (nom === 'acceptation-marquage') throw new Error('absent'); return Buffer.from('abc'); });
  assert.match(ligne, /^code : filet-pc f2ba8f8, jules-suivi f2ba8f8, acceptation-marquage absent, preuves-retard f2ba8f8$/);
  assert.equal(MODULES_VERSION.length, 4);
  // les vrais fichiers de ce dépôt sont tous lisibles
  assert.doesNotMatch(versionDuCode(), /absent/);
});

test('tourAcceptationMarquee : écrit la ligne sur la tâche éligible, dit « non appliqué » à blanc, et une erreur GitHub se dit sans lever', () => {
  const corps = '**Avant** : a\n\n**Après** : b\n\n**Fini quand** : `node --test scripts/x.test.mjs` est vert.\n\n**Fichiers touchés** :\n- `scripts/x.mjs`\n\n**Attend** : aucune\n';
  const issues = [{ number: 7, title: 'Trier', body: corps, labels: [{ name: 'niveau:tâche' }], updated_at: 'u' }];
  const patches = [];
  const gh = (methode, chemin, charge) => {
    if (methode === 'GET' && chemin.includes('/issues?')) return issues;
    if (methode === 'GET') return issues[0];
    patches.push(charge.body);
    return {};
  };
  const blanc = tourAcceptationMarquee({ executer: true, aBlanc: true, gh, depots: ['MoKarade/CarAI'] });
  assert.match(blanc, /^acceptation-marquage : 1 écrite\(s\) \(CarAI#7\) \(non appliqué\)$/);
  assert.equal(patches.length, 0);
  const vrai = tourAcceptationMarquee({ executer: true, gh, depots: ['MoKarade/CarAI'] });
  assert.match(vrai, /^acceptation-marquage : 1 écrite\(s\) \(CarAI#7\)$/);
  assert.match(patches[0], /\*\*Acceptation automatique\*\* : oui/);
  const ko = tourAcceptationMarquee({ executer: true, gh: () => { throw new Error('réseau coupé'); }, depots: ['MoKarade/CarAI'] });
  assert.match(ko, /^acceptation-marquage : 0 écrite\(s\), ÉCHEC CarAI \(réseau coupé\)$/);
});

// ---- Preuves en retard (tâche .github#513) : le tour redit au Coordinateur, puis se tait 4 h ----
test('preuves-retard : le tour envoie le réveil, se tait 4 h ; un échec n’enregistre rien ; à blanc, rien ne part', () => {
  const dossier = mkdtempSync(join(tmpdir(), 'preuves-'));
  const fichierDefauts = join(dossier, 'defauts-preuve.json');
  const fichierEtat = join(dossier, 'etat.json');
  const ecrire = (maintenant) => writeFileSync(fichierDefauts, JSON.stringify({ calcule_le: iso(maintenant), defauts: [{ k: 'fusionnée sans preuve depuis 2 h', ref: 'FinanceAI#1240' }] }));
  ecrire(T0);
  assert.match(tourPreuvesRetard({ fichierDefauts, fichierEtat, aBlanc: true, maintenant: T0, lancer: () => assert.fail('à blanc : rien ne part') }), /à blanc, réveil prévu : RÉACTEUR : preuve en retard : FinanceAI#1240/);
  assert.match(tourPreuvesRetard({ fichierDefauts, fichierEtat, executer: true, maintenant: T0, lancer: () => { throw new Error('gh KO'); } }), /ÉCHEC du réveil/);
  const appels = [];
  ecrire(apres(10));
  assert.match(tourPreuvesRetard({ fichierDefauts, fichierEtat, executer: true, maintenant: apres(10), lancer: (cmd, args) => appels.push([cmd, args]) }), /réveil envoyé \(1 tâche/);
  assert.ok(appels[0][1].some((a) => a === 'texte=RÉACTEUR : preuve en retard : FinanceAI#1240 (fusionnée sans preuve)'));
  ecrire(apres(20));
  assert.match(tourPreuvesRetard({ fichierDefauts, fichierEtat, executer: true, maintenant: apres(20), lancer: () => assert.fail('pas de second réveil') }), /rien/);
  ecrire(apres(251));
  assert.match(tourPreuvesRetard({ fichierDefauts, fichierEtat, executer: true, maintenant: apres(251), lancer: (cmd, args) => appels.push([cmd, args]) }), /réveil envoyé/);
  assert.equal(appels.length, 2);
});

test('preuves-retard : fichier absent, la ligne le dit sans lever', () => {
  assert.match(tourPreuvesRetard({ fichierDefauts: join(tmpdir(), 'nexiste-pas', 'defauts-preuve.json'), fichierEtat: join(tmpdir(), 'x.json'), maintenant: T0 }), /illisible/);
});

test('ligneAppels : total compté, 304 gratuits, rôles les plus lourds d\'abord, rôles à zéro tus (.github#741)', () => {
  const l = ligneAppels({ comptees: 12, n304: 30, req: 42 }, [['réveil', 0], ['file', 3], ['jules-suivi', 8], ['preuves', 1], ['liens', 0]]);
  assert.equal(l, 'appels filet : 12 comptés (30 en 304 gratuits sur 42) [jules-suivi 8, file 3, preuves 1]');
  assert.equal(ligneAppels({ comptees: 0, n304: 5, req: 5 }, [['file', 0]]), 'appels filet : 0 comptés (5 en 304 gratuits sur 5)');
});
