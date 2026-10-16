import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculer, ECARTS_ETIQUETTE } from './prochaine-tache.mjs';

// Un relevé en mémoire : données fictives, aucun réseau. Même forme que backlog.json (fetch.py).
const tache = (n, o = {}) => ({
  n, title: `Tâche ${n}`, lvl: 'tâche', labels: ['niveau:tâche', ...(o.labels ?? [])], state: o.state ?? 'open',
  url: `https://github.com/exemple/depot/issues/${n}`, kids: [], start: o.start ?? null, closed: o.closed ?? null,
  pr: o.pr ?? null, deps: o.deps ?? [], fq: 'fq' in o ? o.fq : 'une commande de test passe',
});
const mission = (n, kids, labels = []) => ({ n, title: `Mission ${n}`, lvl: 'mission', labels: ['niveau:mission', ...labels], state: 'open', kids, deps: [] });
const chantier = (n, kids, labels = []) => ({ n, title: `Chantier ${n}`, lvl: 'chantier', labels: ['niveau:chantier', ...labels], state: 'open', kids, deps: [] });
const depot = (repo, noeuds, extra = {}) => ({
  repo, name: extra.name ?? repo, key: extra.key ?? repo.slice(0, 3), incidents: extra.incidents ?? [],
  nodes: Object.fromEntries(noeuds.map((n) => [String(n.n), n])),
});
const releve = (...depots) => ({ asof: '2026-10-16T12:00:00Z', repos: depots, prlog: [] });
const prOuverte = (n) => ({ n, state: 'open', merged: null, kind: 'tache' });

const suivante = (resultat, nomDepot = 'a') => resultat.depots.find((d) => d.repo === nomDepot).suivante?.ref ?? null;
const etat = (resultat, nomDepot = 'a') => resultat.depots.find((d) => d.repo === nomDepot);

test('une tâche ouverte avec un « Fini quand » est la suivante', () => {
  const r = calculer(releve(depot('a', [tache(1)])));
  assert.equal(etat(r).statut, 'libre');
  assert.equal(suivante(r), 'a#1');
});

test('chaque étiquette d’écart sort la tâche de la file, avec sa raison', () => {
  for (const [etiquette, code] of Object.entries(ECARTS_ETIQUETTE)) {
    const r = calculer(releve(depot('a', [tache(1, { labels: [etiquette] }), tache(2)])));
    assert.equal(etat(r).exclues['a#1'].code, code, etiquette);
    assert.equal(etat(r).file.some((f) => f.ref === 'a#1'), false, etiquette);
  }
});

test('une dépendance ouverte écarte, une dépendance fermée laisse passer, une inconnue écarte', () => {
  const r = calculer(releve(
    depot('a', [tache(1, { deps: ['a#2'] }), tache(2), tache(3, { deps: ['a#4'] }), tache(4, { state: 'closed', closed: '2026-10-16T10:00:00Z' }), tache(5, { deps: ['a#99'] }), tache(6, { deps: ['b#7'] })]),
    depot('b', [tache(7)]),
  ));
  const a = etat(r);
  assert.equal(a.exclues['a#1'].code, 'attend-ouverte');
  assert.equal(a.exclues['a#5'].code, 'attend-inconnue');
  assert.equal(a.exclues['a#6'].code, 'attend-ouverte', 'dépendance vers un autre dépôt');
  assert.deepEqual(a.file.map((f) => f.ref), ['a#2', 'a#3']);
});

test('une tâche qui attend une PR : fusionnée, l\u2019attente est levée ; sinon la dépendance reste inconnue', () => {
  const b = releve(depot('a', [tache(1, { deps: ['a#10'] })], { key: 'alp' }));
  assert.equal(etat(calculer(b)).exclues['a#1'].code, 'attend-inconnue');
  const fusionnee = { ...b, prlog: [{ r: 'alp', n: 10, m: '2026-10-16T09:00:00Z' }] };
  assert.equal(suivante(calculer(fusionnee)), 'a#1');
});

test('une PR ouverte qui cite la tâche l’écarte et occupe le dépôt', () => {
  const r = calculer(releve(depot('a', [tache(1, { pr: prOuverte(10) }), tache(2)])));
  assert.equal(etat(r).exclues['a#1'].code, 'pr-ouverte');
  assert.equal(etat(r).statut, 'occupe');
  assert.equal(etat(r).suivante, null);
  assert.equal(etat(r).file[0].ref, 'a#2', 'la file existe quand même, pour l’affichage');
});

test('une PR fermée ou fusionnée n’écarte pas la tâche', () => {
  const r = calculer(releve(depot('a', [tache(1, { pr: { n: 10, state: 'closed', merged: null } })])));
  assert.equal(suivante(r), 'a#1');
});

test('sans « Fini quand » écrit, la tâche n’est pas prenable', () => {
  for (const fq of [undefined, null, '', '   ']) {
    const r = calculer(releve(depot('a', [tache(1, { fq })])));
    assert.equal(etat(r).exclues['a#1'].code, 'fini-quand-absent');
    assert.equal(etat(r).statut, 'rien');
  }
});

test('tri : prio croissante puis numéro ; sans étiquette prio = prio:3', () => {
  const r = calculer(releve(depot('a', [tache(5), tache(3, { labels: ['prio:3'] }), tache(9, { labels: ['prio:2'] })])));
  assert.deepEqual(etat(r).file.map((f) => f.ref), ['a#9', 'a#3', 'a#5']);
});

test('preuve-manquante passe avant prio:1, prio:1 avant la sécurité, la sécurité avant le reste', () => {
  const r = calculer(releve(depot('a', [
    tache(1), tache(2, { labels: ['sécurité', 'prio:2'] }), tache(3, { labels: ['prio:1'] }), tache(4, { labels: ['preuve-manquante', 'prio:3'] }),
  ])));
  assert.deepEqual(etat(r).file.map((f) => f.ref), ['a#4', 'a#3', 'a#2', 'a#1']);
  assert.deepEqual(etat(r).file.map((f) => f.tier), [1, 2, 3, 7]);
});

test('une PR fusionnée dont la tâche reste ouverte : la preuve est due avant tout travail neuf', () => {
  const r = calculer(releve(depot('a', [tache(1, { labels: ['prio:1'] }), tache(2, { pr: { n: 10, state: 'closed', merged: '2026-10-16T09:00:00Z' } })])));
  assert.deepEqual(etat(r).file.map((f) => [f.ref, f.tier]), [['a#2', 1], ['a#1', 2]]);
  // Si un fil la porte encore (`en-cours`) ou si la preuve est programmée, elle n'est pas à reprendre.
  const fil = calculer(releve(depot('a', [tache(2, { labels: ['en-cours'], pr: { n: 10, state: 'closed', merged: '2026-10-16T09:00:00Z' } })])));
  assert.equal(etat(fil).exclues['a#2'].code, 'en-cours');
  const programmee = calculer(releve(depot('a', [tache(2, { labels: ['preuve-attendue'], pr: { n: 10, state: 'closed', merged: '2026-10-16T09:00:00Z' } })])));
  assert.equal(etat(programmee).exclues['a#2'].code, 'preuve-attendue');
  assert.equal(etat(programmee).statut, 'rien');
});

test('un incident ouvert rend le statut « incident » et masque la suivante', () => {
  const r = calculer(releve(depot('a', [tache(1)], { incidents: [{ n: 50, t: 'Panne', url: 'u' }] })));
  assert.equal(etat(r).statut, 'incident');
  assert.equal(etat(r).suivante, null);
  assert.equal(etat(r).incidents[0].n, 50);
});

test('capacité : en-cours et jules occupent le dépôt, preuve-attendue ne l’occupe pas', () => {
  for (const [etiquette, motif] of [['en-cours', 'en-cours'], ['jules', 'jules']]) {
    const r = calculer(releve(depot('a', [tache(1, { labels: [etiquette] }), tache(2)])));
    assert.equal(etat(r).statut, 'occupe', etiquette);
    assert.equal(etat(r).occupe_par[0].motif, motif);
    assert.equal(etat(r).suivante, null);
  }
  const libre = calculer(releve(depot('a', [tache(1, { labels: ['preuve-attendue'] }), tache(2)])));
  assert.equal(etat(libre).statut, 'libre');
  assert.equal(suivante(libre), 'a#2');
});

test('un fil actif passé en option occupe le dépôt (par nom, clé ou dépôt)', () => {
  for (const nom of ['a', 'Alpha', 'alp']) {
    const r = calculer(releve(depot('a', [tache(1)], { name: 'Alpha', key: 'alp' })), { filsActifs: [nom] });
    assert.equal(etat(r).statut, 'occupe', nom);
    assert.equal(etat(r).occupe_par[0].motif, 'fil-actif');
  }
});

test('aucune tâche prenable : statut « rien », jamais de travail inventé', () => {
  const r = calculer(releve(depot('a', [tache(1, { labels: ['qui:marc'] })])));
  assert.equal(etat(r).statut, 'rien');
  assert.equal(etat(r).suivante, null);
  assert.deepEqual(etat(r).file, []);
});

test('les tâches fermées ne sont jamais dans la file', () => {
  const r = calculer(releve(depot('a', [tache(1, { state: 'closed', closed: '2026-10-16T10:00:00Z' }), tache(2)])));
  assert.deepEqual(etat(r).file.map((f) => f.ref), ['a#2']);
});

// Chantier 10 > missions 11 et 12 ; la dernière tâche fermée (a#1) est dans la mission 11.
const arbre = (extraChantier = []) => [
  chantier(10, [11, 12], extraChantier), mission(11, [1, 2]), mission(12, [3]),
  tache(1, { state: 'closed', closed: '2026-10-16T10:00:00Z' }), tache(2), tache(3),
];

test('chantier en cours jusqu’au bout : même mission, puis même chantier, puis le reste', () => {
  const r = calculer(releve(depot('a', [...arbre(), chantier(20, [21]), mission(21, [4]), tache(4, { labels: ['prio:2'] })])));
  // a#4 a une meilleure prio mais n'est pas dans le chantier en cours.
  assert.deepEqual(etat(r).file.map((f) => [f.ref, f.tier]), [['a#2', 4], ['a#3', 5], ['a#4', 7]]);
});

test('prio:1 passe devant le chantier en cours', () => {
  const r = calculer(releve(depot('a', [...arbre(), chantier(20, [21]), mission(21, [4]), tache(4, { labels: ['prio:1'] })])));
  assert.equal(suivante(r), 'a#4');
});

test('la dernière tâche lancée compte comme la dernière fermée', () => {
  // a#3 (mission 12) est lancée plus tard que a#1 fermée : la mission 12 devient « en cours ».
  const noeuds = [chantier(10, [11, 12]), mission(11, [1, 2]), mission(12, [3, 5]),
    tache(1, { state: 'closed', closed: '2026-10-16T10:00:00Z' }), tache(2), tache(3, { state: 'closed', closed: '2026-10-16T11:00:00Z' }), tache(5)];
  assert.equal(suivante(calculer(releve(depot('a', noeuds)))), 'a#5');
});

test('alternance : si la dernière tâche vient d’un chantier standard, on prend une fonction', () => {
  const noeuds = [
    chantier(10, [11], ['chantier:standard']), mission(11, [1]), tache(1, { state: 'closed', closed: '2026-10-16T10:00:00Z' }),
    chantier(20, [21], ['chantier:standard']), mission(21, [2]), tache(2),
    chantier(30, [31], ['chantier:fonction']), mission(31, [3]), tache(3, { labels: ['prio:3'] }),
  ];
  const r = calculer(releve(depot('a', noeuds)));
  assert.deepEqual(etat(r).file.map((f) => [f.ref, f.tier]), [['a#3', 6], ['a#2', 7]]);
  assert.deepEqual(r.alertes, []);
});

test('alternance : et inversement (fonction puis standard)', () => {
  const noeuds = [
    chantier(10, [11], ['chantier:fonction']), mission(11, [1]), tache(1, { state: 'closed', closed: '2026-10-16T10:00:00Z' }),
    chantier(20, [21], ['chantier:fonction']), mission(21, [2]), tache(2),
    chantier(30, [31], ['chantier:standard']), mission(31, [3]), tache(3),
  ];
  assert.equal(suivante(calculer(releve(depot('a', noeuds)))), 'a#3');
});

test('chantiers sans type : l’alternance n’est pas inventée, une alerte le dit', () => {
  const noeuds = [
    chantier(10, [11]), mission(11, [1]), tache(1, { state: 'closed', closed: '2026-10-16T10:00:00Z' }),
    chantier(20, [21]), mission(21, [2]), tache(2),
  ];
  const r = calculer(releve(depot('a', noeuds, { name: 'Alpha' })));
  assert.equal(suivante(r), 'a#2');
  assert.match(r.alertes[0], /Alpha.*non calculable/);
});

test('parent dans un autre dépôt (mission commune) : la tâche est rattachée à son chantier', () => {
  const commun = depot('c', [chantier(1, [2]), mission(2, ['a#1', 'a#2'])]);
  const a = depot('a', [tache(1, { state: 'closed', closed: '2026-10-16T10:00:00Z' }), tache(2), tache(3)]);
  const r = calculer(releve(commun, a));
  assert.deepEqual(etat(r).file.map((f) => [f.ref, f.tier]), [['a#2', 4], ['a#3', 7]]);
});

test('le calcul ne modifie pas le relevé et rend le même résultat deux fois', () => {
  const entree = releve(depot('a', [...arbre()]));
  const copie = structuredClone(entree);
  const un = calculer(entree);
  assert.deepEqual(entree, copie);
  assert.deepEqual(calculer(entree), un);
});

test('le résultat dit ce qu’il ne sait pas calculer', () => {
  const r = calculer(releve(depot('a', [tache(1)])));
  assert.ok(r.non_calcule.length >= 3);
  assert.equal(r.source_asof, '2026-10-16T12:00:00Z');
});

test('en ligne de commande : lit un relevé, écrit prochaines.json', () => {
  const dossier = mkdtempSync(join(tmpdir(), 'prochaine-'));
  const entree = join(dossier, 'backlog.json');
  const sortie = join(dossier, 'prochaines.json');
  writeFileSync(entree, JSON.stringify(releve(depot('a', [tache(1)]))));
  const script = fileURLToPath(new URL('./prochaine-tache.mjs', import.meta.url));
  const p = spawnSync(process.execPath, [script, entree, '--sortie', sortie], { encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr);
  const ecrit = JSON.parse(readFileSync(sortie, 'utf8'));
  assert.equal(ecrit.depots[0].suivante.ref, 'a#1');
  assert.ok(ecrit.calcule_le);
  const sansArgument = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(sansArgument.status, 2);
});
