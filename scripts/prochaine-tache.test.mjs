import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculer, choisirSuivantes, couloirsDe, fichiersAbsents, FICHIERS_OBLIGATOIRES, analyserAttentes, liensManquants, indexer, ATTENTE, ATTEND_OBLIGATOIRE, attendAbsent, calculerFrein, permiseParFrein, freinDepuisFichiers, FREIN, ECARTS_ETIQUETTE } from './prochaine-tache.mjs';

test('une alerte du PC (« Entretien du PC », « sur le PC ») ne gèle pas la file : listée dans incidents_pc, la suivante reste proposée', () => {
  for (const titre of ['Entretien du PC : rouge le 21-10', 'Gemini en panne sur le PC']) {
    const r = calculer(releve(depot('a', [tache(1)], { incidents: [{ n: 312, t: titre, url: 'u' }] })));
    assert.equal(etat(r).statut, 'libre', titre);
    assert.equal(suivante(r), 'a#1', titre);
    assert.deepEqual(etat(r).incidents, [], titre);
    assert.deepEqual(etat(r).incidents_pc.map((i) => i.n), [312], titre);
  }
  // une panne de production reste bloquante, même à côté d'une alerte du PC
  const mixte = calculer(releve(depot('a', [tache(1)], { incidents: [{ n: 312, t: 'Entretien du PC : rouge le 21-10', url: 'u' }, { n: 50, t: 'Production en panne', url: 'u' }] })));
  assert.equal(etat(mixte).statut, 'incident');
  assert.deepEqual(etat(mixte).incidents.map((i) => i.n), [50]);
});

// Un relevé en mémoire : données fictives, aucun réseau. Même forme que backlog.json (fetch.py).
const tache = (n, o = {}) => ({
  n, title: `Tâche ${n}`, lvl: 'tâche', labels: ['niveau:tâche', ...(o.labels ?? [])], state: o.state ?? 'open',
  url: `https://github.com/exemple/depot/issues/${n}`, kids: [], start: o.start ?? null, closed: o.closed ?? null,
  pr: o.pr ?? null, deps: o.deps ?? [], ...(o.fpl ? { fpl: o.fpl } : {}), ...('attend_ligne' in o ? { attend_ligne: o.attend_ligne } : {}), ...('ft_ligne' in o ? { ft_ligne: o.ft_ligne } : {}), ...(o.created ? { created: o.created } : {}), fq: 'fq' in o ? o.fq : 'une commande de test passe',
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

// Tâche #197 : une PR qui n'attend que Marc ne rend plus le dépôt occupé. Le relevé (fetch.py) donne `pr_attend_marc`.
const avecAttenteMarc = (d, ...prs) => ({ ...d, pr_attend_marc: prs });

test('#197 valide : la seule PR ouverte attend Marc et une autre tâche est prenable = dépôt libre', () => {
  const r = calculer(releve(avecAttenteMarc(depot('a', [tache(1, { labels: ['en-cours'], pr: prOuverte(10) }), tache(2)]), 10)));
  assert.equal(etat(r).statut, 'libre');
  assert.equal(suivante(r), 'a#2');
  assert.deepEqual(etat(r).occupe_par, []);
  assert.deepEqual(etat(r).attend_marc, [{ ref: 'a#1', pr: 10 }]);
});

test('#197 valide : une tâche sans étiquette en-cours dont la PR attend Marc n’occupe pas non plus', () => {
  const r = calculer(releve(avecAttenteMarc(depot('a', [tache(1, { pr: prOuverte(10) }), tache(2)]), 10)));
  assert.equal(etat(r).statut, 'libre');
  assert.equal(suivante(r), 'a#2');
});

test('#197 rejeté : une PR rouge de CI ordinaire (pas de geste de Marc) garde le dépôt occupé', () => {
  const r = calculer(releve(depot('a', [tache(1, { labels: ['en-cours'], pr: prOuverte(10) }), tache(2)])));
  assert.equal(etat(r).statut, 'occupe');
  assert.equal(suivante(r), null);
  assert.deepEqual(etat(r).attend_marc, []);
});

test('#197 rejeté : le geste porte sur une autre PR, la PR de la tâche en cours occupe toujours', () => {
  const r = calculer(releve(avecAttenteMarc(depot('a', [tache(1, { labels: ['en-cours'], pr: prOuverte(10) }), tache(2)]), 99)));
  assert.equal(etat(r).statut, 'occupe');
});

test('#197 : un autre travail en cours (sans PR en attente de Marc) occupe encore le dépôt', () => {
  const r = calculer(releve(avecAttenteMarc(depot('a', [tache(1, { labels: ['en-cours'], pr: prOuverte(10) }), tache(2, { labels: ['en-cours'] }), tache(3)]), 10)));
  assert.equal(etat(r).statut, 'occupe');
  assert.deepEqual(etat(r).occupe_par.map((o) => o.ref), ['a#2']);
});

test('#197 : la PR en attente de Marc fermée ou fusionnée ne compte plus (le relevé garde l’ancien numéro)', () => {
  const r = calculer(releve(avecAttenteMarc(depot('a', [tache(1, { labels: ['en-cours'], pr: { n: 10, state: 'closed', merged: null } }), tache(2)]), 10)));
  assert.equal(etat(r).statut, 'occupe', 'la tâche reste en-cours sans PR ouverte : le fil n’a pas fini');
  assert.deepEqual(etat(r).attend_marc, []);
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

test('dépôt occupé : `si_libre` garde la tête de file, `suivante` reste vide', () => {
  const r = calculer(releve(depot('a', [tache(1, { labels: ['en-cours'] }), tache(2), tache(3, { labels: ['niveau:tâche', 'prio:1'] })])));
  assert.equal(etat(r).statut, 'occupe');
  assert.equal(etat(r).suivante, null);
  assert.equal(etat(r).si_libre, 'a#3');
  assert.equal(etat(calculer(releve(depot('a', [])))).si_libre, null);
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

test('chantiers sans type : l’alerte nomme le chantier à étiqueter', () => {
  const noeuds = [
    chantier(10, [11]), mission(11, [1]), tache(1, { state: 'closed', closed: '2026-10-16T10:00:00Z' }),
    chantier(20, [21]), mission(21, [2]), tache(2),
  ];
  const r = calculer(releve(depot('a', noeuds, { name: 'Alpha' })));
  assert.match(r.alertes[0], /a#10/);
  assert.match(r.alertes[0], /a#20/);
});

test('mission sans chantier (imbriquée sous une mission) : pas de chantier inventé, pas d’alerte', () => {
  // DriveAI#578 le 16/10 : tâche -> mission 497 -> mission commune ; aucun chantier au-dessus, donc rien à étiqueter.
  const commun = depot('c', [mission(1, ['a#497'])]);
  const a = depot('a', [
    mission(497, [1], []), tache(1, { state: 'closed', closed: '2026-10-16T10:00:00Z' }), tache(2),
    chantier(30, [31], ['chantier:standard']), mission(31, [3]), tache(3),
  ]);
  const r = calculer(releve(commun, a));
  assert.deepEqual(r.alertes, []);
  const file = etat(r).file;
  assert.deepEqual(file.map((f) => [f.ref, f.tier, f.chantier]), [['a#2', 7, null], ['a#3', 7, 'a#30']]);
  assert.equal(file[0].mission, null, 'une tâche libre n’est rattachée à aucune mission');
});

test('mission imbriquée sous une mission, elle-même sous un chantier : le chantier est trouvé', () => {
  const noeuds = [
    chantier(10, [11], ['chantier:standard']), mission(11, [12]), mission(12, [1, 2]),
    tache(1, { state: 'closed', closed: '2026-10-16T10:00:00Z' }), tache(2),
  ];
  const r = calculer(releve(depot('a', noeuds)));
  assert.deepEqual(etat(r).file.map((f) => [f.ref, f.tier, f.mission, f.chantier]), [['a#2', 4, 'a#12', 'a#10']]);
  assert.deepEqual(r.alertes, []);
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

// ---------------------------------------------------------------------------------------------------------------------
// Frein de quota (MoKarade/.github#184) : un nombre, deux seuils, une hystérésis ; aucun réseau, aucune IA.
const MAINTENANT = new Date('2026-10-16T12:00:00Z');
const FRAIS = '2026-10-16T11:30Z'; // 0,5 h
const frein = (pct, precedent, mesureUtc = FRAIS) => calculerFrein({ pct, mesureUtc, precedent, maintenant: MAINTENANT });

test('frein : 79 normal, 80 palier 1, 89 palier 1, 90 palier 2, 91 palier 2', () => {
  assert.deepEqual([79, 80, 89, 90, 91].map((pct) => frein(pct).palier), ['normal', 1, 1, 2, 2]);
  assert.deepEqual(FREIN, { seuil1: 80, seuil2: 90, hysteresis: 2, perimeHeures: 3, perimeMaxHeures: 36, apresResetMin: 15 }, 'les seuils vivent à un seul endroit');
});

test('frein : hystérésis de 2 points, on descend un palier à la fois', () => {
  assert.equal(frein(79, 1).palier, 1, 'sous 80 mais pas sous 78 : on reste au palier 1');
  assert.equal(frein(78, 1).palier, 1);
  assert.equal(frein(77, 1).palier, 'normal', 'sous 78 : retour à normal');
  assert.equal(frein(89, 2).palier, 2);
  assert.equal(frein(88, 2).palier, 2);
  assert.equal(frein(87, 2).palier, 1, 'sous 88 : palier 1, pas normal');
  assert.equal(frein(79, 2).palier, 1);
  assert.equal(frein(70, 2).palier, 'normal');
  assert.equal(frein(80, 'normal').palier, 1, 'la montée est immédiate');
  assert.equal(frein(95, 'normal').palier, 2);
});

test('frein : un relevé de plus de 3 h garde le dernier palier connu et le dit périmé, jamais un faux normal', () => {
  const vieux = '2026-10-16T08:30Z'; // 3,5 h
  const garde = frein(50, 1, vieux);
  assert.equal(garde.palier, 1, 'le pourcentage périmé ne fait pas redescendre');
  assert.equal(garde.detail.perime, true);
  assert.match(garde.detail.raison, /périmé/);
  assert.equal(frein(50, 2, vieux).palier, 2);
  assert.equal(frein(95, 'normal', vieux).palier, 'normal', 'palier précédent connu = normal : il est gardé, pas deviné');
  assert.equal(frein(50, 1, '2026-10-16T09:00Z').detail.perime, false, 'pile 3 h : encore frais');
  // Sans palier précédent, un vieux pourcentage reste la meilleure connaissance.
  assert.equal(frein(85, undefined, vieux).palier, 1);
  assert.equal(frein(85, undefined, vieux).detail.perime, true);
});

// Panne de quota du 19-21/10/2026 (.github#319) : la mesure s'est arrêtée à 100 % avec le quota, le palier 2 est resté après la remise à zéro.
test('frein : mesure d’avant la remise à zéro, passée depuis plus de 15 min = semaine précédente, palier normal dit tel quel', () => {
  const reset = '2026-10-21T12:00:00Z';
  const apres = (minutes, extra = {}) => calculerFrein({ pct: 100, mesureUtc: '2026-10-19T22:04:00Z', precedent: 2, resetUtc: reset, maintenant: new Date(Date.parse(reset) + minutes * 60_000), ...extra });
  const r = apres(16);
  assert.equal(r.palier, 'normal');
  assert.equal(r.detail.apres_reset, true);
  assert.match(r.detail.raison, /remise à zéro .* passée/);
  assert.equal(r.detail.inconnu, false);
  assert.equal(apres(14).detail.apres_reset, false, 'pas avant 15 min : le relevé peut encore arriver');
  const recent = calculerFrein({ pct: 100, mesureUtc: '2026-10-21T10:00:00Z', precedent: 2, resetUtc: reset, maintenant: new Date('2026-10-21T12:14:00Z') });
  assert.equal(recent.palier, 2, 'mesure périmée de 2 h, reset passé depuis 14 min : palier gardé');
  assert.equal(recent.detail.apres_reset, false);
  // Même une mesure fraîche d'avant la remise à zéro (11 h 30, 95 %) ne tient plus 16 min après.
  const fraiche = calculerFrein({ pct: 95, mesureUtc: '2026-10-21T11:30:00Z', precedent: 2, resetUtc: reset, maintenant: new Date('2026-10-21T12:16:00Z') });
  assert.equal(fraiche.palier, 'normal');
  assert.equal(fraiche.detail.apres_reset, true);
});

test('frein : une mesure DEPUIS la remise à zéro reprend la main (pas de faux normal)', () => {
  const reset = '2026-10-21T12:00:00Z';
  const r = calculerFrein({ pct: 92, mesureUtc: '2026-10-21T12:20:00Z', precedent: 'normal', resetUtc: reset, maintenant: new Date('2026-10-21T12:25:00Z') });
  assert.equal(r.palier, 2);
  assert.equal(r.detail.apres_reset, false);
  // Mesure d'avant le reset mais reset inconnu ou invalide : comportement inchangé (dernier palier gardé).
  for (const resetUtc of [undefined, null, 'bientôt']) {
    const g = calculerFrein({ pct: 100, mesureUtc: '2026-10-21T10:00:00Z', precedent: 2, resetUtc, maintenant: new Date('2026-10-21T13:30:00Z') });
    assert.equal(g.palier, 2, String(resetUtc));
    assert.equal(g.detail.perime, true);
    assert.equal(g.detail.apres_reset, false);
  }
});

test('frein : palier 2 sans mesure depuis plus de 36 h et sans remise à zéro passée retombe au palier 1, jamais plus bas', () => {
  const vieux = (heures, precedent, extra = {}) => calculerFrein({ pct: 100, mesureUtc: '2026-10-19T22:04:00Z', precedent, maintenant: new Date(Date.parse('2026-10-19T22:04:00Z') + heures * 3.6e6), ...extra });
  const r = vieux(37, 2);
  assert.equal(r.palier, 1);
  assert.equal(r.detail.plafonne, true);
  assert.match(r.detail.raison, /36 h sans mesure/);
  assert.equal(vieux(36, 2).palier, 2, 'pile 36 h : encore gardé');
  assert.equal(vieux(40, 1).palier, 1, 'le palier 1 n’est pas touché');
  assert.equal(vieux(40, 1).detail.plafonne, false);
  assert.equal(vieux(40, 'normal').palier, 'normal');
  // Une remise à zéro passée prime sur le plafond : normal, pas palier 1.
  assert.equal(vieux(40, 2, { resetUtc: '2026-10-20T12:00:00Z' }).palier, 'normal');
});

test('frein : l’alerte du script dit la remise à zéro passée', () => {
  const f = calculerFrein({ pct: 100, mesureUtc: '2026-10-19T22:04:00Z', precedent: 2, resetUtc: '2026-10-21T12:00:00Z', maintenant: new Date('2026-10-21T12:30:00Z') });
  assert.match(calculer(releve(sorte()), { frein: f }).frein, /normal/);
  assert.equal(calculer(releve(sorte()), { frein: f }).frein_detail.apres_reset, true);
});

test('frein : aucun relevé exploitable = palier précédent, sinon normal MAIS marqué inconnu', () => {
  for (const sansReleve of [{}, { pct: null }, { pct: 'beaucoup', mesureUtc: FRAIS }, { pct: 85, mesureUtc: 'hier' }, { pct: -1, mesureUtc: FRAIS }]) {
    const r = calculerFrein({ ...sansReleve, precedent: 2, maintenant: MAINTENANT });
    assert.equal(r.palier, 2, JSON.stringify(sansReleve));
    assert.equal(r.detail.perime, true);
    assert.equal(r.detail.inconnu, false);
    const premiere = calculerFrein({ ...sansReleve, maintenant: MAINTENANT });
    assert.equal(premiere.palier, 'normal');
    assert.equal(premiere.detail.inconnu, true, 'ce « normal » n’est pas une mesure');
  }
});

// Une tâche de chaque sorte : la file à chaque palier.
const sorte = () => depot('a', [
  tache(1, { labels: ['prio:1'] }), tache(2, { labels: ['prio:2'] }), tache(3, { labels: ['sécurité'] }),
  tache(4, { labels: ['preuve-manquante'] }), tache(5, { labels: ['incident', 'prio:3'] }), tache(6),
]);
const fileA = (r) => etat(r).file.map((f) => f.ref).sort();

test('palier 1 : seules passent prio:1, sécurité, incident et preuve due', () => {
  const r = calculer(releve(sorte()), { frein: frein(80) });
  assert.deepEqual(fileA(r), ['a#1', 'a#3', 'a#4', 'a#5']);
  assert.deepEqual(etat(r).exclues['a#2'], { code: 'frein-quota', detail: 'palier 1' });
  assert.deepEqual(etat(r).exclues['a#6'], { code: 'frein-quota', detail: 'palier 1' });
  assert.equal(etat(r).statut, 'libre');
  assert.equal(r.frein, 1);
});

test('palier 2 : plus de nouvelle tâche, sécurité, incident et preuve due exceptés (prio:1 attend)', () => {
  const r = calculer(releve(sorte()), { frein: frein(90) });
  assert.deepEqual(fileA(r), ['a#3', 'a#4', 'a#5']);
  assert.equal(etat(r).exclues['a#1'].code, 'frein-quota');
  assert.equal(etat(r).exclues['a#1'].detail, 'palier 2');
  assert.equal(r.frein, 2);
});

test('normal : rien n’est retenu ; sans frein passé au calcul, le résultat est celui d’avant', () => {
  const normal = calculer(releve(sorte()), { frein: frein(79) });
  assert.equal(fileA(normal).length, 6);
  assert.equal(normal.alertes.length, 0);
  const sans = calculer(releve(sorte()));
  assert.equal(sans.frein, 'normal');
  assert.equal(sans.frein_detail, null);
  assert.deepEqual(fileA(sans), fileA(normal));
});

test('un dépôt dont toute la file est retenue passe à l’état frein, sans tâche suivante', () => {
  const r = calculer(releve(depot('a', [tache(1, { labels: ['prio:2'] })])), { frein: frein(85) });
  assert.equal(etat(r).statut, 'frein');
  assert.equal(etat(r).suivante, null);
  assert.equal(etat(r).exclues['a#1'].code, 'frein-quota');
  // Un dépôt sans aucune tâche reste « rien », un dépôt occupé reste « occupe » : le frein ne les maquille pas.
  const vide = calculer(releve(depot('a', [])), { frein: frein(85) });
  assert.equal(etat(vide).statut, 'rien');
  const occupe = calculer(releve(depot('a', [tache(1, { labels: ['en-cours'] }), tache(2)])), { frein: frein(85) });
  assert.equal(etat(occupe).statut, 'occupe');
});

test('un incident à 95 % reste lancé : l’état incident et les tâches incident passent, le frein ne les retient pas', () => {
  const incident = { n: 9, t: 'Production en panne', url: 'https://github.com/exemple/depot/issues/9' };
  const r = calculer(releve(depot('a', [tache(5, { labels: ['incident'] }), tache(6)], { incidents: [incident] })), { frein: frein(95) });
  assert.equal(etat(r).statut, 'incident');
  assert.deepEqual(etat(r).incidents.map((i) => i.n), [9]);
  assert.deepEqual(etat(r).file.map((f) => f.ref), ['a#5']);
  assert.equal(r.frein, 2);
});

test('l’ordre de la file ne change pas pour ce qui passe, et les rangs se suivent sans trou', () => {
  const r = calculer(releve(sorte()), { frein: frein(80) });
  assert.deepEqual(etat(r).file.map((f) => f.rang), [1, 2, 3, 4]);
  assert.deepEqual(etat(r).file.map((f) => f.tier), [...etat(r).file.map((f) => f.tier)].sort((a, b) => a - b));
  assert.equal(etat(r).suivante.ref, etat(r).file[0].ref);
});

test('une alerte du script dit le palier, et le quota périmé', () => {
  assert.match(calculer(releve(sorte()), { frein: frein(80) }).alertes.join(' '), /Frein de quota, palier 1 : quota à 80 %/);
  assert.match(calculer(releve(sorte()), { frein: frein(50, 1, '2026-10-16T08:00Z') }).alertes.join(' '), /palier 1 : quota périmé/);
  assert.deepEqual(calculer(releve(sorte()), { frein: frein(50) }).alertes, []);
});

test('permiseParFrein : table complète des cas', () => {
  const cas = (labels, tier = 7) => ({ labels, tier });
  for (const palier of ['normal', 1, 2]) assert.equal(permiseParFrein(cas([]), palier), palier === 'normal', `reste, palier ${palier}`);
  for (const palier of ['normal', 1, 2]) {
    assert.equal(permiseParFrein(cas(['incident']), palier), true);
    assert.equal(permiseParFrein(cas(['sécurité']), palier), true);
    assert.equal(permiseParFrein(cas(['securite']), palier), true);
    assert.equal(permiseParFrein(cas([], 1), palier), true, 'preuve due');
  }
  assert.equal(permiseParFrein(cas(['prio:1'], 2), 1), true);
  assert.equal(permiseParFrein(cas(['prio:1'], 2), 2), false);
});

test('en ligne de commande : lit quota.json et le prochaines.json précédent à côté du relevé, sans option', () => {
  const dossier = mkdtempSync(join(tmpdir(), 'frein-'));
  const entree = join(dossier, 'backlog.json');
  const sortie = join(dossier, 'prochaines.json');
  const quota = join(dossier, 'quota.json');
  writeFileSync(entree, JSON.stringify(releve(sorte())));
  const script = fileURLToPath(new URL('./prochaine-tache.mjs', import.meta.url));
  const maintenantIso = () => new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const lancer = (pct, mesure = maintenantIso()) => {
    writeFileSync(quota, JSON.stringify({ jauges: { claude: { utilise: pct, mesure_utc: mesure } } }));
    const tmp = `${sortie}.tmp`; // comme build.py : sortie temporaire, le précédent est lu dans prochaines.json
    const p = spawnSync(process.execPath, [script, entree, '--sortie', tmp], { encoding: 'utf8' });
    assert.equal(p.status, 0, p.stderr);
    writeFileSync(sortie, readFileSync(tmp));
    return JSON.parse(readFileSync(sortie, 'utf8'));
  };
  const palier = (pct) => lancer(pct).frein;
  assert.deepEqual([79, 80, 89, 90, 91].map(palier), ['normal', 1, 1, 2, 2]);
  assert.equal(palier(89), 2, 'précédent 2 (91) : 89 reste au palier 2 par hystérésis');
  assert.equal(palier(87), 1);
  assert.equal(palier(77), 'normal');
  // Relevé périmé : le palier précédent est gardé et dit périmé.
  assert.equal(palier(95), 2);
  const perime = lancer(10, new Date(Date.now() - 5 * 3600 * 1000).toISOString());
  assert.equal(perime.frein, 2);
  assert.equal(perime.frein_detail.perime, true);
  // Quota.json absent : même chose, jamais un faux normal.
  writeFileSync(quota, 'pas du json');
  const tmp = `${sortie}.tmp`;
  assert.equal(spawnSync(process.execPath, [script, entree, '--sortie', tmp], { encoding: 'utf8' }).status, 0);
  assert.equal(JSON.parse(readFileSync(tmp, 'utf8')).frein, 2);
  assert.equal(freinDepuisFichiers(dossier, { quota: join(dossier, 'absent.json'), precedent: join(dossier, 'absent.json') }).detail.inconnu, true);
});

// ---------------------------------------------------------------------------------------------------------------------
// Frein par rythme (MoKarade/.github#198) : le quota est projeté jusqu'à sa remise à zéro ; les seuils 80 / 90 ne sont plus que le secours.
const T_MESURE = new Date('2026-10-17T12:00:00Z');
const heuresAvant = (h, base = T_MESURE) => new Date(base.getTime() - h * 3.6e6).toISOString().slice(0, 16) + 'Z';
const heuresApres = (h, base = T_MESURE) => new Date(base.getTime() + h * 3.6e6).toISOString().slice(0, 16) + 'Z';
// Historique d'une mesure à `pct` qui monte de `rythme` point/h depuis 3 h, remise à zéro dans `restant` heures.
const rythme = (pct, parHeure, restant, { precedent, basDepuis, maintenant = new Date(T_MESURE.getTime() + 5 * 60_000) } = {}) => calculerFrein({
  pct, mesureUtc: heuresAvant(0), precedent, maintenant, basDepuis, resetUtc: heuresApres(restant),
  historique: [3, 2, 1].map((h) => ({ t: heuresAvant(h), pct: pct - parHeure * h })),
});

test('frein par rythme : nuit calme à 80 % (0,1 point/h, 90 h restantes) = normal, avec la valeur et le motif', () => {
  const r = rythme(80, 0.1, 90, { precedent: 'normal' });
  assert.equal(r.palier, 'normal');
  assert.equal(r.detail.mode, 'rythme');
  assert.equal(r.detail.rythme_pt_h, 0.1);
  assert.equal(r.detail.heures_restantes, 90);
  assert.equal(r.detail.projection_pct, 89);
  assert.match(r.detail.raison, /rythme 0\.1 point\/h sur 3 h × 90 h restantes = 89 % projetés/);
});

test('frein par rythme : journée à +2 points/h à 80 % = palier 1, jamais 2 sans le seuil de secours', () => {
  const r = rythme(80, 2, 90, { precedent: 'normal' });
  assert.equal(r.palier, 1);
  assert.equal(r.detail.projection_pct, 260);
  assert.match(r.detail.raison, /260 % projetés.*seules les tâches prio:1/);
});

test('frein par rythme : à 90 % le palier 2 s’impose même avec un rythme nul (secours)', () => {
  assert.equal(rythme(90, 0, 90, { precedent: 'normal' }).palier, 2);
  assert.equal(rythme(95, 0, 90, { precedent: 1 }).palier, 2);
});

test('frein par rythme : le palier 2 se quitte sous 88 % (hystérésis), vers le palier 1 si la projection est haute', () => {
  assert.equal(rythme(89, 0, 90, { precedent: 2 }).palier, 2);
  assert.equal(rythme(87, 2, 90, { precedent: 2 }).palier, 1);
});

test('frein par rythme : la marge — 95 % projetés = palier 1, 94 % projetés = pas de palier', () => {
  assert.equal(rythme(80, 0.25, 60, { precedent: 'normal' }).palier, 1, '80 + 0,25 × 60 = 95');
  assert.equal(rythme(80, 0.25, 59, { precedent: 'normal' }).palier, 'normal', '80 + 0,25 × 59 = 94,75');
});

test('frein par rythme : levée du palier 1 seulement après 30 min de projection basse', () => {
  const t0 = new Date(T_MESURE.getTime() + 5 * 60_000);
  const premier = rythme(80, 0.1, 90, { precedent: 1, maintenant: t0 });
  assert.equal(premier.palier, 1, 'la projection vient de passer sous 90 : on attend');
  assert.equal(premier.detail.bas_depuis, t0.toISOString());
  assert.match(premier.detail.raison, /sous 90 % depuis 0 min sur 30 : palier 1 gardé/);
  const vingt = rythme(80, 0.1, 90, { precedent: 1, basDepuis: t0.toISOString(), maintenant: new Date(t0.getTime() + 20 * 60_000) });
  assert.equal(vingt.palier, 1);
  assert.equal(vingt.detail.bas_depuis, t0.toISOString());
  const trente = rythme(80, 0.1, 90, { precedent: 1, basDepuis: t0.toISOString(), maintenant: new Date(t0.getTime() + 30 * 60_000) });
  assert.equal(trente.palier, 'normal');
  assert.equal(trente.detail.bas_depuis, null);
});

test('frein par rythme : une projection qui remonte entre 90 et 95 % garde le palier et efface la levée en cours', () => {
  const t0 = new Date(T_MESURE.getTime() + 5 * 60_000);
  const r = rythme(80, 0.25, 45, { precedent: 1, basDepuis: t0.toISOString(), maintenant: new Date(t0.getTime() + 40 * 60_000) }); // 80 + 11,25 = 91,25
  assert.equal(r.palier, 1);
  assert.equal(r.detail.bas_depuis, null);
});

test('frein par rythme : une projection repartie à la hausse pendant la levée garde le palier 1', () => {
  const t0 = new Date(T_MESURE.getTime() + 5 * 60_000);
  const r = rythme(80, 2, 90, { precedent: 1, basDepuis: t0.toISOString(), maintenant: new Date(t0.getTime() + 40 * 60_000) });
  assert.equal(r.palier, 1);
  assert.equal(r.detail.bas_depuis, null);
});

test('frein par rythme : mesure périmée (plus de 3 h) = comportement actuel, dernier palier gardé', () => {
  const r = calculerFrein({ pct: 10, mesureUtc: heuresAvant(0), precedent: 2, maintenant: new Date(T_MESURE.getTime() + 4 * 3.6e6), resetUtc: heuresApres(90), historique: [] });
  assert.equal(r.palier, 2);
  assert.equal(r.detail.perime, true);
  assert.equal(r.detail.mode, 'seuils');
});

test('frein par rythme : sans historique exploitable, retour aux seuils 80 / 90 (comportement actuel)', () => {
  const sans = (extra) => calculerFrein({ pct: 80, mesureUtc: heuresAvant(0), precedent: 'normal', maintenant: new Date(T_MESURE.getTime() + 5 * 60_000), ...extra });
  assert.equal(sans({}).palier, 1, 'ni historique ni remise à zéro');
  assert.equal(sans({ resetUtc: heuresApres(90), historique: [{ t: heuresAvant(0.5), pct: 80 }] }).palier, 1, 'moins d’une heure d’historique');
  assert.equal(sans({ resetUtc: heuresAvant(1), historique: [{ t: heuresAvant(3), pct: 70 }] }).palier, 1, 'remise à zéro passée');
  assert.equal(sans({}).detail.mode, 'seuils');
});

test('frein par rythme : une remise à zéro entre deux points (quota qui baisse) vaut un rythme nul', () => {
  const r = calculerFrein({
    pct: 82, mesureUtc: heuresAvant(0), precedent: 1, maintenant: new Date(T_MESURE.getTime() + 5 * 60_000), resetUtc: heuresApres(160),
    historique: [{ t: heuresAvant(3), pct: 95 }, { t: heuresAvant(2), pct: 96 }, { t: heuresAvant(1), pct: 81 }],
  });
  assert.equal(r.detail.rythme_pt_h, 0);
  assert.equal(r.detail.projection_pct, 82);
});

test('frein par rythme : freinDepuisFichiers lit l’historique et la remise à zéro de quota.json, et la date de levée du calcul précédent', () => {
  const dossier = mkdtempSync(join(tmpdir(), 'frein-rythme-'));
  const maintenant = new Date(T_MESURE.getTime() + 5 * 60_000);
  const quota = { jauges: { claude: { utilise: 80, mesure_utc: heuresAvant(0), reset_utc: heuresApres(90), historique: [3, 2, 1].map((h) => ({ t: heuresAvant(h), pct: 80 - 0.1 * h })) } } };
  writeFileSync(join(dossier, 'quota.json'), JSON.stringify(quota));
  const depuis = new Date(maintenant.getTime() - 35 * 60_000).toISOString();
  writeFileSync(join(dossier, 'prochaines.json'), JSON.stringify({ frein: 1, frein_detail: { bas_depuis: depuis } }));
  const r = freinDepuisFichiers(dossier, { maintenant });
  assert.equal(r.palier, 'normal', 'sous 90 depuis 35 min : levé');
  assert.equal(r.detail.mode, 'rythme');
});

test('frein hybride : sous 80 % de quota le rythme ne joue pas, même à +2 points/h (mode normal des seuils)', () => {
  const r = rythme(79, 2, 90, { precedent: 'normal' });
  assert.equal(r.palier, 'normal');
  assert.equal(r.detail.mode, 'seuils');
  assert.equal(r.detail.projection_pct, null);
  assert.equal(rythme(60, 2, 90, { precedent: 'normal' }).palier, 'normal');
});

test('frein hybride : le palier 1 pris à 80 % ou plus se quitte comme avant, sous 78 % (hystérésis de 2 points)', () => {
  assert.equal(rythme(79, 2, 90, { precedent: 1 }).palier, 1);
  assert.equal(rythme(77, 2, 90, { precedent: 1 }).palier, 'normal');
});


// ---- Tâches oubliées : ce qui retient chaque tâche, qui peut le lever, et ce que personne ne lèvera ----
const NOW = new Date('2026-10-19T12:00:00Z');
// Ces tests ne parlent pas de hiérarchie : les tâches y vivent sans mission, ce que les tests « états » plus bas vérifient à part.
const pasLien = (o) => o.cause !== 'sans-mission';
const il_y_a = (heures) => new Date(NOW.getTime() - heures * 3_600_000).toISOString();
const avec = (t, champs) => ({ ...t, ...champs });
const oublis = (r) => Object.fromEntries(r.oubliees.filter(pasLien).map((o) => [o.ref, o]));

test('une chaîne d’attente se remonte jusqu’au geste de Marc qui la retient, et la file de Marc dit combien de tâches il débloque', () => {
  const r = calculer(releve(depot('a', [
    avec(tache(2, { labels: ['qui:marc'] }), { marc_depuis: il_y_a(96) }),
    tache(1, { deps: ['a#2'] }),
    tache(3, { deps: ['a#1'] }),
  ])), { maintenant: NOW });
  assert.deepEqual(r.attentes['a#3'].chaine, ['a#3', 'a#1', 'a#2']);
  assert.equal(r.attentes['a#3'].racine, 'a#2');
  assert.equal(r.attentes['a#3'].proprietaire, 'marc');
  assert.deepEqual(Object.keys(oublis(r)).sort(), ['a#1', 'a#2', 'a#3']);
  assert.equal(oublis(r)['a#3'].cause, 'geste-marc-en-retard');
  assert.equal(r.file_marc.length, 1);
  assert.deepEqual({ racine: r.file_marc[0].racine, retient: r.file_marc[0].retient, retient_n: r.file_marc[0].retient_n, heures: r.file_marc[0].heures, en_retard: r.file_marc[0].en_retard }, { racine: 'a#2', retient: ['a#1', 'a#3'], retient_n: 2, heures: 96, en_retard: true });
});

test('un geste de Marc isolé dort à partir de 7 jours ; s’il retient d’autres tâches, dès 48 h', () => {
  const isole = (h) => calculer(releve(depot('a', [avec(tache(1, { labels: ['qui:marc'] }), { marc_depuis: il_y_a(h) })])), { maintenant: NOW });
  assert.equal(isole(ATTENTE.marcIsoleHeures - 1).oubliees.filter(pasLien).length, 0);
  assert.equal(isole(ATTENTE.marcIsoleHeures - 1).file_marc[0].en_retard, false, 'il figure dans la file de Marc sans être oublié');
  assert.equal(isole(ATTENTE.marcIsoleHeures).oubliees.filter(pasLien)[0].cause, 'geste-marc-en-retard');
  const retient = (h) => calculer(releve(depot('a', [avec(tache(1, { labels: ['qui:marc'] }), { marc_depuis: il_y_a(h) }), tache(2, { deps: ['a#1'] })])), { maintenant: NOW });
  assert.equal(retient(ATTENTE.marcHeures - 1).oubliees.filter(pasLien).length, 0);
  assert.deepEqual(retient(ATTENTE.marcHeures).oubliees.filter(pasLien).map((o) => o.ref).sort(), ['a#1', 'a#2']);
});

test('sans `marc_depuis` (relevé ancien) la date de dernière mise à jour sert ; sans aucune date, le geste compte comme en retard', () => {
  const sans = calculer(releve(depot('a', [avec(tache(1, { labels: ['qui:marc'] }), { upd: il_y_a(200) })])), { maintenant: NOW });
  assert.equal(sans.oubliees.filter(pasLien)[0].heures, 200);
  const aucune = calculer(releve(depot('a', [tache(1, { labels: ['qui:marc'] })])), { maintenant: NOW });
  assert.equal(aucune.oubliees.filter(pasLien)[0].cause, 'geste-marc-en-retard');
  assert.equal(aucune.oubliees.filter(pasLien)[0].heures, null);
});

test('une preuve attendue n’attend jamais Marc : `preuve-attendue` seule est une preuve de Claude, jamais un geste ni un oubli', () => {
  const r = calculer(releve(depot('a', [avec(tache(1, { labels: ['preuve-attendue'] }), { upd: il_y_a(900) })])), { maintenant: NOW });
  assert.equal(r.attentes['a#1'].proprietaire, 'preuve');
  assert.equal(etat(r).exclues['a#1'].code, 'preuve-attendue');
  assert.equal(r.oubliees.filter(pasLien).length, 0);
  assert.equal(r.file_marc.length, 0);
});

test('`qui:marc` + `preuve-attendue` est une contradiction : exclue comme preuve, hors de la file de Marc, et signalée `preuve-chez-marc`', () => {
  const r = calculer(releve(depot('a', [avec(tache(1, { labels: ['qui:marc', 'preuve-attendue'] }), { upd: il_y_a(5) })])), { maintenant: NOW });
  assert.equal(etat(r).exclues['a#1'].code, 'preuve-attendue', 'jamais affichée comme « attend ton geste »');
  assert.equal(r.file_marc.length, 0, 'Marc n’a pas à prouver');
  assert.deepEqual(r.oubliees.filter(pasLien).map((o) => [o.ref, o.cause, o.proprietaire]), [['a#1', 'preuve-chez-marc', 'personne']]);
});

test('ce que personne ne peut lever est oublié tout de suite : bloquée sans dépendance, dépendance illisible, « Fini quand » absent, boucle', () => {
  const r = calculer(releve(depot('a', [
    tache(1, { labels: ['bloqué'] }),
    tache(2, { deps: ['a#99'] }),
    tache(3, { fq: '' }),
    tache(4, { deps: ['a#5'] }),
    tache(5, { deps: ['a#4'] }),
  ])), { maintenant: NOW });
  const o = oublis(r);
  assert.equal(o['a#1'].cause, 'bloquee-sans-reprise');
  assert.equal(o['a#2'].cause, 'dependance-illisible');
  assert.equal(o['a#3'].cause, 'fini-quand-absent');
  assert.equal(o['a#4'].cause, 'dependance-circulaire');
  assert.equal(o['a#5'].cause, 'dependance-circulaire');
  for (const x of Object.values(o)) assert.equal(x.proprietaire, 'personne');
});

test('une tâche « bloqué » qui attend une tâche prenable n’est pas oubliée : sa racine est dans la file', () => {
  const r = calculer(releve(depot('a', [avec(tache(1, { labels: ['bloqué'] }), { deps: ['a#2'] }), tache(2)])), { maintenant: NOW });
  assert.equal(r.attentes['a#1'].racine, 'a#2');
  assert.equal(r.attentes['a#1'].proprietaire, 'file');
  assert.equal(r.oubliees.filter(pasLien).length, 0);
});

test('un fil qui tient une tâche `en-cours` est oublié quand il se tait depuis le seuil, pas avant', () => {
  const enCours = (h) => calculer(releve(depot('a', [avec(tache(1, { labels: ['en-cours'] }), { upd: il_y_a(h) })])), { maintenant: NOW });
  assert.equal(enCours(ATTENTE.filHeures - 1).oubliees.filter(pasLien).length, 0);
  assert.equal(enCours(ATTENTE.filHeures).oubliees.filter(pasLien)[0].cause, 'fil-silencieux');
  const avecPr = calculer(releve(depot('a', [avec(tache(1, { labels: ['en-cours'], pr: { n: 9, state: 'open', merged: null, upd: il_y_a(1) } }), { upd: il_y_a(60) })])), { maintenant: NOW });
  assert.equal(avecPr.oubliees.filter(pasLien).length, 0, 'la dernière trace est celle de la PR');
});

test('une preuve attendue et un frein de quota ne sont jamais des oublis : une date ou un palier les lève', () => {
  const r = calculer(releve(depot('a', [avec(tache(1, { labels: ['preuve-attendue'] }), { upd: il_y_a(500) }), avec(tache(2, { labels: ['prio:3'] }), { upd: il_y_a(500) })])), {
    maintenant: NOW, frein: { palier: 2, detail: { raison: 'essai' } },
  });
  assert.equal(r.attentes['a#1'].proprietaire, 'preuve');
  assert.equal(r.attentes['a#2'].proprietaire, 'frein');
  assert.equal(r.oubliees.filter(pasLien).length, 0);
});

test('une PR dont seul un geste de Marc retient la fusion compte comme un geste de Marc', () => {
  const d = { ...depot('a', [avec(tache(1, { pr: { ...prOuverte(10), upd: il_y_a(200) } }), { upd: il_y_a(200) })]), pr_attend_marc: [10] };
  const r = calculer(releve(d), { maintenant: NOW });
  assert.equal(r.attentes['a#1'].proprietaire, 'marc');
  assert.equal(r.oubliees.filter(pasLien)[0].cause, 'geste-marc-en-retard');
});

test('la file de Marc met en tête le geste qui retient le plus de tâches', () => {
  const r = calculer(releve(depot('a', [
    avec(tache(1, { labels: ['qui:marc'] }), { marc_depuis: il_y_a(300) }),
    avec(tache(2, { labels: ['qui:marc'] }), { marc_depuis: il_y_a(60) }),
    tache(3, { deps: ['a#2'] }), tache(4, { deps: ['a#2'] }),
  ])), { maintenant: NOW });
  assert.deepEqual(r.file_marc.map((g) => [g.racine, g.retient_n]), [['a#2', 2], ['a#1', 0]]);
});

test('une dépendance fermée ne retient plus ; une mission ouverte retient sans être un oubli', () => {
  const r = calculer(releve(depot('a', [
    tache(1, { deps: ['a#10'] }), tache(10, { state: 'closed', closed: '2026-10-18T10:00:00Z' }),
    tache(2, { deps: ['a#3'] }), mission(3, [2]),
  ])), { maintenant: NOW });
  assert.equal(r.attentes['a#1'], undefined, 'prenable : rien ne la retient');
  assert.equal(r.attentes['a#2'].proprietaire, 'mission');
  assert.equal(r.oubliees.filter(pasLien).length, 0);
});

test('analyserAttentes ne modifie ni l’index ni les résultats qu’on lui passe', () => {
  const b = releve(depot('a', [avec(tache(1, { labels: ['qui:marc'] }), { marc_depuis: il_y_a(100) })]));
  const r = calculer(b, { maintenant: NOW });
  const avant = JSON.stringify(r.depots);
  analyserAttentes(r.depots, { noeuds: new Map(), parents: new Map(), fusionnees: new Set() }, NOW);
  assert.equal(JSON.stringify(r.depots), avant);
});


// --- États de toute tâche ouverte : quatre valides, tout le reste est invalide et sort dans `oubliees` (décision de Marc, 19/10/2026) ---

const sousMission = (...taches) => [mission(90, taches.map((t) => t.n)), ...taches];

test('chaque tâche ouverte a exactement un état, et les quatre valides ne sont jamais des oublis', () => {
  const r = calculer(releve(depot('a', sousMission(
    tache(1),
    avec(tache(2, { labels: ['en-cours'] }), { upd: il_y_a(1) }),
    tache(3, { deps: ['a#1'] }),
    tache(4, { labels: ['bloqué'], deps: ['a#1'] }),
  ))), { maintenant: NOW });
  assert.deepEqual(Object.fromEntries(Object.entries(r.etats).map(([k, v]) => [k, v.etat])), { 'a#1': 'a-faire', 'a#2': 'en-cours', 'a#3': 'en-attente', 'a#4': 'bloquee' });
  assert.equal(r.etats['a#3'].attend, 'a#1');
  assert.equal(r.oubliees.length, 0);
});

test('une tâche bloquée sans rien de nommé, ou sans mission, est invalide : elle ne peut pas rester discrète', () => {
  const r = calculer(releve(depot('a', [...sousMission(tache(1, { labels: ['bloqué'] })), tache(5)])), { maintenant: NOW });
  assert.equal(r.etats['a#1'].etat, 'invalide');
  assert.equal(r.etats['a#1'].cause, 'bloquee-sans-reprise');
  assert.equal(r.etats['a#5'].etat, 'invalide');
  assert.equal(r.etats['a#5'].cause, 'sans-mission');
  assert.deepEqual(r.oubliees.map((o) => o.cause).sort(), ['bloquee-sans-reprise', 'sans-mission']);
});

test('une tâche fermée n’a pas d’état : seules les ouvertes comptent', () => {
  const r = calculer(releve(depot('a', sousMission(tache(1, { state: 'closed' }), tache(2)))), { maintenant: NOW });
  assert.deepEqual(Object.keys(r.etats), ['a#2']);
});

test('liensManquants liste les attentes ouvertes qui n’ont pas de lien natif, et seulement elles', () => {
  const b = releve(depot('a', sousMission(
    tache(1),
    avec(tache(2, { deps: ['a#1'] }), { deps_natives: [] }),
    avec(tache(3, { deps: ['a#1'] }), { deps_natives: ['a#1'] }),
    tache(4, { deps: ['a#9'] }),
    tache(9, { state: 'closed' }),
  )));
  assert.deepEqual(liensManquants(indexer(b)), [{ ref: 'a#2', attend: 'a#1' }]);
});

test('un geste de Marc qui dépend d’une tâche ouverte attend cette tâche, pas Marc : la chaîne a pour racine la tâche de Claude', () => {
  const b = releve(depot('a', [
    mission(90, [91, 92, 93]),
    avec(tache(92, { labels: ['qui:marc'], deps: ['a#91'] }), { marc_depuis: il_y_a(120) }),
    tache(93, { deps: ['a#92'] }),
    tache(91),
  ]));
  const r = calculer(b, { maintenant: NOW });
  assert.equal(etat(r).exclues['a#92'].code, 'attend-ouverte');
  assert.equal(r.attentes['a#92'].racine, 'a#91');
  assert.equal(r.attentes['a#93'].racine, 'a#91');
  assert.equal(r.attentes['a#93'].proprietaire, 'file');
  assert.deepEqual(r.oubliees.filter(pasLien), [], 'rien d’oublié : le dessin attend d’être pris');
  assert.deepEqual(r.file_marc, [], 'aucun geste à faire pour Marc tant que la dépendance est ouverte');
  assert.equal(r.etats['a#92'].etat, 'en-attente');
  // la dépendance fermée, le geste redevient celui de Marc
  const fermee = releve(depot('a', [
    mission(90, [91, 92]),
    avec(tache(92, { labels: ['qui:marc'], deps: ['a#91'] }), { marc_depuis: il_y_a(200) }),
    tache(91, { state: 'closed', closed: '2026-10-19T10:00:00Z' }),
  ]));
  assert.equal(calculer(fermee, { maintenant: NOW }).oubliees.filter(pasLien)[0].cause, 'geste-marc-en-retard');
});

test('`faisable-jules` réserve la tâche à Jules : hors de la file de Claude, listée dans `reservees_jules`, « en attente » de lui', () => {
  const r = calculer(releve(depot('a', [
    mission(90, [1, 2, 3, 4]),
    tache(1), avec(tache(2, { labels: ['faisable-jules', 'prio:2'] }), { upd: il_y_a(1) }), avec(tache(3, { labels: ['faisable-jules'] }), { upd: il_y_a(30) }),
    tache(4, { labels: ['faisable-jules'], deps: ['a#1'] }),
  ])), { maintenant: NOW });
  const d = etat(r);
  assert.deepEqual(d.file.map((f) => f.ref), ['a#1']);
  assert.equal(d.exclues['a#2'].code, 'jules-reservee');
  assert.equal(d.exclues['a#4'].code, 'attend-ouverte', 'une dépendance ouverte passe avant la réserve');
  assert.deepEqual(d.reservees_jules.map((t) => t.ref), ['a#2', 'a#3'], 'prio puis numéro');
  assert.equal(r.etats['a#2'].etat, 'en-attente');
  assert.equal(r.attentes['a#2'].proprietaire, 'fil');
  assert.equal(r.etats['a#3'].etat, 'invalide', 'réservée mais sans nouvelles depuis plus de 24 h : le silence réveille le Coordinateur');
  assert.equal(r.etats['a#3'].cause, 'fil-silencieux');
  assert.equal(etat(calculer(releve(depot('a', [tache(1)])), { maintenant: NOW })).reservees_jules.length, 0);
});

// --- Ligne « **Attend** » obligatoire (décision de Marc, 19/10/2026) ---
const AVANT = new Date('2026-10-19T20:00:00Z');
const APRES = new Date(ATTEND_OBLIGATOIRE.DES_TOUTES);
const releveAttend = (o) => releve(depot('a', [mission(1, [2]), tache(2, o)]));

test('attend-absent : sans le champ attend_ligne (ancien relevé du PC), aucune règle', () => {
  const r = calculer(releveAttend({ created: '2026-10-19T17:00:00Z' }), { maintenant: AVANT });
  assert.equal(suivante(r), 'a#2');
  assert.deepEqual(r.attend_absent, []);
});

test('attend-absent : une tâche créée après la décision sans ligne **Attend** est invalide tout de suite', () => {
  const r = calculer(releveAttend({ attend_ligne: false, created: '2026-10-19T17:00:00Z' }), { maintenant: AVANT });
  assert.equal(suivante(r), null);
  assert.equal(etat(r).exclues['a#2'].code, 'attend-absent');
  assert.equal(r.etats['a#2'].etat, 'invalide');
  assert.equal(r.etats['a#2'].cause, 'attend-absent');
  assert.deepEqual(r.oubliees.map((o) => [o.ref, o.cause]), [['a#2', 'attend-absent']]);
  assert.deepEqual(r.attend_absent, [{ ref: 'a#2', applique: true }]);
});

test('attend-absent : une tâche plus ancienne a un délai de grâce, puis la règle s\'applique', () => {
  const o = { attend_ligne: false, created: '2026-10-10T12:00:00Z' };
  const avant = calculer(releveAttend(o), { maintenant: AVANT });
  assert.equal(suivante(avant), 'a#2', 'pendant la grâce la tâche reste prenable');
  assert.deepEqual(avant.attend_absent, [{ ref: 'a#2', applique: false }]);
  const apres = calculer(releveAttend(o), { maintenant: APRES });
  assert.equal(suivante(apres), null);
  assert.equal(apres.etats['a#2'].cause, 'attend-absent');
});

test('attend-absent : la ligne écrite (même « aucune ») ou une dépendance native suffit', () => {
  assert.equal(attendAbsent({ attend_ligne: true, created: '2026-10-19T17:00:00Z' }, APRES), false);
  assert.equal(attendAbsent({ attend_ligne: false, deps: ['a#9'], created: '2026-10-19T17:00:00Z' }, APRES), false);
  assert.equal(attendAbsent({ attend_ligne: false, created: '2026-10-19T17:00:00Z' }, APRES), true);
});

test('attend-absent : attend_absent ne liste ni les tâches fermées ni les missions et chantiers', () => {
  const sansLigne = { attend_ligne: false, created: '2026-10-19T17:00:00Z' };
  const r = calculer(releve(depot('a', [
    { ...mission(1, [2, 3, 4]), attend_ligne: false },
    chantier(5, []),
    tache(2, sansLigne),
    tache(3, { ...sansLigne, state: 'closed' }),
    tache(4, { attend_ligne: true, created: '2026-10-19T17:00:00Z' }),
  ])), { maintenant: AVANT });
  assert.deepEqual(r.attend_absent.map((x) => x.ref), ['a#2']);
});

// ---- Deux travaux par dépôt, sur des fichiers disjoints (décision de Marc, 21/10/2026) -------------------------------------------------

test('capacité : un dépôt sans travail propose deux tâches à fichiers disjoints, couloirs prévus', () => {
  const r = calculer(releve(depot('a', [tache(1, { fpl: ['src/a.ts'] }), tache(2, { fpl: ['src/b.ts'] }), tache(3, { fpl: ['src/c.ts'] })])));
  const d = etat(r);
  assert.equal(d.statut, 'libre');
  assert.deepEqual(d.suivantes.map((s) => s.ref), ['a#1', 'a#2']);
  assert.equal(d.suivante.ref, 'a#1');
  assert.deepEqual(d.places, { total: 2, prises: 0, libres: 2 });
  assert.deepEqual(d.couloirs.map((c) => [c.place, c.etat, c.ref]), [[1, 'prevue', 'a#1'], [2, 'prevue', 'a#2']]);
});

test('capacité : sans fichiers déclarés, une seule tâche est proposée (dans le doute, un seul)', () => {
  const d = etat(calculer(releve(depot('a', [tache(1), tache(2)]))));
  assert.deepEqual(d.suivantes.map((s) => s.ref), ['a#1']);
  assert.deepEqual(d.sautees_conflit.map((s) => [s.ref, s.raison]), [['a#2', 'fichiers-inconnus']]);
});

test('capacité : un travail en cours et une tâche à fichiers disjoints donnent le statut partiel', () => {
  const r = calculer(releve(depot('a', [tache(1, { labels: ['en-cours'], fpl: ['src/a.ts'] }), tache(2, { fpl: ['src/b.ts'] })])));
  const d = etat(r);
  assert.equal(d.statut, 'partiel');
  assert.equal(d.suivante.ref, 'a#2');
  assert.deepEqual(d.suivantes.map((s) => s.ref), ['a#2']);
  assert.deepEqual(d.places, { total: 2, prises: 1, libres: 1 });
  assert.deepEqual(d.couloirs.map((c) => [c.place, c.etat, c.ref]), [[1, 'occupee', 'a#1'], [2, 'prevue', 'a#2']]);
  assert.deepEqual(d.occupe_par.map((o) => o.fichiers), [['src/a.ts']]);
});

test('capacité : un chemin commun (fichier ou dossier) garde le dépôt occupé, la tâche sautée dit pourquoi', () => {
  for (const commun of [['src/a.ts'], ['src/']]) {
    const d = etat(calculer(releve(depot('a', [tache(1, { labels: ['jules'], fpl: ['src/a.ts'] }), tache(2, { fpl: commun })]))));
    assert.equal(d.statut, 'occupe', commun.join());
    assert.equal(d.suivante, null);
    assert.equal(d.sautees_conflit[0].ref, 'a#2');
    assert.match(d.sautees_conflit[0].raison, /^fichier-commun:/);
    assert.equal(d.sautees_conflit[0].avec, 'a#1');
  }
});

test('capacité : le travail en cours sans fichiers déclarés, ou un fil actif, ne laisse aucune place', () => {
  assert.equal(etat(calculer(releve(depot('a', [tache(1, { labels: ['en-cours'] }), tache(2, { fpl: ['src/b.ts'] })])))).statut, 'occupe');
  assert.equal(etat(calculer(releve(depot('a', [tache(2, { fpl: ['src/b.ts'] })])), { filsActifs: ['a'] })).statut, 'occupe');
});

test('capacité : deux travaux en cours = occupé, aucune suivante, même avec des fichiers disjoints', () => {
  const d = etat(calculer(releve(depot('a', [
    tache(1, { labels: ['en-cours'], fpl: ['x/a.ts'] }), tache(2, { labels: ['jules'], fpl: ['x/b.ts'] }), tache(3, { fpl: ['x/c.ts'] }),
  ]))));
  assert.equal(d.statut, 'occupe');
  assert.deepEqual(d.suivantes, []);
  assert.deepEqual(d.places, { total: 2, prises: 2, libres: 0 });
  assert.equal(d.si_libre, 'a#3', 'la tête de file reste annoncée pour la mesure I4');
});

test('capacité : la PR ouverte d’une tâche en-cours ne compte qu’une fois', () => {
  const d = etat(calculer(releve(depot('a', [tache(1, { labels: ['en-cours'], pr: prOuverte(10), fpl: ['x/a.ts'] }), tache(2, { fpl: ['x/b.ts'] })]))));
  assert.equal(d.occupe_par.length, 1);
  assert.equal(d.statut, 'partiel');
});

test('capacité : un incident garde l’état incident et ne propose rien', () => {
  const d = etat(calculer(releve(depot('a', [tache(1, { fpl: ['x/a.ts'] })], { incidents: [{ n: 9, t: 'panne', url: 'u' }] }))));
  assert.equal(d.statut, 'incident');
  assert.deepEqual(d.suivantes, []);
});

test('capacité : choisirSuivantes saute une tâche incompatible et retient la suivante qui va', () => {
  const f = (ref, fichiers) => ({ ref, fichiers });
  const { suivantes, sautees } = choisirSuivantes([f('a#1', ['m/x.ts']), f('a#2', ['m/x.ts']), f('a#3', ['m/z.ts'])], [], 2);
  assert.deepEqual(suivantes.map((s) => s.ref), ['a#1', 'a#3']);
  assert.deepEqual(sautees.map((s) => s.ref), ['a#2']);
  assert.deepEqual(couloirsDe([{ ref: 'a#9', motif: 'en-cours', fichiers: null }], [f('a#1', ['m/x.ts'])]).map((c) => c.etat), ['occupee', 'prevue']);
});

test('capacité : un journal commun (HANDOVER.md, CHANGELOG.md) n’empêche pas le parallèle', () => {
  const d = etat(calculer(releve(depot('a', [tache(1, { labels: ['en-cours'], fpl: ['src/a.ts', 'HANDOVER.md'] }), tache(2, { fpl: ['src/b.ts', 'HANDOVER.md'] })]))));
  assert.equal(d.statut, 'partiel');
});

// Les fichiers RÉELS de la PR ouverte (`pr.ff`, relevé du PC) s'ajoutent aux fichiers déclarés du travail (tâche #359).
const prAvecFichiers = (n, ff) => ({ ...prOuverte(n), ff });

test('capacité : un travail sans fichiers déclarés mais dont la PR ouverte a des fichiers connus laisse la deuxième place à une tâche disjointe', () => {
  const d = etat(calculer(releve(depot('a', [
    tache(1, { labels: ['en-cours'], pr: prAvecFichiers(10, ['x/a.ts', 'tests/a.test.ts']) }),
    tache(2, { fpl: ['y/b.ts'] }),
  ]))));
  assert.deepEqual(d.occupe_par[0].fichiers, ['x/a.ts', 'tests/a.test.ts']);
  assert.equal(d.statut, 'partiel');
  assert.equal(d.suivante.ref, 'a#2');
});

test('capacité : la PR qui déborde de la déclaration est comptée (déclarés ∪ réels) : la tâche qui touche ce fichier-là est sautée', () => {
  const d = etat(calculer(releve(depot('a', [
    tache(1, { labels: ['jules'], fpl: ['x/a.ts'], pr: prAvecFichiers(10, ['x/a.ts', 'lib/imprevu.ts']) }),
    tache(2, { fpl: ['lib/imprevu.ts'] }),
    tache(3, { fpl: ['z/c.ts'] }),
  ]))));
  assert.deepEqual(d.occupe_par[0].fichiers, ['x/a.ts', 'lib/imprevu.ts']);
  assert.deepEqual(d.sautees_conflit.map((s) => [s.ref, s.raison]), [['a#2', 'fichier-commun:lib/imprevu.ts']]);
  assert.deepEqual(d.suivantes.map((s) => s.ref), ['a#3']);
});

test('capacité : une PR sans fichiers lisibles (liste tronquée, vide, journaux seuls, relevé d’avant) ne change rien : inconnu = un seul travail', () => {
  for (const ff of [null, [], ['HANDOVER.md', 'CHANGELOG.md'], undefined]) {
    const d = etat(calculer(releve(depot('a', [
      tache(1, { labels: ['en-cours'], pr: ff === undefined ? prOuverte(10) : prAvecFichiers(10, ff) }),
      tache(2, { fpl: ['y/b.ts'] }),
    ]))));
    assert.equal(d.occupe_par[0].fichiers, null, `ff = ${JSON.stringify(ff)}`);
    assert.equal(d.statut, 'occupe');
    assert.equal(d.sautees_conflit[0].raison, 'fichiers-inconnus');
  }
});

test('capacité : les fichiers de la PR comptent aussi pour une tâche sans étiquette dont la PR est ouverte (pr-ouverte)', () => {
  const d = etat(calculer(releve(depot('a', [
    tache(1, { pr: prAvecFichiers(10, ['x/a.ts']) }),
    tache(2, { fpl: ['x/a.ts'] }),
  ]))));
  assert.equal(d.occupe_par[0].motif, 'pr-ouverte');
  assert.deepEqual(d.occupe_par[0].fichiers, ['x/a.ts']);
  assert.equal(d.sautees_conflit[0].raison, 'fichier-commun:x/a.ts');
});

test('capacité : une PR fusionnée ou fermée ne fournit pas de fichiers au travail (seule la PR ouverte compte)', () => {
  const d = etat(calculer(releve(depot('a', [
    tache(1, { labels: ['en-cours'], pr: { n: 10, state: 'closed', merged: null, kind: 'tache', ff: ['x/a.ts'] } }),
    tache(2, { fpl: ['y/b.ts'] }),
  ]))));
  assert.equal(d.occupe_par[0].fichiers, null);
});

// --- Ligne « Fichiers touchés » obligatoire (tâche #360) ---
const NEUVE = '2026-10-22T10:00:00Z';
const apresGrace = (creee, h) => new Date(Date.parse(creee) + h * 3_600_000);
const releveFichiers = (o) => releve(depot('a', [mission(1, [2]), tache(2, o)]));

test('fichiers-absents : sans le champ ft_ligne (ancien relevé du PC), aucune règle', () => {
  const r = calculer(releveFichiers({ created: NEUVE }), { maintenant: new Date('2026-10-22T20:00:00Z') });
  assert.equal(suivante(r), 'a#2');
  assert.deepEqual(r.fichiers_absents, []);
});

test('fichiers-absents : une tâche neuve a 3 h pour que le filet écrive sa ligne, puis elle est invalide et réveille comme un oubli', () => {
  const o = { ft_ligne: false, attend_ligne: true, created: NEUVE };
  const tot = calculer(releveFichiers(o), { maintenant: apresGrace(NEUVE, 2) });
  assert.equal(suivante(tot), 'a#2', 'pendant la grâce la tâche reste prenable');
  assert.deepEqual(tot.fichiers_absents, [{ ref: 'a#2', applique: false }]);
  const tard = calculer(releveFichiers(o), { maintenant: apresGrace(NEUVE, 3) });
  assert.equal(suivante(tard), null);
  assert.equal(etat(tard).exclues['a#2'].code, 'fichiers-absents');
  assert.equal(tard.etats['a#2'].etat, 'invalide');
  assert.equal(tard.etats['a#2'].cause, 'fichiers-absents');
  assert.deepEqual(tard.oubliees.map((x) => [x.ref, x.cause]), [['a#2', 'fichiers-absents']]);
  assert.deepEqual(tard.fichiers_absents, [{ ref: 'a#2', applique: true }]);
});

test('fichiers-absents : une tâche plus ancienne que l’activation a 48 h, quel que soit son âge', () => {
  const o = { ft_ligne: false, attend_ligne: true, created: '2026-10-10T12:00:00Z' };
  const avant = calculer(releveFichiers(o), { maintenant: new Date(Date.parse(FICHIERS_OBLIGATOIRES.DES_TOUTES) - 60_000) });
  assert.equal(suivante(avant), 'a#2');
  assert.deepEqual(avant.fichiers_absents, [{ ref: 'a#2', applique: false }]);
  const apres = calculer(releveFichiers(o), { maintenant: new Date(FICHIERS_OBLIGATOIRES.DES_TOUTES) });
  assert.equal(suivante(apres), null);
  assert.equal(apres.etats['a#2'].cause, 'fichiers-absents');
});

test('fichiers-absents : la ligne écrite (estimée, déclarée ou « non déterminés ») suffit', () => {
  const tard = new Date(FICHIERS_OBLIGATOIRES.DES_TOUTES);
  assert.equal(fichiersAbsents({ lvl: 'tâche', ft_ligne: true, created: NEUVE }, tard), false);
  assert.equal(fichiersAbsents({ lvl: 'tâche', ft_ligne: false, created: NEUVE }, tard), true);
});

test('fichiers-absents : exemptés — geste de Marc, preuve attendue, travail commencé, PR ouverte ; ni mission ni tâche fermée listées', () => {
  const tard = new Date(FICHIERS_OBLIGATOIRES.DES_TOUTES);
  const sans = { lvl: 'tâche', ft_ligne: false, created: NEUVE, labels: [] };
  for (const e of ['qui:marc', 'preuve-attendue', 'en-cours', 'jules']) assert.equal(fichiersAbsents({ ...sans, labels: [e] }, tard), false, e);
  assert.equal(fichiersAbsents({ ...sans, pr: { n: 9, state: 'open' } }, tard), false);
  assert.equal(fichiersAbsents({ ...sans, pr: { n: 9, state: 'closed' } }, tard), true);
  assert.equal(fichiersAbsents({ ...sans, lvl: 'mission' }, tard), false);
  const r = calculer(releve(depot('a', [
    { ...mission(1, [2, 3, 4]), ft_ligne: false },
    tache(2, { ft_ligne: false, created: NEUVE }),
    tache(3, { ft_ligne: false, created: NEUVE, state: 'closed', closed: '2026-10-22T11:00:00Z' }),
    tache(4, { ft_ligne: false, created: NEUVE, labels: ['qui:marc'] }),
  ])), { maintenant: tard });
  assert.deepEqual(r.fichiers_absents.map((x) => x.ref), ['a#2']);
});
