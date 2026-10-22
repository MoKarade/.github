import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { DEPOTS_FILET, annulerSignalements, dateQuebec, evaluerFilet, evaluerOublis, evaluerQuotaMort, evaluerQuotidien, grouperOublis, lancerFilet, ligneOubli, motifDesOublis, motifDuFilet, motifDuQuota, reveiller, tour, tourOublis, tourQuota, tourQuotidien, tourLiens, LIENS_PAR_TOUR, tourJules, evaluerFile, motifDeLaFile, tourFile, versionDuCode, MODULES_VERSION, tourAcceptationMarquee, tourPreuvesRetard } from './filet-pc.mjs';

const T0 = new Date('2026-10-17T18:00:00Z');
const apres = (min, base = T0) => new Date(base.getTime() + min * 60_000);
const iso = (d) => d.toISOString();

const depotLibre = (repo, ref = `${repo.split('/')[1]}#7`) => ({ repo, statut: 'libre', suivante: { ref } });
const depotPartiel = (repo, ref = `${repo.split('/')[1]}#7`) => ({ repo, statut: 'partiel', suivante: { ref }, suivantes: [{ ref }] });
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

// Panne de la mesure du quota du 19-21/10/2026 (.github#337) : la tâche « Quota-Claude » s'est arrêtée 38 h sans qu'aucun réveil ne parte.
const quotaMesure = (heures, maintenant = T0, extra = {}) => ({ calcule_le: iso(maintenant), frein: 'normal', frein_detail: { perime: heures > 3, age_heures: heures, ...extra }, depots: [] });

test('quota : mesure de 7 h, un réveil au texte exact', () => {
  const r = evaluerQuotaMort({ prochaines: quotaMesure(7), maintenant: T0 });
  assert.deepEqual(r.reveils, [{ heures: 7 }]);
  assert.equal(motifDuQuota(r.reveils), 'RÉACTEUR : quota Claude non mesuré depuis 7 h (tâche Quota-Claude du PC arrêtée ?)');
  assert.equal(r.etat.signale, iso(T0));
});

test('quota : sans aucune mesure, un réveil sans durée inventée', () => {
  const r = evaluerQuotaMort({ prochaines: quotaMesure(null, T0, { perime: true, age_heures: null }), maintenant: T0 });
  assert.equal(r.reveils.length, 1);
  assert.equal(motifDuQuota(r.reveils), 'RÉACTEUR : quota Claude non mesuré du tout (tâche Quota-Claude du PC arrêtée ?)');
});

test('quota : mesure de 5 h, mesure fraîche ou frein_detail absent : rien', () => {
  for (const p of [quotaMesure(5), quotaMesure(0.5), { calcule_le: iso(T0), depots: [] }]) {
    assert.deepEqual(evaluerQuotaMort({ prochaines: p, maintenant: T0 }).reveils, []);
  }
});

test('quota : mort après la remise à zéro aussi (apres_reset ne dispense pas de mesurer)', () => {
  assert.equal(evaluerQuotaMort({ prochaines: quotaMesure(38, T0, { apres_reset: true }), maintenant: T0 }).reveils.length, 1);
});

test('quota : un seul réveil par 24 h, puis un autre ; une mesure fraîche efface le signalement', () => {
  const r1 = evaluerQuotaMort({ prochaines: quotaMesure(7), maintenant: T0 });
  const r2 = evaluerQuotaMort({ prochaines: quotaMesure(30, apres(23 * 60), {}), etat: r1.etat, maintenant: apres(23 * 60) });
  assert.deepEqual(r2.reveils, []);
  assert.match(r2.raison, /moins de 24 h/);
  const r3 = evaluerQuotaMort({ prochaines: quotaMesure(31, apres(25 * 60)), etat: r2.etat, maintenant: apres(25 * 60) });
  assert.equal(r3.reveils.length, 1);
  const frais = evaluerQuotaMort({ prochaines: quotaMesure(1, apres(60)), etat: r1.etat, maintenant: apres(60) });
  assert.equal(frais.etat.signale, null);
  assert.equal(evaluerQuotaMort({ prochaines: quotaMesure(8, apres(120)), etat: frais.etat, maintenant: apres(120) }).reveils.length, 1, 'nouvelle panne : réveil tout de suite');
});

test('quota : prochaines.json périmé ou sans date : rien, le signalement est gardé', () => {
  const signale = iso(T0);
  const vieux = evaluerQuotaMort({ prochaines: quotaMesure(40, T0), etat: { signale }, maintenant: apres(31) });
  assert.deepEqual(vieux.reveils, []);
  assert.equal(vieux.etat.signale, signale);
  assert.deepEqual(evaluerQuotaMort({ prochaines: { frein_detail: { perime: true, age_heures: 40 } }, maintenant: T0 }).reveils, []);
});

test('quota : le tour envoie le réveil ; un échec n’enregistre rien et le tour suivant réessaie ; à blanc rien', () => {
  const dossier = mkdtempSync(join(tmpdir(), 'quota-'));
  const fichierProchaines = join(dossier, 'prochaines.json');
  const fichierEtat = join(dossier, 'etat.json');
  writeFileSync(fichierProchaines, JSON.stringify(quotaMesure(38)));
  assert.match(tourQuota({ fichierProchaines, fichierEtat, aBlanc: true, maintenant: T0, lancer: () => assert.fail('à blanc') }), /à blanc, réveil prévu : RÉACTEUR : quota Claude non mesuré depuis 38 h/);
  assert.match(tourQuota({ fichierProchaines, fichierEtat, executer: true, maintenant: T0, lancer: () => { throw new Error('gh KO'); } }), /ÉCHEC du réveil/);
  const appels = [];
  assert.match(tourQuota({ fichierProchaines, fichierEtat, executer: true, maintenant: apres(10), lancer: (cmd, args) => appels.push([cmd, args]) }), /réveil envoyé/);
  assert.equal(appels.length, 1);
  assert.ok(appels[0][1].some((a) => a.startsWith('texte=RÉACTEUR : quota Claude non mesuré depuis 38 h')));
  writeFileSync(fichierProchaines, JSON.stringify(quotaMesure(38, apres(20))));
  assert.match(tourQuota({ fichierProchaines, fichierEtat, executer: true, maintenant: apres(20), lancer: () => assert.fail('pas de second réveil') }), /rien/);
  assert.match(tourQuota({ fichierProchaines: join(dossier, 'absent.json'), fichierEtat, maintenant: T0 }), /illisible/);
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
const reservee = [{ repo: 'CarAI', statut: 'rien', reservees_jules: [{ ref: 'carai#7', n: 7 }], occupe_par: [], incidents: [] }];
const ghJules = (corps = corpsJules(7), labels = ['faisable-jules']) => {
  const appels = [];
  const gh = (m, c, b) => { appels.push([m, c, b]); if (m === 'GET' && /labels=|pulls\?/.test(c)) return []; if (m === 'GET') return { state: 'open', labels, body: corps }; return {}; };
  return { gh, appels };
};

test('tourJules confie la tâche réservée d’un dépôt libre quand son corps est une consigne complète, et le retient', () => {
  const { f, etat } = prochainesJules(reservee);
  const { gh, appels } = ghJules();
  const ligne = tourJules({ fichierProchaines: f, fichierEtat: etat, executer: true, maintenant: A12, gh });
  assert.match(ligne, /jules : 1 confiée\(s\) \(carai#7\), 1 dépôt\(s\) avec réservée\(s\), 0 en cours/);
  assert.equal(appels.filter(([m]) => m === 'POST').length, 2);
  assert.equal(JSON.parse(readFileSync(etat, 'utf8')).confies['carai#7'].fois, 1);
});

test('tourJules dit pourquoi une tâche réservée n’est pas prête, sans rien écrire', () => {
  const { f, etat } = prochainesJules(reservee);
  const { gh, appels } = ghJules('Faire le truc.');
  const ligne = tourJules({ fichierProchaines: f, fichierEtat: etat, executer: true, maintenant: A12, gh });
  assert.match(ligne, /0 confiée\(s\).*carai#7 sections absentes/);
  assert.equal(appels.some(([m]) => m === 'POST'), false);
});

test('tourJules ne fait rien sans tâche réservée, à blanc, sans --executer, ni si prochaines.json est périmé', () => {
  const gh = () => { throw new Error('ne doit pas être appelé'); };
  const aucune = prochainesJules([{ repo: 'CarAI', statut: 'libre', reservees_jules: [], occupe_par: [], incidents: [] }]);
  assert.match(tourJules({ fichierProchaines: aucune.f, fichierEtat: aucune.etat, executer: true, maintenant: A12, gh }), /aucune tâche réservée/);
  const r = prochainesJules(reservee);
  const lecture = ghJules();
  assert.match(tourJules({ fichierProchaines: r.f, fichierEtat: r.etat, aBlanc: true, maintenant: A12, gh: lecture.gh }), /\(à blanc\)/);
  assert.equal(lecture.appels.some(([m]) => m === 'POST'), false);
  const sans = ghJules();
  assert.match(tourJules({ fichierProchaines: r.f, fichierEtat: r.etat, maintenant: A12, gh: sans.gh }), /0 confiée\(s\), sautée\(s\) carai#7 \(non confiée\)/);
  assert.equal(sans.appels.some(([m]) => m === 'POST'), false);
  assert.match(tourJules({ fichierProchaines: r.f, fichierEtat: r.etat, executer: true, maintenant: new Date('2026-10-19T13:00:00Z'), gh }), /périmé/);
});

test('tourJules ne reconfie pas une tâche déjà confiée deux fois, et rapporte un échec d’API sans lever', () => {
  const { f, etat } = prochainesJules(reservee);
  writeFileSync(etat, JSON.stringify({ confies: { 'carai#7': { fois: 2 } } }));
  const { gh, appels } = ghJules();
  assert.match(tourJules({ fichierProchaines: f, fichierEtat: etat, executer: true, maintenant: A12, gh }), /0 confiée\(s\).*déjà confiée 2 fois/);
  assert.equal(appels.length, 0);
  const ligne = tourJules({ fichierProchaines: f, fichierEtat: join(tmpdir(), 'inexistant-jules.json'), executer: true, maintenant: A12, gh: () => { throw new Error('HTTP 403'); } });
  assert.match(ligne, /^jules : (ÉCHEC|0 confiée)/);
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
  const ligne = versionDuCode((nom) => { if (nom === 'jules-auto') throw new Error('absent'); return Buffer.from('abc'); });
  assert.match(ligne, /^code : filet-pc f2ba8f8, jules-suivi f2ba8f8, jules-marquage f2ba8f8, jules-gabarit f2ba8f8, jules-auto absent, fichiers-touches f2ba8f8, acceptation-marquage f2ba8f8, preuves-retard f2ba8f8$/);
  assert.equal(MODULES_VERSION.length, 8);
  // les vrais fichiers de ce dépôt sont tous lisibles
  assert.doesNotMatch(versionDuCode(), /absent/);
});

test('deux places par dépôt : un dépôt partiel (une place libre, une tâche compatible) réveille après 30 min ; occupé ou sans suivante, jamais', () => {
  const r = rejouer([depotPartiel('MoKarade/JobAI')], 40);
  assert.deepEqual(r.tous, [{ depot: 'MoKarade/JobAI', ref: 'JobAI#7', minutes: 40 }].map((x) => ({ ...x, minutes: r.tous[0].minutes })));
  assert.equal(r.tous.length, 1);
  assert.deepEqual(rejouer([depotPartiel('MoKarade/JobAI', undefined)].map((d) => ({ ...d, suivante: null })), 60).tous, []);
  assert.deepEqual(rejouer([depotOccupe('MoKarade/JobAI')], 60).tous, []);
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
