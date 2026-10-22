import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LONGUEUR_MAX } from './reveil-reacteur.mjs';
import { annulerPreuves, evaluerPreuvesRetard, motifDesPreuves } from './preuves-retard.mjs';

const T0 = new Date('2026-10-22T18:00:00Z');
const apres = (min) => new Date(T0.getTime() + min * 60_000);
const defauts = (liste, maintenant = T0) => ({ calcule_le: maintenant.toISOString(), defauts: liste });
const SANS = 'fusionnée sans preuve depuis 2 h';
const PROGRAMMEE = "preuve programmée dépassée depuis plus d'1 h";

test('une tâche en défaut : un réveil qui nomme la tâche et le motif', () => {
  const r = evaluerPreuvesRetard({ defauts: defauts([{ k: SANS, ref: 'FinanceAI#1240' }]), maintenant: T0 });
  assert.deepEqual(r.reveils, [{ ref: 'FinanceAI#1240', k: SANS }]);
  assert.equal(motifDesPreuves(r.reveils), 'RÉACTEUR : preuve en retard : FinanceAI#1240 (fusionnée sans preuve)');
});

test('la même tâche dans les 4 h : rien ; au bout de 4 h : un nouveau réveil', () => {
  const liste = [{ k: SANS, ref: 'FinanceAI#1240' }];
  const r1 = evaluerPreuvesRetard({ defauts: defauts(liste), maintenant: T0 });
  const r2 = evaluerPreuvesRetard({ defauts: defauts(liste, apres(60)), etat: r1.etat, maintenant: apres(60) });
  assert.deepEqual(r2.reveils, []);
  assert.match(r2.raison, /aucune preuve en retard à redire/);
  const r3 = evaluerPreuvesRetard({ defauts: defauts(liste, apres(241)), etat: r2.etat, maintenant: apres(241) });
  assert.equal(r3.reveils.length, 1);
});

test('un autre motif sur la même tâche se dit tout de suite', () => {
  const r1 = evaluerPreuvesRetard({ defauts: defauts([{ k: SANS, ref: 'a#1' }]), maintenant: T0 });
  const r2 = evaluerPreuvesRetard({ defauts: defauts([{ k: PROGRAMMEE, ref: 'a#1' }], apres(10)), etat: r1.etat, maintenant: apres(10) });
  assert.deepEqual(r2.reveils, [{ ref: 'a#1', k: PROGRAMMEE }]);
});

test('une tâche qui attend Marc (qui:marc) a son propre réveil : rien ici', () => {
  const r = evaluerPreuvesRetard({ defauts: defauts([{ k: PROGRAMMEE, ref: 'JobAI#161', marc: true }]), maintenant: T0 });
  assert.deepEqual(r.reveils, []);
});

test('un défaut d’un autre genre (incident, PR longue) n’est pas une preuve en retard', () => {
  const r = evaluerPreuvesRetard({ defauts: defauts([{ k: 'incident ouvert', ref: '.github#468' }, { k: 'PR de plus de 400 lignes', ref: 'driveai#468' }]), maintenant: T0 });
  assert.deepEqual(r.reveils, []);
});

test('defauts-preuve.json périmé (plus de 30 min) ou illisible : rien', () => {
  const vieux = defauts([{ k: SANS, ref: 'a#1' }], T0);
  assert.match(evaluerPreuvesRetard({ defauts: vieux, maintenant: apres(31) }).raison, /périmé/);
  assert.match(evaluerPreuvesRetard({ defauts: null, maintenant: T0 }).raison, /périmé/);
});

test('au plus quatre tâches par message, les autres au tour suivant', () => {
  const six = Array.from({ length: 6 }, (_, i) => ({ k: SANS, ref: `a#${i}` }));
  const r1 = evaluerPreuvesRetard({ defauts: defauts(six), maintenant: T0 });
  assert.equal(r1.reveils.length, 4);
  assert.equal(r1.reste, 2);
  assert.match(motifDesPreuves(r1.reveils, r1.reste), /\+2 autre\(s\) au prochain tour$/);
  const r2 = evaluerPreuvesRetard({ defauts: defauts(six, apres(10)), etat: r1.etat, maintenant: apres(10) });
  assert.deepEqual(r2.reveils.map((r) => r.ref), ['a#4', 'a#5']);
});

test('un doublon dans le fichier ne réveille qu’une fois', () => {
  const r = evaluerPreuvesRetard({ defauts: defauts([{ k: SANS, ref: 'a#1' }, { k: SANS, ref: 'a#1' }]), maintenant: T0 });
  assert.equal(r.reveils.length, 1);
});

test('un réveil raté n’enregistre rien : le tour suivant réessaie', () => {
  const r1 = evaluerPreuvesRetard({ defauts: defauts([{ k: SANS, ref: 'a#1' }]), maintenant: T0 });
  const etat = annulerPreuves(r1.etat, r1.reveils);
  const r2 = evaluerPreuvesRetard({ defauts: defauts([{ k: SANS, ref: 'a#1' }], apres(10)), etat, maintenant: apres(10) });
  assert.equal(r2.reveils.length, 1);
});

test('le texte reste dans la limite du Réacteur', () => {
  const longues = Array.from({ length: 4 }, (_, i) => ({ ref: `un-depot-au-nom-assez-long#${1000 + i}`, k: SANS }));
  assert.ok(motifDesPreuves(longues, 9).length <= LONGUEUR_MAX);
});
