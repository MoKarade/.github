// Tests du guetteur de silence (scripts/guetteur-silence.mjs, tâche MoKarade/.github#720) : une fausse API GitHub en mémoire, aucun réseau.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seuilEnHeures, dernierTraitement, evaluer, guetter, main, TITRE, LABEL } from './guetteur-silence.mjs';

const H = 3_600_000;
const MAINTENANT = Date.parse('2026-10-29T18:00:00Z');
const run = (heuresAvant, conclusion = 'success', status = 'completed') => ({ status, conclusion, updated_at: new Date(MAINTENANT - heuresAvant * H).toISOString() });

/** Fausse API : `runs` et `issues` ouvertes, journal des écritures ; `panne` fait échouer toute lecture. */
function fausseApi({ runs = [], issues = [], panne = false } = {}) {
  const ecritures = [];
  const api = async (methode, chemin, corps) => {
    if (panne) throw new Error('HTTP 502 sur GET');
    if (methode === 'GET' && chemin.includes('/actions/workflows/')) return { workflow_runs: runs };
    if (methode === 'GET' && chemin.includes('/issues?')) return issues;
    ecritures.push({ methode, chemin, corps });
    return methode === 'POST' && chemin.endsWith('/issues') ? { number: 900 } : null;
  };
  return { api, ecritures };
}
const tour = (config, seuilH = 2) => {
  const { api, ecritures } = fausseApi(config);
  const lignes = [];
  return guetter({ api, maintenant: MAINTENANT, seuilH, journal: (l) => lignes.push(l) }).then((r) => ({ ...r, ecritures, lignes }));
};

test('seuilEnHeures : 2 h par défaut, valeur absurde ignorée', () => {
  assert.equal(seuilEnHeures(undefined), 2);
  assert.equal(seuilEnHeures('0'), 2);
  assert.equal(seuilEnHeures('-3'), 2);
  assert.equal(seuilEnHeures('abc'), 2);
  assert.equal(seuilEnHeures('1'), 1);
  assert.equal(seuilEnHeures('0.5'), 0.5);
});

test('dernierTraitement : un run ignoré ou en cours ne compte pas', () => {
  assert.equal(dernierTraitement([run(1, 'skipped'), run(0.1, null, 'in_progress'), run(5)]), MAINTENANT - 5 * H);
  assert.equal(dernierTraitement([run(9, 'failure'), run(4, 'success')]), MAINTENANT - 4 * H);
  assert.equal(dernierTraitement([]), null);
  assert.equal(dernierTraitement(undefined), null);
});

test('evaluer : silence sans issue alerte, silence avec issue rien, reprise, calme', () => {
  const dernier = MAINTENANT - 3 * H;
  assert.equal(evaluer({ maintenant: MAINTENANT, dernier, seuilH: 2, ouverte: null }).action, 'alerter');
  assert.equal(evaluer({ maintenant: MAINTENANT, dernier, seuilH: 2, ouverte: { number: 1 } }).action, 'rien');
  assert.equal(evaluer({ maintenant: MAINTENANT, dernier: MAINTENANT - 0.5 * H, seuilH: 2, ouverte: { number: 1 } }).action, 'reprise');
  assert.equal(evaluer({ maintenant: MAINTENANT, dernier: MAINTENANT - 0.5 * H, seuilH: 2, ouverte: null }).action, 'rien');
  assert.equal(evaluer({ maintenant: MAINTENANT, dernier: null, seuilH: 2, ouverte: null }).action, 'alerter');
});

test('dernier run il y a 3 h : une seule alerte, jamais une seconde', async () => {
  const premier = await tour({ runs: [run(3)] });
  assert.equal(premier.etat, 'alerte');
  assert.equal(premier.ecritures.length, 1);
  assert.equal(premier.ecritures[0].chemin, '/repos/MoKarade/.github/issues');
  assert.deepEqual(premier.ecritures[0].corps.labels, [LABEL]);
  assert.equal(premier.ecritures[0].corps.title, TITRE);
  // le tour suivant voit l'issue ouverte : rien de plus
  const suivant = await tour({ runs: [run(3.2)], issues: [{ number: 900, title: TITRE }] });
  assert.equal(suivant.etat, 'ok');
  assert.equal(suivant.ecritures.length, 0);
});

test('run récent : rien', async () => {
  const r = await tour({ runs: [run(0.3)] });
  assert.equal(r.etat, 'ok');
  assert.equal(r.ecritures.length, 0);
});

test('reprise : un commentaire puis la fermeture de l’issue', async () => {
  const r = await tour({ runs: [run(0.2)], issues: [{ number: 900, title: TITRE }] });
  assert.equal(r.etat, 'reprise');
  assert.deepEqual(r.ecritures.map((e) => `${e.methode} ${e.chemin}`), ['POST /repos/MoKarade/.github/issues/900/comments', 'PATCH /repos/MoKarade/.github/issues/900']);
  assert.equal(r.ecritures[1].corps.state, 'closed');
});

test('API en échec : guetteur aveugle, jamais d’alerte de silence', async () => {
  const r = await tour({ panne: true });
  assert.equal(r.etat, 'aveugle');
  assert.equal(r.ecritures.length, 0);
  assert.match(r.lignes.join('\n'), /aveugle/);
});

test('corps invalide : signalé aveugle, jamais vert ni alerte', async () => {
  const api = async (methode, chemin) => (chemin.includes('/actions/workflows/') ? { pas: 'de runs' } : []);
  const r = await guetter({ api, maintenant: MAINTENANT, journal: () => {} });
  assert.equal(r.etat, 'aveugle');
});

test('un run ignoré par le Réacteur (l’issue d’alerte elle-même) ne masque pas le silence', async () => {
  const r = await tour({ runs: [run(0.01, 'skipped'), run(5)] });
  assert.equal(r.etat, 'alerte');
});

test('main : jeton absent, rien et aucune erreur', async () => {
  const lignes = [];
  const r = await main({}, (l) => lignes.push(l));
  assert.equal(r.etat, 'sans-jeton');
  assert.match(lignes[0], /jeton absent/);
});

test('aucun secret ni minuteur dans le script', async () => {
  const { readFileSync } = await import('node:fs');
  const code = readFileSync(new URL('./guetteur-silence.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(code, /secrets\./);
  assert.doesNotMatch(code, /schedule:|cron:/);
});
