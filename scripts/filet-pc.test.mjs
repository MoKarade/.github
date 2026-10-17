import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { annulerSignalements, evaluerFilet, motifDuFilet, reveiller, tour } from './filet-pc.mjs';

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
