import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ajouterAHistorique, lireVivant, mesurer } from './verif-fidelite.mjs';

// Données fictives, aucun réseau. Relevé à 12:00, règle « tâche liée » en vigueur depuis 06:00 le même jour.
const ASOF = '2026-10-16T12:00:00Z';
const DEPUIS = '2026-10-16T06:00:00Z';
const noeud = (n, extra = {}) => ({ n, lvl: 'tâche', title: `t${n}`, labels: ['niveau:tâche'], state: 'open', closed: null, pr: null, start: null, ...extra });
const releve = (nodes) => ({ asof: ASOF, repos: [{ repo: 'Hubperso', key: 'hub', name: 'Hubperso', nodes: Object.fromEntries(nodes.map((n) => [n.n, n])) }] });
const issue = (number, extra = {}) => ({ number, state: 'open', labels: [{ name: 'niveau:tâche' }], updated_at: '2026-10-16T10:00:00Z', created_at: '2026-10-16T08:00:00Z', closed_at: null, ...extra });
const pull = (number, extra = {}) => ({ number, state: 'open', merged_at: null, created_at: '2026-10-16T09:00:00Z', updated_at: '2026-10-16T09:30:00Z', body: 'Tâche : #1', user: { login: 'MoKarade', type: 'User' }, head: { ref: 'claude/x' }, draft: false, ...extra });
const vivant = (issues = [], pulls = [], branches = []) => ({ Hubperso: { issues, pulls, branches } });
const mesure = (r, v, extra = {}) => mesurer({ releve: r, vivant: v, depuis: DEPUIS, defauts: 0, ...extra });

test('I2 : un relevé fidèle à GitHub n’a aucun écart', () => {
  const r = releve([noeud(1, { labels: ['niveau:tâche', 'en-cours'], pr: { n: 5, state: 'open', merged: null, created: '2026-10-16T09:00:00Z' }, start: '2026-10-16T08:30:00Z' })]);
  const m = mesure(r, vivant([issue(1, { labels: [{ name: 'en-cours' }, { name: 'niveau:tâche' }] })], [pull(5)]));
  assert.deepEqual(m.i2.ecarts, []);
  assert.equal(m.i2.verifiees, 1);
});

test('I2 : état, étiquettes et PR modifiés après le relevé sont signalés, un à un', () => {
  const r = releve([noeud(1), noeud(2), noeud(3, { pr: { n: 7, state: 'open', merged: null, created: '2026-10-16T09:00:00Z' } })]);
  const v = vivant(
    [issue(1, { state: 'closed', closed_at: '2026-10-16T11:00:00Z' }), issue(2, { labels: [{ name: 'niveau:tâche' }, { name: 'qui:marc' }] }), issue(3)],
    [pull(7, { body: 'Tâche : #3', state: 'closed', merged_at: '2026-10-16T11:00:00Z', updated_at: '2026-10-16T11:00:00Z' })],
  );
  const champs = mesure(r, v).i2.ecarts.map((e) => `${e.ref} ${e.champ}`).sort();
  assert.deepEqual(champs, ['hubperso#1 état', 'hubperso#2 étiquettes', 'hubperso#3 PR liée']);
});

test('I2 : la PR nommée seulement dans le corps de l’issue (ancienne forme) compte comme liée', () => {
  const r = releve([noeud(1, { pr: { n: 5, state: 'closed', merged: '2026-10-15T10:00:00Z', created: '2026-10-15T09:00:00Z' } })]);
  const corps = '**PR déjà ouverte** : #5 (la tâche est marquée `en-cours`)';
  const fusionnee = pull(5, { body: 'sans ligne de tâche', state: 'closed', merged_at: '2026-10-15T10:00:00Z', updated_at: '2026-10-15T10:00:00Z' });
  assert.deepEqual(mesure(r, vivant([issue(1, { body: corps })], [fusionnee])).i2.ecarts, []);
});

test('I2 : ce qui change après le relevé n’est pas un écart', () => {
  const r = releve([noeud(1)]);
  const m = mesure(r, vivant([issue(1, { state: 'closed', updated_at: '2026-10-16T12:30:00Z' })]));
  assert.deepEqual(m.i2.ecarts, []);
  assert.deepEqual(m.i2.posterieurs, ['hubperso#1']);
});

test('I2 : une tâche vivante absente du relevé, ou une tâche du relevé absente de GitHub', () => {
  const m = mesure(releve([noeud(1)]), vivant([issue(9)]));
  const champs = m.i2.ecarts.map((e) => `${e.ref} ${e.champ}`).sort();
  assert.deepEqual(champs, ['hubperso#1 introuvable', 'hubperso#9 absente du relevé']);
});

test('I2 : une tâche fermée il y a plus de 48 h n’entre pas dans le périmètre', () => {
  const r = releve([noeud(1, { state: 'closed', closed: '2026-10-14T08:00:00Z' })]);
  assert.equal(mesure(r, vivant()).i2.verifiees, 0);
});

test('I3 : une PR ouverte alors que l’issue n’était pas en-cours est non tracée', () => {
  const pr = (c) => ({ n: 5, state: 'open', merged: null, created: c });
  const r = releve([
    noeud(1, { pr: pr('2026-10-16T09:00:00Z'), start: '2026-10-16T08:00:00Z' }),
    noeud(2, { pr: pr('2026-10-16T09:00:00Z'), start: '2026-10-16T09:30:00Z' }),
    noeud(3, { pr: pr('2026-10-16T09:00:00Z') }),
    noeud(4, { pr: pr('2026-10-15T09:00:00Z') }),
  ]);
  const { prise } = mesure(r, vivant()).i3;
  assert.equal(prise.total, 3);
  assert.deepEqual(prise.non_tracees, ['hubperso#2', 'hubperso#3']);
});

test('I3 : `en-cours` posé par le balayage dans les 10 minutes qui suivent l’ouverture compte comme tracé, pas à 11 minutes', () => {
  const pr = { n: 5, state: 'open', merged: null, created: '2026-10-16T09:00:00Z' };
  const r = releve([
    noeud(1, { pr, start: '2026-10-16T09:10:00Z' }),
    noeud(2, { pr, start: '2026-10-16T09:10:01Z' }),
  ]);
  const { prise } = mesure(r, vivant()).i3;
  assert.equal(prise.total, 2);
  assert.deepEqual(prise.non_tracees, ['hubperso#2']);
});

test('I3 : PR fusionnée sans tâche (robots et PR citant une tâche exclus), branche sans tâche', () => {
  const fusion = { state: 'closed', merged_at: '2026-10-16T10:00:00Z' };
  const v = vivant([], [
    pull(10, { ...fusion, body: 'sans lien' }),
    pull(11, { ...fusion, body: 'Tâche : #1' }),
    pull(12, { ...fusion, body: '', user: { login: 'dependabot[bot]', type: 'Bot' } }),
    pull(13, { ...fusion, body: 'sans lien', merged_at: '2026-10-16T05:00:00Z' }),
    pull(14, { head: { ref: 'claude/avec' }, body: 'Tâche : #1' }),
  ], [
    { name: 'claude/avec', date: '2026-10-16T09:00:00Z' },
    { name: 'claude/sans', date: '2026-10-16T09:00:00Z' },
    { name: 'claude/ancienne', date: '2026-10-15T09:00:00Z' },
    { name: 'claude/boite-reacteur', date: '2026-10-16T09:00:00Z' },
  ]);
  const { sans_tache: sans, branches_sans_tache: branches } = mesure(releve([noeud(1)]), v).i3;
  assert.deepEqual(sans, ['hubperso#10']);
  assert.deepEqual(branches, ['hubperso:claude/sans']);
});

test('I3 : en-cours posé depuis plus de 3 h sans PR est signalé, pas avant, pas pour Jules', () => {
  const r = releve([
    noeud(1, { labels: ['niveau:tâche', 'en-cours'], start: '2026-10-16T07:00:00Z' }),
    noeud(2, { labels: ['niveau:tâche', 'en-cours'], start: '2026-10-16T10:30:00Z' }),
    noeud(3, { labels: ['niveau:tâche', 'en-cours', 'jules'], start: '2026-10-16T07:00:00Z' }),
  ]);
  const m = mesure(r, vivant());
  assert.deepEqual(m.i3.prises_sans_pr, ['hubperso#1']);
  assert.match(m.alertes.join(' '), /en-cours sans PR/);
});

test('I4 : accord, écart et lancement non évaluable', () => {
  const r = releve([
    noeud(1, { start: '2026-10-16T10:10:00Z' }),
    noeud(2, { start: '2026-10-16T10:20:00Z' }),
    noeud(3, { start: '2026-10-16T09:00:00Z' }),
    noeud(4, { start: '2026-10-16T07:00:00Z' }),
  ]);
  const snapshots = { hubperso: [{ asof: '2026-10-16T10:00:00Z', statut: 'libre', suivante: 'hubperso#1' }, { asof: '2026-10-16T10:15:00Z', statut: 'libre', suivante: 'hubperso#9' }] };
  const { i4 } = mesure(r, vivant(), { snapshots });
  assert.equal(i4.accords, 1);
  assert.deepEqual(i4.ecarts.map((e) => [e.ref, e.annoncee]), [['hubperso#2', 'hubperso#9']]);
  assert.equal(i4.non_evaluables, 2);
  assert.equal(i4.taux, 0.5);
});

test('I4 : `depuisI4` écarte les lancements d’avant la date de fiabilité sans toucher à I3', () => {
  const r = releve([
    noeud(1, { start: '2026-10-16T10:10:00Z' }),
    noeud(2, { start: '2026-10-16T10:20:00Z' }),
  ]);
  const snapshots = { hubperso: [{ asof: '2026-10-16T10:00:00Z', statut: 'libre', suivante: 'hubperso#1' }, { asof: '2026-10-16T10:15:00Z', statut: 'libre', suivante: 'hubperso#9' }] };
  const tout = mesure(r, vivant(), { snapshots });
  assert.equal(tout.i4.lancements, 2);
  const recent = mesure(r, vivant(), { snapshots, depuisI4: '2026-10-16T10:15:00Z' });
  assert.equal(recent.i4.lancements, 1);
  assert.deepEqual(recent.i4.ecarts.map((e) => e.ref), ['hubperso#2']);
  assert.equal(recent.depuis_i4, '2026-10-16T10:15:00Z');
  assert.equal(recent.depuis, DEPUIS);
  assert.equal(tout.depuis_i4, DEPUIS);
});

test('I4 : un lancement sur une file de plus de 40 min est listé et alerté, pas un lancement récent', () => {
  const r = releve([
    noeud(1, { start: '2026-10-16T10:10:00Z' }),
    noeud(2, { start: '2026-10-16T10:55:00Z' }),
  ]);
  const snapshots = { hubperso: [{ asof: '2026-10-16T10:00:00Z', statut: 'libre', suivante: 'hubperso#1' }, { asof: '2026-10-16T10:50:00Z', statut: 'libre', suivante: 'hubperso#2' }] };
  const frais = mesure(r, vivant(), { snapshots });
  assert.deepEqual(frais.i4.perimes, []);
  const vieux = { hubperso: [{ asof: '2026-10-16T10:00:00Z', statut: 'libre', suivante: 'hubperso#1' }] };
  const m = mesure(r, vivant(), { snapshots: vieux });
  assert.deepEqual(m.i4.perimes.map((x) => [x.ref, x.age_min]), [['hubperso#2', 55]]);
  assert.ok(m.alertes.some((a) => /1 lancement\(s\) sur une file de plus de 40 min : hubperso#2/.test(a)));
});

test('les snapshots gardent la suivante de chaque calcul, sans doublon', () => {
  const prochaines = { calcule_le: '2026-10-16T12:05:00Z', depots: [{ repo: 'Hubperso', statut: 'libre', suivante: { ref: 'hubperso#4' } }] };
  const premier = mesure(releve([]), vivant(), { prochaines });
  const second = mesure(releve([]), vivant(), { prochaines, snapshots: premier.snapshots });
  assert.deepEqual(second.snapshots.hubperso, [{ asof: '2026-10-16T12:05:00Z', statut: 'libre', suivante: 'hubperso#4' }]);
});

test('historique : une ligne par relevé, comptage de queue, aucune remise à zéro cachée', () => {
  const propre = (asof) => ({ ...mesure({ ...releve([]), asof }, vivant()) });
  const sale = { ...mesure({ ...releve([noeud(1)]), asof: '2026-10-16T12:20:00Z' }, vivant()) };
  let f = ajouterAHistorique(null, propre('2026-10-16T12:00:00Z'), 'a');
  f = ajouterAHistorique(f, sale, 'b');
  f = ajouterAHistorique(f, propre('2026-10-16T12:40:00Z'), 'c');
  f = ajouterAHistorique(f, propre('2026-10-16T12:40:00Z'), 'd'); // même relevé : remplacé, pas doublé
  assert.equal(f.historique.length, 3);
  assert.deepEqual(f.historique.map((l) => l.a_zero), [true, false, true]);
  assert.equal(f.consecutifs_a_zero, 1);
  assert.equal(f.preuve.i1_i2, false);
});

test('historique : sans I1 fourni, le relevé ne compte pas à zéro', () => {
  const m = mesurer({ releve: releve([]), vivant: vivant(), depuis: DEPUIS });
  const f = ajouterAHistorique(null, m, 'a');
  assert.equal(f.historique[0].a_zero, false);
  assert.match(f.alertes.join(' '), /I1 non fourni/);
});

test('épreuve négative : une en-cours sans PR, une PR sans tâche et un état changé sont tous détectés', () => {
  const r = releve([
    noeud(1, { labels: ['niveau:tâche', 'en-cours'], start: '2026-10-16T07:00:00Z' }), // en-cours posée sans PR
    noeud(2), // son état change sur GitHub avant le relevé suivant
  ]);
  const v = vivant(
    [issue(1, { labels: [{ name: 'en-cours' }, { name: 'niveau:tâche' }] }), issue(2, { state: 'closed', closed_at: '2026-10-16T11:00:00Z', updated_at: '2026-10-16T11:30:00Z' })],
    [pull(20, { state: 'closed', merged_at: '2026-10-16T11:00:00Z', body: 'PR de test sans tâche' })],
  );
  const m = mesure(r, v);
  assert.deepEqual(m.i3.prises_sans_pr, ['hubperso#1']);
  assert.deepEqual(m.i3.sans_tache, ['hubperso#20']);
  assert.deepEqual(m.i2.ecarts.map((e) => `${e.ref} ${e.champ}`), ['hubperso#2 état']);
  const f = ajouterAHistorique(null, m, 'x');
  assert.equal(f.historique[0].a_zero, false);
  assert.equal(f.preuve.i3, false);
});

test('lireVivant : ouvertes, fermées récentes, PR, branches claude/* ; les PR ne comptent pas comme tâches', () => {
  const appels = [];
  const api = (chemin) => {
    appels.push(chemin);
    if (/\/issues\?state=open/.test(chemin)) return [{ number: 1 }, { number: 2, pull_request: {} }];
    if (/\/issues\?state=closed/.test(chemin)) return [{ number: 3 }];
    if (/\/pulls\?state=open/.test(chemin)) return [{ number: 8 }];
    if (/\/pulls\?state=closed/.test(chemin)) return [{ number: 9, updated_at: '2026-10-15T00:00:00Z' }];
    if (/\/branches\?/.test(chemin)) return [{ name: 'main' }, { name: 'claude/a' }];
    if (/\/branches\/claude\/a/.test(chemin)) return { commit: { commit: { committer: { date: '2026-10-16T09:00:00Z' } } } };
    throw new Error(`chemin inattendu : ${chemin}`);
  };
  const v = lireVivant(api, ['Hubperso'], { asof: ASOF, depuis: DEPUIS });
  assert.deepEqual(v.Hubperso.issues.map((i) => i.number), [1, 3]);
  assert.deepEqual(v.Hubperso.pulls.map((p) => p.number), [8, 9]);
  assert.deepEqual(v.Hubperso.branches, [{ name: 'claude/a', date: '2026-10-16T09:00:00Z' }]);
  assert.ok(appels.some((c) => c.includes('labels=niveau%3At%C3%A2che') && c.includes('state=closed') && c.includes('since=2026-10-15T00:00:00Z')));
});
