// Tests de la recherche des dépendants d'autres dépôts (scripts/dependants-autres-depots.mjs, tâche MoKarade/.github#870) : une fausse API en mémoire, aucun réseau.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { attendCetteTache, cleTache, dependantsAutresDepots } from './dependants-autres-depots.mjs';

const tache = (number, attend, extra = {}) => ({ number, state: 'open', labels: [{ name: 'niveau:tâche' }], body: `**Fini quand** : x\n**Attend** : ${attend}\n`, ...extra });
const DEPOTS = ['MoKarade/app-template', 'MoKarade/CarAI', 'MoKarade/JobAI', 'MoKarade/batchchef-', 'MoKarade/DriveAI'];
const api = (parDepot) => async (methode, chemin) => {
  const depot = /^\/repos\/(MoKarade\/[^/]+)\//.exec(chemin)[1];
  const v = parDepot[depot];
  if (v instanceof Error) throw v;
  return v ?? [];
};

test('cleTache : minuscules, nom court', () => {
  assert.equal(cleTache('MoKarade/App-Template', 213), 'app-template#213');
});

test('attendCetteTache : citée, non citée, autre étiquette, PR, même dépôt', () => {
  const base = { depotIssue: 'MoKarade/CarAI', depot: 'MoKarade/app-template', numero: 213 };
  assert.equal(attendCetteTache({ ...base, issue: tache(252, 'app-template#213 — la nav') }), true);
  assert.equal(attendCetteTache({ ...base, issue: tache(252, 'MoKarade/app-template#213') }), true);
  assert.equal(attendCetteTache({ ...base, issue: tache(252, 'app-template#212') }), false);
  assert.equal(attendCetteTache({ ...base, issue: tache(252, 'aucune') }), false);
  assert.equal(attendCetteTache({ ...base, issue: tache(252, 'app-template#213', { labels: [{ name: 'mission' }] }) }), false);
  assert.equal(attendCetteTache({ ...base, issue: tache(252, 'app-template#213', { pull_request: {} }) }), false);
  assert.equal(attendCetteTache({ ...base, depotIssue: 'MoKarade/app-template', issue: tache(252, 'app-template#213') }), false);
});

test('tâche citée par un autre dépôt : un seul dépendant par dépôt, avec ses tâches', async () => {
  const lecture = api({ 'MoKarade/CarAI': [tache(252, 'app-template#213'), tache(253, 'aucune')], 'MoKarade/JobAI': [tache(327, 'app-template#213'), tache(328, 'app-template#213')], 'MoKarade/app-template': [tache(214, 'app-template#213')] });
  const r = await dependantsAutresDepots({ api: lecture, depot: 'MoKarade/app-template', numero: 213, depots: DEPOTS });
  assert.deepEqual(r.dependants, [{ depot: 'MoKarade/CarAI', taches: [252] }, { depot: 'MoKarade/JobAI', taches: [327, 328] }]);
  assert.deepEqual(r.illisibles, []);
});

test('aucune citation : aucun dépendant', async () => {
  const r = await dependantsAutresDepots({ api: api({ 'MoKarade/CarAI': [tache(252, 'aucune')] }), depot: 'MoKarade/app-template', numero: 213, depots: DEPOTS });
  assert.deepEqual(r.dependants, []);
});

test('batchchef- : l’alias court est reconnu', async () => {
  const r = await dependantsAutresDepots({ api: api({ 'MoKarade/CarAI': [tache(9, 'batchchef#368')] }), depot: 'MoKarade/batchchef-', numero: 368, depots: DEPOTS });
  assert.deepEqual(r.dependants, [{ depot: 'MoKarade/CarAI', taches: [9] }]);
});

test('un dépôt illisible n’empêche pas les autres et est dit', async () => {
  const lecture = api({ 'MoKarade/DriveAI': new Error('HTTP 404'), 'MoKarade/CarAI': [tache(252, 'app-template#213')] });
  const r = await dependantsAutresDepots({ api: lecture, depot: 'MoKarade/app-template', numero: 213, depots: DEPOTS });
  assert.deepEqual(r.dependants, [{ depot: 'MoKarade/CarAI', taches: [252] }]);
  assert.deepEqual(r.illisibles, ['MoKarade/DriveAI']);
});

test('aucun secret ni minuteur dans le script', () => {
  const code = readFileSync(new URL('./dependants-autres-depots.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(code, /secrets\.|schedule:|cron:/);
});
