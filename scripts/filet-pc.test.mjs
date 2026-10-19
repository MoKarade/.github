import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { DEPOTS_FILET, annulerSignalements, dateQuebec, evaluerFilet, evaluerOublis, evaluerQuotidien, grouperOublis, lancerFilet, ligneOubli, motifDesOublis, motifDuFilet, reveiller, tour, tourOublis, tourQuotidien, tourLiens, LIENS_PAR_TOUR, tourJules } from './filet-pc.mjs';

const T0 = new Date('2026-10-17T18:00:00Z');
const apres = (min, base = T0) => new Date(base.getTime() + min * 60_000);
const iso = (d) => d.toISOString();

const depotLibre = (repo, ref = `${repo.split('/')[1]}#7`) => ({ repo, statut: 'libre', suivante: { ref } });
const depotOccupe = (repo) => ({ repo, statut: 'occupe', suivante: null });
const prochaines = (depots, extra = {}, maintenant = T0) => ({ calcule_le: iso(maintenant), frein: 'normal', depots, ...extra });

// Rejoue des tours toutes les 10 min jusqu'à `fin` minutes et rend le dernier résultat.
function rejouer(depots, fin, { etat = {}, extra = {} } = {}) {
  let r = { etat, reveils: [] };
  const tous = [];
  for (let m = 0; m <= fin; m += 10) {
    const maintenant = apres(m);
    r = evaluerFilet({ prochaines: prochaines(depots, extra, maintenant), etat: r.etat, maintenant });
    tous.push(...r.reveils);
  }
  return { ...r, tous };
}

test('libre + prenable depuis 31 min : un réveil, avec la durée et sans nom de tâche', () => {
  const r = evaluerFilet({ prochaines: prochaines([depotLibre('MoKarade/JobAI')], {}, apres(31)), etat: { 'MoKarade/JobAI': { libre_depuis: iso(T0), vu: iso(apres(21)) } }, maintenant: apres(31) });
  assert.deepEqual(r.reveils, [{ depot: 'MoKarade/JobAI', ref: 'JobAI#7', minutes: 31 }]);
  const motif = motifDuFilet(r.reveils);
  assert.equal(motif, 'RÉACTEUR : filet PC : MoKarade/JobAI libre depuis 31 min sans lancement');
  assert.doesNotMatch(motif, /#\d/);
});

test('libre depuis 20 min seulement : rien', () => {
  const r = rejouer([depotLibre('MoKarade/JobAI')], 20);
  assert.deepEqual(r.tous, []);
  assert.match(r.raison, /aucun dépôt libre depuis plus de 30 min/);
});

test('sur le vrai rythme de 10 min : réveil au tour qui franchit les 30 min, puis plus rien', () => {
  const r = rejouer([depotLibre('MoKarade/JobAI')], 110);
  assert.equal(r.tous.length, 1);
  assert.equal(r.tous[0].minutes, 40);
});

test('même couple (dépôt, tâche) déjà signalé il y a moins de 2 h : rien ; après 2 h : un second réveil', () => {
  const depots = [depotLibre('MoKarade/JobAI')];
  assert.equal(rejouer(depots, 160).tous.length, 2);
  assert.equal(rejouer(depots, 110).tous.length, 1);
});

test('une autre tâche en tête de file est un autre couple : elle réveille aussi', () => {
  let r = rejouer([depotLibre('MoKarade/JobAI', 'JobAI#7')], 40);
  assert.equal(r.tous.length, 1);
  r = evaluerFilet({ prochaines: prochaines([depotLibre('MoKarade/JobAI', 'JobAI#9')], {}, apres(50)), etat: r.etat, maintenant: apres(50) });
  assert.equal(r.reveils.length, 1);
  assert.equal(r.reveils[0].ref, 'JobAI#9');
});

test('frein de quota actif : un dépôt libre avec une suivante permise réveille, un dépôt « frein » (tout retenu) non', () => {
  const retenu = { repo: 'MoKarade/CarAI', statut: 'frein', suivante: null };
  const r = rejouer([depotLibre('MoKarade/JobAI'), retenu], 40, { extra: { frein: '1' } });
  assert.equal(r.tous.length, 1);
  assert.equal(r.tous[0].depot, 'MoKarade/JobAI');
});

test('dépôt occupé, ou libre sans tâche prenable : rien, et le compte repart de zéro', () => {
  let r = rejouer([depotLibre('MoKarade/JobAI')], 20);
  r = evaluerFilet({ prochaines: prochaines([depotOccupe('MoKarade/JobAI')], {}, apres(30)), etat: r.etat, maintenant: apres(30) });
  assert.deepEqual(r.reveils, []);
  assert.equal(r.etat['MoKarade/JobAI']?.libre_depuis, undefined);
  r = evaluerFilet({ prochaines: prochaines([depotLibre('MoKarade/JobAI')], {}, apres(40)), etat: r.etat, maintenant: apres(40) });
  assert.deepEqual(r.reveils, []); // libre depuis 0 min, pas depuis 40
});

test('prochaines.json périmé : rien', () => {
  const r = evaluerFilet({ prochaines: prochaines([depotLibre('MoKarade/JobAI')], {}, T0), etat: { 'MoKarade/JobAI': { libre_depuis: iso(T0), vu: iso(apres(45)) } }, maintenant: apres(50) });
  assert.deepEqual(r.reveils, []);
  assert.match(r.raison, /périmé/);
});

test('une observation de plus de 40 min casse la continuité (PC éteint) : le compte repart de zéro', () => {
  const etat = { 'MoKarade/JobAI': { libre_depuis: iso(T0), vu: iso(apres(10)) } };
  const r = evaluerFilet({ prochaines: prochaines([depotLibre('MoKarade/JobAI')], {}, apres(120)), etat, maintenant: apres(120) });
  assert.deepEqual(r.reveils, []);
  assert.equal(r.etat['MoKarade/JobAI'].libre_depuis, iso(apres(120)));
});

test('plusieurs dépôts libres depuis longtemps : un seul message, tous les dépôts dedans', () => {
  const depots = [depotLibre('MoKarade/JobAI'), depotLibre('MoKarade/CarAI'), depotOccupe('MoKarade/DriveAI')];
  const r = rejouer(depots, 40);
  assert.equal(r.tous.length, 2);
  const motif = motifDuFilet(r.tous);
  assert.match(motif, /JobAI libre depuis 40 min/);
  assert.match(motif, /CarAI libre depuis 40 min/);
  assert.ok(motif.length <= 600);
});

test('evaluerFilet ne modifie pas son entrée', () => {
  const etat = { 'MoKarade/JobAI': { libre_depuis: iso(T0), vu: iso(apres(30)), signale: {} } };
  const copie = JSON.stringify(etat);
  evaluerFilet({ prochaines: prochaines([depotLibre('MoKarade/JobAI')], {}, apres(40)), etat, maintenant: apres(40) });
  assert.equal(JSON.stringify(etat), copie);
});

test('annulerSignalements oublie le signalement pour réessayer au tour suivant', () => {
  const r = rejouer([depotLibre('MoKarade/JobAI')], 40);
  const annule = annulerSignalements(r.etat, r.tous);
  assert.equal(annule['MoKarade/JobAI'].signale['JobAI#7'], undefined);
  const encore = evaluerFilet({ prochaines: prochaines([depotLibre('MoKarade/JobAI')], {}, apres(50)), etat: annule, maintenant: apres(50) });
  assert.equal(encore.reveils.length, 1);
});

test('reveiller lance boite-reacteur.yml d\'app-template avec le motif, sans shell', () => {
  const appels = [];
  reveiller('RÉACTEUR : x', (cmd, args, opts) => appels.push({ cmd, args, opts }));
  assert.equal(appels[0].cmd, 'gh');
  assert.deepEqual(appels[0].args, ['workflow', 'run', 'boite-reacteur.yml', '--repo', 'MoKarade/app-template', '--ref', 'main', '-f', 'texte=RÉACTEUR : x']);
  assert.notEqual(appels[0].opts.shell, true);
});

// --- le tour complet, avec fichiers ---
function dossier() {
  const d = mkdtempSync(join(tmpdir(), 'filet-pc-'));
  return { prochaines: join(d, 'prochaines.json'), etat: join(d, 'etat.json'), d };
}

test('tour : réveil envoyé au 4e relevé, état gardé, rien au relevé suivant', () => {
  const f = dossier();
  const appels = [];
  const lancer = (...a) => appels.push(a);
  const sorties = [];
  for (let m = 0; m <= 50; m += 10) {
    writeFileSync(f.prochaines, JSON.stringify(prochaines([depotLibre('MoKarade/JobAI')], {}, apres(m))));
    sorties.push(tour({ fichierProchaines: f.prochaines, fichierEtat: f.etat, executer: true, maintenant: apres(m), lancer }));
  }
  assert.equal(appels.length, 1);
  assert.match(sorties[4], /réveil envoyé \(MoKarade\/JobAI\)/);
  assert.match(sorties[5], /filet PC : rien/);
});

test('tour : si gh échoue, la ligne le dit, le tour ne lève pas et le suivant réessaie', () => {
  const f = dossier();
  let n = 0;
  const lancer = () => { n += 1; if (n === 1) { const e = new Error('boom'); e.stderr = 'HTTP 403: Resource not accessible'; throw e; } };
  const sorties = [];
  for (let m = 0; m <= 50; m += 10) {
    writeFileSync(f.prochaines, JSON.stringify(prochaines([depotLibre('MoKarade/JobAI')], {}, apres(m))));
    sorties.push(tour({ fichierProchaines: f.prochaines, fichierEtat: f.etat, executer: true, maintenant: apres(m), lancer }));
  }
  assert.match(sorties[4], /ÉCHEC du réveil \(HTTP 403/);
  assert.match(sorties[5], /réveil envoyé/);
  assert.equal(n, 2);
});

test('tour --a-blanc : décide et imprime le motif, n\'envoie rien et n\'écrit pas l\'état', () => {
  const f = dossier();
  writeFileSync(f.etat, JSON.stringify({ 'MoKarade/JobAI': { libre_depuis: iso(T0), vu: iso(apres(30)) } }));
  writeFileSync(f.prochaines, JSON.stringify(prochaines([depotLibre('MoKarade/JobAI')], {}, apres(40))));
  const avant = readFileSync(f.etat, 'utf8');
  const s = tour({ fichierProchaines: f.prochaines, fichierEtat: f.etat, aBlanc: true, maintenant: apres(40), lancer: () => assert.fail('aucun envoi à blanc') });
  assert.match(s, /à blanc, réveil prévu : RÉACTEUR : filet PC : MoKarade\/JobAI libre depuis 40 min/);
  assert.equal(readFileSync(f.etat, 'utf8'), avant);
});

test('tour : prochaines.json absent ou illisible = une ligne, jamais une exception', () => {
  const f = dossier();
  assert.match(tour({ fichierProchaines: f.prochaines, fichierEtat: f.etat }), /illisible/);
  writeFileSync(f.prochaines, '{pas du json');
  assert.match(tour({ fichierProchaines: f.prochaines, fichierEtat: f.etat }), /illisible/);
});

// --- passage quotidien du Réacteur (MoKarade/.github#143) ---
const QC = (iso8601) => new Date(iso8601); // 10:25Z = 6 h 25 à Québec en heure d'été (UTC-4), 11:25Z = 6 h 25 en heure d'hiver (UTC-5)

test('dateQuebec : heure d\'été puis heure d\'hiver, et le jour change à minuit du Québec, pas d\'UTC', () => {
  assert.deepEqual(dateQuebec(QC('2026-10-18T10:25:00Z')), { jour: '2026-10-18', minutes: 6 * 60 + 25 });
  assert.deepEqual(dateQuebec(QC('2026-11-02T11:25:00Z')), { jour: '2026-11-02', minutes: 6 * 60 + 25 });
  assert.deepEqual(dateQuebec(QC('2026-10-19T03:30:00Z')), { jour: '2026-10-18', minutes: 23 * 60 + 30 });
});

test('quotidien : avant 6 h du Québec rien ; dès 6 h les dix dépôts, le jour même une seule fois', () => {
  assert.equal(evaluerQuotidien({ maintenant: QC('2026-10-18T09:59:00Z') }).a_lancer.length, 0);
  assert.match(evaluerQuotidien({ maintenant: QC('2026-10-18T09:59:00Z') }).raison, /avant 6 h/);
  const r = evaluerQuotidien({ maintenant: QC('2026-10-18T10:00:00Z') });
  assert.deepEqual(r.a_lancer, DEPOTS_FILET);
  assert.equal(DEPOTS_FILET.length, 10);
  assert.equal(new Set(DEPOTS_FILET).size, 10);
  const fait = { ...r.etat, faits: [...DEPOTS_FILET] };
  const apres = evaluerQuotidien({ etat: fait, maintenant: QC('2026-10-18T15:00:00Z') });
  assert.deepEqual(apres.a_lancer, []);
  assert.match(apres.raison, /déjà fait/);
  assert.equal(evaluerQuotidien({ etat: fait, maintenant: QC('2026-10-19T10:05:00Z') }).a_lancer.length, 10); // le lendemain, tout repart
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

test('tourQuotidien : dix lancements au premier tour, rien aux suivants du même jour', () => {
  const f = dossier();
  const appels = [];
  const lancer = (...a) => appels.push(a);
  const s1 = tourQuotidien({ fichierEtat: f.etat, executer: true, maintenant: QC('2026-10-18T10:20:00Z'), lancer });
  const s2 = tourQuotidien({ fichierEtat: f.etat, executer: true, maintenant: QC('2026-10-18T10:30:00Z'), lancer });
  assert.equal(appels.length, 10);
  assert.match(s1, /10 lancé\(s\) sur 10, 10\/10 faits/);
  assert.match(s2, /rien \(passage du jour déjà fait\)/);
});

test('tourQuotidien : un échec se dit, ne lève pas, et seul le dépôt en échec est retenté', () => {
  const f = dossier();
  let appels = 0;
  const lancer = (cmd, args) => { appels += 1; if (args.includes('MoKarade/CarAI')) { const e = new Error('boom'); e.stderr = 'HTTP 404: Not Found'; throw e; } };
  const s1 = tourQuotidien({ fichierEtat: f.etat, executer: true, maintenant: QC('2026-10-18T10:20:00Z'), lancer });
  assert.match(s1, /9 lancé\(s\) sur 10.*ÉCHEC \(MoKarade\/CarAI : HTTP 404/);
  const s2 = tourQuotidien({ fichierEtat: f.etat, executer: true, maintenant: QC('2026-10-18T10:30:00Z'), lancer });
  assert.match(s2, /0 lancé\(s\) sur 1/);
  assert.equal(appels, 11);
});

test('tourQuotidien --a-blanc : n\'envoie rien et n\'écrit pas l\'état', () => {
  const f = dossier();
  const s = tourQuotidien({ fichierEtat: f.etat, aBlanc: true, maintenant: QC('2026-10-18T10:20:00Z'), lancer: () => assert.fail('aucun envoi à blanc') });
  assert.match(s, /à blanc, lancerait 10/);
  assert.throws(() => readFileSync(f.etat, 'utf8'));
});

test('tourQuotidien : état illisible ou dossier absent = une ligne, jamais une exception', () => {
  const f = dossier();
  writeFileSync(f.etat, '{pas du json');
  assert.match(tourQuotidien({ fichierEtat: f.etat, executer: true, maintenant: QC('2026-10-18T10:20:00Z'), lancer: () => {} }), /10 lancé/);
  assert.match(tourQuotidien({ fichierEtat: join(f.d, 'absent', 'e.json'), executer: true, maintenant: QC('2026-10-18T10:20:00Z'), lancer: () => {} }), /ÉCHEC/);
});


// ---- Tâches oubliées : un réveil par racine et par 24 h ----
const oubliee = (ref, racine, extra = {}) => ({ ref, titre: `Tâche ${ref}`, cause: 'geste-marc-en-retard', racine, proprietaire: 'marc', heures: 96, ...extra });
const avecOublis = (oubliees, maintenant = T0) => ({ calcule_le: iso(maintenant), depots: [], oubliees });
const GESTE = [oubliee('a#1', 'a#1'), oubliee('a#2', 'a#1'), oubliee('a#3', 'a#1')];

test('oublis : les tâches retenues par un même geste donnent UN signal, qui dit combien d’autres attendent', () => {
  const g = grouperOublis(GESTE);
  assert.equal(g.length, 1);
  assert.equal(ligneOubli(g[0]), 'geste de Marc en retard depuis 4 j : a#1 (retient 2 autres)');
});

test('oublis : sans responsable, fil silencieux et geste de Marc ont chacun leur ligne, Marc en premier', () => {
  const g = grouperOublis([
    oubliee('c#1', 'c#1', { proprietaire: 'fil', cause: 'fil-silencieux', heures: 32 }),
    oubliee('b#1', 'b#1', { proprietaire: 'personne', cause: 'bloquee-sans-reprise' }),
    oubliee('a#1', 'a#1'),
  ]);
  assert.deepEqual(g.map(ligneOubli), ['geste de Marc en retard depuis 4 j : a#1', 'sans responsable (bloquee-sans-reprise) : b#1', 'fil silencieux depuis 32 h : c#1']);
});

test('oublis : un réveil, puis plus rien pendant 24 h, puis il recommence tant que la tâche est oubliée', () => {
  const p = (m) => avecOublis(GESTE, m);
  const r1 = evaluerOublis({ prochaines: p(T0), etat: {}, maintenant: T0 });
  assert.equal(r1.reveils.length, 1);
  assert.equal(motifDesOublis(r1.reveils), 'RÉACTEUR : oubli : geste de Marc en retard depuis 4 j : a#1 (retient 2 autres)');
  const r2 = evaluerOublis({ prochaines: p(apres(23 * 60)), etat: r1.etat, maintenant: apres(23 * 60) });
  assert.deepEqual(r2.reveils, []);
  assert.match(r2.raison, /aucune tâche oubliée à signaler/);
  const r3 = evaluerOublis({ prochaines: p(apres(25 * 60)), etat: r2.etat, maintenant: apres(25 * 60) });
  assert.equal(r3.reveils.length, 1, 'rappel du lendemain');
});

test('oublis : au plus quatre racines par message, les autres au tour suivant', () => {
  const beaucoup = Array.from({ length: 6 }, (_, i) => oubliee(`r#${i}`, `r#${i}`));
  const r1 = evaluerOublis({ prochaines: avecOublis(beaucoup), etat: {}, maintenant: T0 });
  assert.equal(r1.reveils.length, 4);
  assert.equal(r1.reste, 2);
  assert.match(motifDesOublis(r1.reveils, r1.reste), /\+2 autre\(s\) au prochain tour/);
  const r2 = evaluerOublis({ prochaines: avecOublis(beaucoup, apres(10)), etat: r1.etat, maintenant: apres(10) });
  assert.deepEqual(r2.reveils.map((g) => g.racine), ['r#4', 'r#5']);
});

test('oublis : prochaines.json périmé, rien ; une racine résolue sort de l’état au bout de 24 h', () => {
  const vieux = evaluerOublis({ prochaines: avecOublis(GESTE, T0), etat: {}, maintenant: apres(31) });
  assert.deepEqual(vieux.reveils, []);
  assert.match(vieux.raison, /périmé/);
  const r1 = evaluerOublis({ prochaines: avecOublis(GESTE), etat: {}, maintenant: T0 });
  const r2 = evaluerOublis({ prochaines: avecOublis([], apres(25 * 60)), etat: r1.etat, maintenant: apres(25 * 60) });
  assert.deepEqual(r2.etat, { signale: {} });
});

test('oublis : le tour envoie le réveil, garde l’état ; un échec n’enregistre rien et le tour suivant réessaie', () => {
  const dossier = mkdtempSync(join(tmpdir(), 'oublis-'));
  const fichierProchaines = join(dossier, 'prochaines.json');
  const fichierEtat = join(dossier, 'etat.json');
  writeFileSync(fichierProchaines, JSON.stringify(avecOublis(GESTE)));
  const appels = [];
  const echec = tourOublis({ fichierProchaines, fichierEtat, executer: true, maintenant: T0, lancer: () => { throw new Error('gh KO'); } });
  assert.match(echec, /ÉCHEC du réveil/);
  const ok = tourOublis({ fichierProchaines, fichierEtat, executer: true, maintenant: apres(10), lancer: (cmd, args) => appels.push([cmd, args]) });
  assert.match(ok, /réveil envoyé \(1 racine/);
  assert.equal(appels.length, 1);
  assert.ok(appels[0][1].some((a) => a.startsWith('texte=RÉACTEUR : oubli : geste de Marc en retard')));
  writeFileSync(fichierProchaines, JSON.stringify(avecOublis(GESTE, apres(20))));
  assert.match(tourOublis({ fichierProchaines, fichierEtat, executer: true, maintenant: apres(20), lancer: () => assert.fail('pas de second réveil') }), /rien/);
  assert.equal(JSON.parse(readFileSync(fichierEtat, 'utf8')).signale['a#1'] !== undefined, true);
});

test('oublis : à blanc, rien n’est envoyé ni enregistré', () => {
  const dossier = mkdtempSync(join(tmpdir(), 'oublis-'));
  const fichierProchaines = join(dossier, 'prochaines.json');
  writeFileSync(fichierProchaines, JSON.stringify(avecOublis(GESTE)));
  const ligne = tourOublis({ fichierProchaines, fichierEtat: join(dossier, 'etat.json'), aBlanc: true, maintenant: T0, lancer: () => assert.fail('à blanc') });
  assert.match(ligne, /à blanc, réveil prévu : RÉACTEUR : oubli/);
});


// --- Liens : les dépendances écrites en `**Attend**` deviennent des liens natifs « Bloquée par » ---

const prochainesAvecLiens = (liens, calcule = '2026-10-19T12:00:00Z') => {
  const dir = mkdtempSync(join(tmpdir(), 'liens-'));
  const f = join(dir, 'prochaines.json');
  writeFileSync(f, JSON.stringify({ calcule_le: calcule, liens_manquants: liens }));
  return f;
};
const A12 = new Date('2026-10-19T12:10:00Z');

test('tourLiens pose les liens manquants et le dit en une ligne', () => {
  const f = prochainesAvecLiens([{ ref: 'a#2', attend: 'a#1' }]);
  const appels = [];
  const ligne = tourLiens({ fichierProchaines: f, executer: true, maintenant: A12, gh: (m, c) => { appels.push(m); return { id: 1 }; } });
  assert.match(ligne, /liens : 1 posé\(s\), 0 déjà là/);
  assert.deepEqual(appels, ['GET', 'POST']);
});

test('tourLiens ne pose rien à blanc, ni sans --executer, ni si prochaines.json est périmé', () => {
  const f = prochainesAvecLiens([{ ref: 'a#2', attend: 'a#1' }]);
  const gh = () => { throw new Error('ne doit pas être appelé'); };
  assert.match(tourLiens({ fichierProchaines: f, aBlanc: true, maintenant: A12, gh }), /1 à poser \(à blanc\)/);
  assert.match(tourLiens({ fichierProchaines: f, maintenant: A12, gh }), /1 à poser, non posés/);
  assert.match(tourLiens({ fichierProchaines: f, executer: true, maintenant: new Date('2026-10-19T13:00:00Z'), gh }), /périmé/);
});

test('tourLiens dit « tous posés » quand rien ne manque, et plafonne un tour', () => {
  assert.equal(tourLiens({ fichierProchaines: prochainesAvecLiens([]), executer: true, maintenant: A12 }), 'liens : tous posés');
  const beaucoup = Array.from({ length: LIENS_PAR_TOUR + 5 }, (_, i) => ({ ref: `a#${i + 100}`, attend: 'a#1' }));
  const ligne = tourLiens({ fichierProchaines: prochainesAvecLiens(beaucoup), executer: true, maintenant: A12, gh: () => ({ id: 1 }) });
  assert.match(ligne, new RegExp(`${LIENS_PAR_TOUR} posé\\(s\\).*5 au prochain tour`));
});

test('tourLiens rapporte un échec d\'API sans lever', () => {
  const f = prochainesAvecLiens([{ ref: 'a#2', attend: 'a#1' }]);
  const ligne = tourLiens({ fichierProchaines: f, executer: true, maintenant: A12, gh: () => { throw new Error('HTTP 403 Resource not accessible'); } });
  assert.match(ligne, /ÉCHEC 1 \(HTTP 403/);
});

// --- Jules sans quota (demande de Marc du 19/10/2026) ---
const corpsJules = (n) => ['Avant : le fichier n\'a pas de test.', 'Après : un test le couvre.', 'Fini quand : `npm test` vert.', 'Fichiers permis (aucun autre) :\n- `lib/x.test.ts`', 'À faire : 1. écrire.', 'À ne pas faire : toucher `lib/x.ts`.', 'Vérifier : `npm test`', `À citer dans la PR : \`Tâche : #${n}\``]
  .map((l) => l.replace(/^([^:]+?)( \([^)]*\))? :/, '**$1**$2 :')).join('\n\n');
const prochainesJules = (depots, calcule = '2026-10-19T12:00:00Z') => {
  const dir = mkdtempSync(join(tmpdir(), 'jules-'));
  const f = join(dir, 'prochaines.json');
  writeFileSync(f, JSON.stringify({ calcule_le: calcule, frein: 2, depots }));
  return { f, etat: join(dir, 'etat-jules.json') };
};
const auFrein = [{ repo: 'CarAI', statut: 'frein', retenues_frein: [{ ref: 'carai#7', n: 7 }] }];
const ghJules = (corps = corpsJules(7)) => {
  const appels = [];
  const gh = (m, c, b) => { appels.push([m, c, b]); if (m === 'GET' && /labels=/.test(c)) return []; if (m === 'GET') return { state: 'open', labels: [], body: corps }; return {}; };
  return { gh, appels };
};

test('tourJules confie la tâche retenue par le frein quand son corps est une consigne complète, et le retient', () => {
  const { f, etat } = prochainesJules(auFrein);
  const { gh, appels } = ghJules();
  const ligne = tourJules({ fichierProchaines: f, fichierEtat: etat, executer: true, maintenant: A12, gh });
  assert.match(ligne, /jules : 1 confiée\(s\) \(carai#7\), 1 dépôt\(s\) au frein/);
  assert.equal(appels.filter(([m]) => m === 'POST').length, 2);
  assert.equal(JSON.parse(readFileSync(etat, 'utf8')).confies['carai#7'].fois, 1);
});

test('tourJules dit pourquoi une tâche retenue n’est pas prête, sans rien écrire', () => {
  const { f, etat } = prochainesJules(auFrein);
  const { gh, appels } = ghJules('Faire le truc.');
  const ligne = tourJules({ fichierProchaines: f, fichierEtat: etat, executer: true, maintenant: A12, gh });
  assert.match(ligne, /0 confiée\(s\).*carai#7 sections absentes/);
  assert.equal(appels.some(([m]) => m === 'POST'), false);
});

test('tourJules ne fait rien hors frein, à blanc, sans --executer, ni si prochaines.json est périmé', () => {
  const gh = () => { throw new Error('ne doit pas être écrit'); };
  const libre = prochainesJules([{ repo: 'CarAI', statut: 'libre', retenues_frein: [{ ref: 'carai#7', n: 7 }] }]);
  assert.match(tourJules({ fichierProchaines: libre.f, fichierEtat: libre.etat, executer: true, maintenant: A12, gh }), /aucun dépôt au frein/);
  const frein = prochainesJules(auFrein);
  const lecture = ghJules();
  assert.match(tourJules({ fichierProchaines: frein.f, fichierEtat: frein.etat, aBlanc: true, maintenant: A12, gh: lecture.gh }), /\(à blanc\)/);
  assert.equal(lecture.appels.some(([m]) => m === 'POST'), false);
  const sans = ghJules();
  assert.match(tourJules({ fichierProchaines: frein.f, fichierEtat: frein.etat, maintenant: A12, gh: sans.gh }), /0 confiée\(s\), sautée\(s\) carai#7 \(non confiée\)/);
  assert.equal(sans.appels.some(([m]) => m === 'POST'), false);
  assert.match(tourJules({ fichierProchaines: frein.f, fichierEtat: frein.etat, executer: true, maintenant: new Date('2026-10-19T13:00:00Z'), gh }), /périmé/);
});

test('tourJules ne reconfie pas une tâche déjà confiée deux fois, et rapporte un échec d’API sans lever', () => {
  const { f, etat } = prochainesJules(auFrein);
  writeFileSync(etat, JSON.stringify({ confies: { 'carai#7': { fois: 2 } } }));
  const { gh, appels } = ghJules();
  assert.match(tourJules({ fichierProchaines: f, fichierEtat: etat, executer: true, maintenant: A12, gh }), /0 confiée\(s\).*déjà confiée 2 fois/);
  assert.equal(appels.length, 0);
  const ligne = tourJules({ fichierProchaines: f, fichierEtat: join(tmpdir(), 'inexistant-jules.json'), executer: true, maintenant: A12, gh: () => { throw new Error('HTTP 403'); } });
  assert.match(ligne, /^jules : (ÉCHEC|0 confiée)/);
});
