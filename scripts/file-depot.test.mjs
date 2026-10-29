import './places-trois.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { champ, construireReleve, eligibleDepuis, fileDuDepot, lireAttend } from './file-depot.mjs';

const DEPOT = 'MoKarade/AppX';
const MAINTENANT = new Date('2026-10-28T21:00:00Z');

const corps = ({ fini = 'la route répond 200', attend = 'aucune', fichiers = ['`src/a.mjs`'] } = {}) =>
  `**Avant** : a\n\n**Après** : b\n\n**Fini quand** : ${fini}\n\n**Fichiers touchés** :\n${fichiers.map((f) => `- ${f}`).join('\n')}\n\n**Attend** : ${attend}\n`;
const tache = (n, { labels = [], ...reste } = {}) => ({
  number: n, title: `Titre secret ${n}`, state: 'open', created_at: '2026-10-28T10:00:00Z', updated_at: '2026-10-28T10:00:00Z',
  html_url: `https://github.com/${DEPOT}/issues/${n}`, labels: [{ name: 'niveau:tâche' }, ...labels.map((name) => ({ name }))], body: corps(), ...reste,
});

// Fausse API : les listes viennent de `donnees` (clé = chemin sans pagination), les issues d'autres dépôts de `ailleurs`.
function faux({ issues = [], prs = [], fichiers = {}, ailleurs = {}, panne = null } = {}) {
  return async (methode, chemin) => {
    if (panne) throw panne;
    const [base] = chemin.split('?');
    if (base === `/repos/${DEPOT}/issues`) return chemin.includes('page=1') ? issues : [];
    if (base === `/repos/${DEPOT}/pulls`) return chemin.includes('page=1') ? prs : [];
    const f = /\/pulls\/(\d+)\/files$/.exec(base);
    if (f) return fichiers[f[1]] ?? [];
    const m = /^\/repos\/MoKarade\/([^/]+)\/issues\/(\d+)$/.exec(base);
    if (m) return ailleurs[`${m[1].toLowerCase()}#${m[2]}`] ?? null;
    return null;
  };
}

test('champ et lireAttend : la grammaire du relevé du PC', () => {
  assert.equal(champ(corps({ fini: 'la page affiche 3 cartes' }), 'Fini quand'), 'la page affiche 3 cartes');
  assert.equal(champ('rien', 'Fini quand'), null);
  assert.deepEqual(lireAttend('**Attend** : aucune.', 'appx'), []);
  assert.deepEqual(lireAttend('**Attend** : rien (PR #4 fusionnée)', 'appx'), []);
  assert.deepEqual(lireAttend('**Attend** : #12, MoKarade/CarAI#3, Hubperso#311 — parce que', 'appx'), ['appx#12', 'carai#3', 'hubperso#311']);
  assert.deepEqual(lireAttend('**Attend :** batchchef#7', 'appx'), ['batchchef-#7']);
});

test('dépôt libre : la tâche prenable est rendue par son NUMÉRO, avec ses places', async () => {
  const r = await fileDuDepot({ api: faux({ issues: [tache(12), tache(30, { labels: ['prio:1'] })] }), depot: DEPOT, maintenant: MAINTENANT });
  assert.equal(r.statut, 'libre');
  assert.equal(r.suivante, 30, 'prio:1 passe avant');
  assert.deepEqual(r.places, { total: 3, prises: 0, libres: 3 });
  assert.equal(typeof r.suivante, 'number');
});

test('dépôt occupé : trois travaux en cours, aucune suivante', async () => {
  const issues = [1, 2, 3].map((n) => tache(n, { labels: ['en-cours'], body: corps({ fichiers: [`\`src/f${n}.mjs\``] }) })).concat(tache(9, { body: corps({ fichiers: ['`src/z.mjs`'] }) }));
  const r = await fileDuDepot({ api: faux({ issues }), depot: DEPOT, maintenant: MAINTENANT });
  assert.equal(r.statut, 'occupe');
  assert.equal(r.suivante, null);
});

test('une place reste : la suivante doit avoir des fichiers disjoints (statut partiel)', async () => {
  const enCours = [1, 2].map((n) => tache(n, { labels: ['en-cours'], body: corps({ fichiers: [`\`src/f${n}.mjs\``] }) }));
  const commune = tache(8, { body: corps({ fichiers: ['`src/f1.mjs`'] }) });
  const disjointe = tache(9, { body: corps({ fichiers: ['`src/z.mjs`'] }) });
  const r = await fileDuDepot({ api: faux({ issues: [...enCours, commune, disjointe] }), depot: DEPOT, maintenant: MAINTENANT });
  assert.equal(r.statut, 'partiel');
  assert.equal(r.suivante, 9);
});

test('incident ouvert : le dépôt est en incident, rien n’est proposé', async () => {
  const incident = { number: 77, title: 'Production en panne', state: 'open', labels: [{ name: 'incident' }], html_url: 'u', body: '' };
  const r = await fileDuDepot({ api: faux({ issues: [tache(12), incident] }), depot: DEPOT, maintenant: MAINTENANT });
  assert.equal(r.statut, 'incident');
  assert.equal(r.suivante, null);
});

test('frein de quota : une tâche ordinaire est retenue au palier 2, le statut le dit', async () => {
  const frein = { palier: 2, detail: { raison: 'quota à 91 %', perime: false } };
  const r = await fileDuDepot({ api: faux({ issues: [tache(12)] }), depot: DEPOT, frein, maintenant: MAINTENANT });
  assert.equal(r.statut, 'frein');
  assert.equal(r.suivante, null);
});

test('dépendance illisible : la tâche n’est PAS lancée, jamais comptée libre', async () => {
  const issues = [tache(12, { body: corps({ attend: 'MoKarade/Prive#5 — une tâche d’un autre dépôt' }) })];
  const r = await fileDuDepot({ api: faux({ issues }), depot: DEPOT, maintenant: MAINTENANT });
  assert.equal(r.suivante, null);
  assert.deepEqual(r.illisibles, ['prive#5']);
});

test('dépendance fermée dans un autre dépôt : la tâche part, « éligible depuis » = la fermeture', async () => {
  const issues = [tache(12, { body: corps({ attend: 'Hubperso#311' }) })];
  const ailleurs = { 'hubperso#311': { number: 311, state: 'closed', closed_at: '2026-10-28T20:30:00Z', created_at: '2026-10-27T08:00:00Z', labels: [], html_url: 'u' } };
  const r = await fileDuDepot({ api: faux({ issues, ailleurs }), depot: DEPOT, maintenant: MAINTENANT });
  assert.equal(r.suivante, 12);
  assert.equal(r.eligibleDepuis, '2026-10-28T20:30:00.000Z');
});

test('dépendance ouverte dans un autre dépôt, ou dans le même dépôt : la tâche attend', async () => {
  const ailleurs = { 'hubperso#311': { number: 311, state: 'open', labels: [], html_url: 'u', created_at: '2026-10-27T08:00:00Z' } };
  const a = await fileDuDepot({ api: faux({ issues: [tache(12, { body: corps({ attend: 'Hubperso#311' }) })], ailleurs }), depot: DEPOT, maintenant: MAINTENANT });
  assert.equal(a.suivante, null);
  const b = await fileDuDepot({ api: faux({ issues: [tache(12, { body: corps({ attend: '#13' }) }), tache(13)] }), depot: DEPOT, maintenant: MAINTENANT });
  assert.equal(b.suivante, 13, 'la dépendance ouverte du même dépôt passe d’abord');
});

test('une PR ouverte qui cite la tâche la retire de la file et tient une place avec ses fichiers réels', async () => {
  const pr = { number: 50, state: 'open', draft: true, body: 'Tâche : #12', user: { login: 'MoKarade', type: 'User' }, head: { ref: 'claude/x' } };
  const issues = [tache(12), tache(13, { body: corps({ fichiers: ['`src/b.mjs`'] }) })];
  const fichiers = { 50: [{ filename: 'src/a.mjs' }] };
  const r = await fileDuDepot({ api: faux({ issues, prs: [pr], fichiers }), depot: DEPOT, maintenant: MAINTENANT });
  assert.equal(r.suivante, 13);
  assert.equal(r.places.prises, 1);
});

test('PR dont les fichiers réels recoupent la suivante : elle est sautée', async () => {
  const pr = { number: 50, state: 'open', draft: false, body: 'Tâche : #12', user: { login: 'MoKarade', type: 'User' }, head: { ref: 'claude/x' } };
  const issues = [tache(12), tache(13, { body: corps({ fichiers: ['`src/b.mjs`'] }) })];
  const r = await fileDuDepot({ api: faux({ issues, prs: [pr], fichiers: { 50: [{ filename: 'src/b.mjs' }] } }), depot: DEPOT, maintenant: MAINTENANT });
  assert.equal(r.suivante, null);
});

test('lecture qui échoue : « illisible », jamais une tâche inventée ni une exception', async () => {
  const r = await fileDuDepot({ api: faux({ panne: new Error('HTTP 502') }), depot: DEPOT, maintenant: MAINTENANT });
  assert.equal(r.statut, 'illisible');
  assert.equal(r.suivante, null);
  const nul = await fileDuDepot({ api: async () => null, depot: DEPOT, maintenant: MAINTENANT });
  assert.equal(nul.statut, 'illisible');
});

test('« exclure » : la tâche que la PR fusionnée vient de livrer ne tient plus de place', async () => {
  const issues = [1, 2, 3].map((n) => tache(n, { labels: ['en-cours'], body: corps({ fichiers: [`\`src/f${n}.mjs\``] }) })).concat(tache(9, { body: corps({ fichiers: ['`src/z.mjs`'] }) }));
  const sans = await fileDuDepot({ api: faux({ issues }), depot: DEPOT, maintenant: MAINTENANT });
  assert.equal(sans.suivante, null);
  const avec = await fileDuDepot({ api: faux({ issues }), depot: DEPOT, maintenant: MAINTENANT, exclure: [3] });
  assert.equal(avec.suivante, 9);
});

test('eligibleDepuis : le plus tard entre création, dépendance fermée et place libérée (places pleines seulement)', () => {
  const t = { created: '2026-10-28T10:00:00Z', deps: ['hubperso#311'] };
  const deps = new Map([['hubperso#311', { closed_at: '2026-10-28T12:00:00Z' }]]);
  const pleines = { total: 3, prises: 2 };
  assert.equal(eligibleDepuis({ tache: t, deps, places: pleines, libereA: '2026-10-28T20:59:00Z' }), '2026-10-28T20:59:00.000Z');
  assert.equal(eligibleDepuis({ tache: t, deps, places: { total: 3, prises: 1 }, libereA: '2026-10-28T20:59:00Z' }), '2026-10-28T12:00:00.000Z');
  assert.equal(eligibleDepuis({ tache: { created: '2026-10-28T10:00:00Z', deps: [] }, deps, places: pleines, libereA: null }), '2026-10-28T10:00:00.000Z');
});

test('construireReleve : la même forme que le relevé du PC pour une tâche ouverte', () => {
  const releve = construireReleve({ depot: DEPOT, issues: [tache(12)], prs: [], maintenant: MAINTENANT });
  const n = releve.repos[0].nodes[12];
  assert.equal(n.lvl, 'tâche');
  assert.equal(n.fq, 'la route répond 200');
  assert.deepEqual(n.fpl, ['src/a.mjs']);
  assert.equal(n.ft_ligne, true);
  assert.equal(n.attend_ligne, true);
  assert.deepEqual(n.deps, []);
});
