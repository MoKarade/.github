import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controlePlaces, occupants, prsQuiAttendentMarc, rapportPlaces } from './places-depot.mjs';

// Données fictives, aucun réseau : une fausse API GitHub en mémoire pour le dépôt « MoKarade/depot ».
const etiquette = (...noms) => noms.map((name) => ({ name }));
const tache = (number, ...noms) => ({ number, title: `tâche ${number}`, labels: etiquette('niveau:tâche', ...noms) });
const fauxDepot = ({ enCours = [], jules = [], marc = [], prs = [] } = {}) => async (methode, chemin) => {
  assert.equal(methode, 'GET');
  const m = /^\/repos\/MoKarade\/depot\/(issues|pulls)\?state=open(?:&labels=([^&]+))?&per_page=100$/.exec(chemin);
  assert.ok(m, `chemin inattendu : ${chemin}`);
  if (m[1] === 'pulls') return prs;
  return { 'en-cours': enCours, jules, 'qui:marc': marc }[decodeURIComponent(m[2])];
};
const lien = (numero, extra = {}) => ({ ok: true, dispense: null, ouvertes: [{ depot: 'depot', numero, aPrendre: true, tientPlace: false, ...extra }] });
const pr = (extra = {}) => ({ draft: false, user: { login: 'MoKarade', type: 'User' }, ...extra });

test('une place, un autre travail en cours : la 2e tâche est refusée, avec ce qui tient la place', async () => {
  const v = await controlePlaces({ api: fauxDepot({ enCours: [tache(10, 'en-cours')] }), pr: pr(), lien: lien(20), places: 1 });
  assert.equal(v.ok, false);
  assert.deepEqual(v.occupants.map((o) => o.numero), [10]);
  const texte = rapportPlaces(v);
  assert.match(texte, /\*\*rouge\*\*/);
  assert.match(texte, /#10/);
  assert.match(texte, /#20/);
  assert.match(texte, /attendre/);
});

test('deux places : un autre travail en cours, accepté ; deux autres, refusé pour une 3e', async () => {
  const un = await controlePlaces({ api: fauxDepot({ enCours: [tache(10, 'en-cours')] }), pr: pr(), lien: lien(20), places: 2 });
  assert.equal(un.ok, true);
  const deux = await controlePlaces({ api: fauxDepot({ enCours: [tache(10, 'en-cours'), tache(11, 'en-cours')] }), pr: pr(), lien: lien(20), places: 2 });
  assert.equal(deux.ok, false);
});

test('une tâche jules ne tient aucune place : le dépôt n\u2019est pas plein, seule la tâche en-cours compte', async () => {
  // Hubperso#413 bloquée par la tâche Jules #412 (23/10/2026) : le contrôle ne lit plus les tâches `jules`
  const api = async (methode, chemin) => {
    assert.ok(!/labels=jules/.test(chemin), 'les tâches jules ne se lisent plus');
    return fauxDepot({ enCours: [tache(10, 'en-cours', 'jules')], jules: [tache(11, 'jules')] })(methode, chemin);
  };
  const plein = await controlePlaces({ api, pr: pr(), lien: lien(20), places: 1 });
  assert.equal(plein.ok, false);
  assert.deepEqual(plein.occupants.map((o) => o.numero), [10]);
  const libre = await controlePlaces({ api: fauxDepot({ jules: [tache(11, 'jules')] }), pr: pr(), lien: lien(20), places: 1 });
  assert.equal(libre.ok, true);
  assert.equal(libre.occupants.length, 0);
});

test('la PR d\u2019une tâche jules n\u2019est jamais refusée, même dans un dépôt plein, sans lire le dépôt', async () => {
  const api = async () => { throw new Error('ne doit pas être appelé'); };
  const v = await controlePlaces({ api, pr: pr(), lien: lien(20, { jules: true, aPrendre: false }), places: 1 });
  assert.equal(v.ok, true);
  assert.match(v.raison, /Jules/);
});

test('la tâche déjà en cours est acceptée (c’est l’une des places), sans lire le dépôt', async () => {
  const api = async () => { throw new Error('ne doit pas être appelé'); };
  const v = await controlePlaces({ api, pr: pr(), lien: lien(20, { tientPlace: true, aPrendre: false }), places: 1 });
  assert.equal(v.ok, true);
});

test('brouillon, robot dispensé et PR sans tâche valide : jamais de lecture, jamais de refus', async () => {
  const api = async () => { throw new Error('ne doit pas être appelé'); };
  assert.equal((await controlePlaces({ api, pr: pr({ draft: true }), lien: lien(20), places: 1 })).raison, 'brouillon');
  assert.match((await controlePlaces({ api, pr: pr(), lien: { ok: true, dispense: 'robot dependabot[bot]', ouvertes: [] }, places: 1 })).raison, /robot/);
  assert.equal((await controlePlaces({ api, pr: pr(), lien: { ok: false, dispense: null, ouvertes: [] }, places: 1 })).ok, true);
});

test('liste illisible : avertissement, pas de refus', async () => {
  const api = async () => { throw new Error('HTTP 502'); };
  const v = await controlePlaces({ api, pr: pr(), lien: lien(20), places: 1 });
  assert.equal(v.ok, true);
  assert.match(rapportPlaces(v), /non contrôlées.*502/);
});

test('une tâche dont la PR n’attend plus que Marc n’occupe pas le dépôt (exception du 17/10/2026)', async () => {
  const api = fauxDepot({
    enCours: [tache(10, 'en-cours')],
    marc: [{ number: 90, title: 'Garde-fou : la PR #5 attend un geste de Marc', labels: etiquette('qui:marc') }],
    prs: [{ number: 5, body: 'Tâche : #10' }],
  });
  assert.equal((await controlePlaces({ api, pr: pr(), lien: lien(20), places: 1 })).ok, true);
  // une autre PR ouverte de la même tâche, qui n'attend pas Marc : elle occupe de nouveau
  const api2 = fauxDepot({
    enCours: [tache(10, 'en-cours')],
    marc: [{ number: 90, title: 'Garde-fou : la PR #5 attend un geste de Marc', labels: etiquette('qui:marc') }],
    prs: [{ number: 5, body: 'Tâche : #10' }, { number: 6, body: 'Tâche : MoKarade/depot#10' }],
  });
  assert.equal((await controlePlaces({ api: api2, pr: pr(), lien: lien(20), places: 1 })).ok, false);
});

test('prsQuiAttendentMarc : seul le titre exact du Garde-fou, jamais une PR', () => {
  const s = prsQuiAttendentMarc([
    { title: 'Garde-fou : la PR #5 attend un geste de Marc' },
    { title: 'Garde-fou : la PR #6 attend un geste de Marc', pull_request: {} },
    { title: 'Autre chose #7' },
  ]);
  assert.deepEqual([...s], [5]);
});

test('occupants : la tâche de la PR elle-même et les PR sont ignorées', () => {
  const liste = occupants({ issues: [tache(20, 'en-cours'), { ...tache(21, 'en-cours'), pull_request: {} }, tache(22, 'en-cours')], prsOuvertes: [], attendentMarc: new Set(), depotComplet: 'MoKarade/depot', sauf: 20 });
  assert.deepEqual(liste.map((o) => o.numero), [22]);
});

test('plusieurs tâches citées : la PR passe si l’une trouve une place', async () => {
  const api = async (methode, chemin) => {
    if (chemin.includes('/repos/MoKarade/plein/')) return chemin.includes('labels=en-cours') ? [tache(1, 'en-cours')] : [];
    return [];
  };
  const citees = { ok: true, dispense: null, ouvertes: [{ depot: 'plein', numero: 5, tientPlace: false }, { depot: 'libre', numero: 6, tientPlace: false }] };
  assert.equal((await controlePlaces({ api, pr: pr(), lien: citees, places: 1 })).ok, true);
});
