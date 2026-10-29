// Tests de la libération des places immobiles (scripts/place-immobile.mjs, tâche MoKarade/.github#868) : une fausse API GitHub en mémoire, aucun réseau.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decider, poseEnCours, libererPlacesImmobiles, MARQUEUR } from './place-immobile.mjs';
import { pilotage, lignesDesSignaux } from './pilotage-evenement.mjs';

const H = 3_600_000;
const MAINTENANT = new Date('2026-10-29T18:00:00Z');
const il_y_a = (h) => new Date(MAINTENANT.getTime() - h * H).toISOString();
const DEPOT = 'MoKarade/FinanceAI';
const etiquettes = (...noms) => noms.map((name) => ({ name }));
const tache = (n, labels = ['niveau:tâche', 'en-cours']) => ({ number: n, title: `Tâche ${n}`, body: '', labels: etiquettes(...labels), state: 'open', created_at: il_y_a(30), updated_at: il_y_a(1) });

/** Un dépôt simulé : `prises` (issues), `posesEnCours` {n: ISO}, `commentaires` {n: [...]}, `prs` (PR ouvertes du dépôt), `ailleurs` {n: true} = PR ouverte dans un autre dépôt. Garde tous les appels. */
function github({ prises = [], posesEnCours = {}, commentaires = {}, prs = [], ailleurs = {}, panne = null } = {}) {
  const appels = [];
  const gh = (methode, chemin, corps) => {
    appels.push({ methode, chemin, corps });
    if (panne && panne.test(chemin)) throw new Error(`HTTP 502 sur ${methode} ${chemin}`);
    if (methode === 'GET' && /\/issues\?state=open&labels=en-cours/.test(chemin)) return prises;
    if (methode === 'GET' && /\/pulls\?state=open/.test(chemin)) return prs;
    const ev = /\/issues\/(\d+)\/events/.exec(chemin);
    if (methode === 'GET' && ev) return posesEnCours[ev[1]] ? [{ event: 'labeled', label: { name: 'en-cours' }, created_at: posesEnCours[ev[1]] }] : [];
    const co = /\/issues\/(\d+)\/comments/.exec(chemin);
    if (methode === 'GET' && co) return commentaires[co[1]] ?? [];
    if (methode === 'GET' && /^search\/issues/.test(chemin)) {
      const n = /%23(\d+)/.exec(chemin)?.[1];
      return { items: ailleurs[n] ? [{ number: 1 }] : [] };
    }
    return {};
  };
  return { gh, appels, ecritures: () => appels.filter((a) => a.methode !== 'GET') };
}
const tour = (config) => {
  const g = github(config);
  return { ...libererPlacesImmobiles({ depot: DEPOT, gh: g.gh, maintenant: MAINTENANT }), ecritures: g.ecritures() };
};

test('poseEnCours : la plus récente, ou null', () => {
  assert.equal(poseEnCours([{ event: 'labeled', label: { name: 'en-cours' }, created_at: '2026-10-29T10:00:00Z' }, { event: 'labeled', label: { name: 'en-cours' }, created_at: '2026-10-29T14:00:00Z' }, { event: 'labeled', label: { name: 'prio:1' }, created_at: '2026-10-29T17:00:00Z' }]), '2026-10-29T14:00:00Z');
  assert.equal(poseEnCours([]), null);
  assert.equal(poseEnCours(undefined), null);
});

test('decider : cas valides et rejetés', () => {
  const base = { labels: etiquettes('en-cours'), enCoursDepuis: il_y_a(4), marqueur: null, reponseDuFil: false, prOuverte: false, maintenant: MAINTENANT };
  assert.equal(decider(base).action, 'signaler');
  assert.equal(decider({ ...base, enCoursDepuis: il_y_a(2) }).action, 'rien');
  assert.equal(decider({ ...base, prOuverte: true }).action, 'rien');
  assert.equal(decider({ ...base, enCoursDepuis: null }).action, 'rien');
  for (const p of ['preuve-attendue', 'qui:marc', 'jules']) assert.equal(decider({ ...base, labels: etiquettes('en-cours', p) }).action, 'rien', p);
  assert.equal(decider({ ...base, marqueur: { created_at: il_y_a(0.5) } }).action, 'rien');
  assert.equal(decider({ ...base, marqueur: { created_at: il_y_a(1.5) } }).action, 'liberer');
  assert.equal(decider({ ...base, marqueur: { created_at: il_y_a(1.5) }, reponseDuFil: true }).action, 'rien');
});

test('en-cours de 4 h sans PR : un seul commentaire marqueur, jamais un second', () => {
  const premier = tour({ prises: [tache(17)], posesEnCours: { 17: il_y_a(4) } });
  assert.deepEqual(premier.signalees, ['FinanceAI#17']);
  assert.equal(premier.ecritures.length, 1);
  assert.equal(premier.ecritures[0].methode, 'POST');
  assert.match(premier.ecritures[0].corps.body, new RegExp(MARQUEUR));
  // le passage suivant voit le marqueur tout neuf : rien de plus
  const suivant = tour({ prises: [tache(17)], posesEnCours: { 17: il_y_a(4) }, commentaires: { 17: [{ body: `${MARQUEUR}\nx`, created_at: il_y_a(0.1) }] } });
  assert.deepEqual(suivant.signalees, []);
  assert.equal(suivant.ecritures.length, 0);
});

test('marqueur de plus d’une heure, ni PR ni réponse : en-cours retiré, bloqué posé, raison écrite', () => {
  const r = tour({ prises: [tache(17)], posesEnCours: { 17: il_y_a(5) }, commentaires: { 17: [{ body: `${MARQUEUR}\nx`, created_at: il_y_a(1.2) }] } });
  assert.deepEqual(r.liberees, ['FinanceAI#17']);
  assert.deepEqual(r.ecritures.map((e) => `${e.methode} ${e.chemin}`), [
    'DELETE repos/MoKarade/FinanceAI/issues/17/labels/en-cours',
    'POST repos/MoKarade/FinanceAI/issues/17/labels',
    'POST repos/MoKarade/FinanceAI/issues/17/comments',
  ]);
  assert.deepEqual(r.ecritures[1].corps, { labels: ['bloqué'] });
  assert.match(r.ecritures[2].corps.body, /Aucune PR depuis 5 h, place libérée/);
  // l'issue n'est jamais fermée
  assert.ok(!r.ecritures.some((e) => e.methode === 'PATCH'));
});

test('le fil a répondu après le marqueur : rien ne bouge', () => {
  const r = tour({ prises: [tache(17)], posesEnCours: { 17: il_y_a(5) }, commentaires: { 17: [{ body: `${MARQUEUR}\nx`, created_at: il_y_a(2) }, { body: 'Je continue, PR ce soir.', created_at: il_y_a(1) }] } });
  assert.equal(r.ecritures.length, 0);
});

test('PR ouverte du dépôt, PR ouverte d’un autre dépôt, preuve-attendue, qui:marc, jules, en-cours récent : rien ne bouge', () => {
  const prs = [{ number: 40, body: 'Tâche : #17', user: { login: 'MoKarade' } }];
  const r = tour({
    prises: [tache(17), tache(18), tache(19, ['niveau:tâche', 'en-cours', 'preuve-attendue']), tache(20, ['niveau:tâche', 'en-cours', 'qui:marc']), tache(21, ['niveau:tâche', 'en-cours', 'jules']), tache(22)],
    posesEnCours: { 17: il_y_a(9), 18: il_y_a(9), 19: il_y_a(9), 20: il_y_a(9), 21: il_y_a(9), 22: il_y_a(1) },
    prs,
    ailleurs: { 18: true },
  });
  assert.deepEqual([r.signalees, r.liberees], [[], []]);
  assert.equal(r.ecritures.length, 0);
});

test('lecture impossible : rien n’est libéré et la tâche est dite illisible', () => {
  const r = tour({ prises: [tache(17)], posesEnCours: { 17: il_y_a(9) }, commentaires: { 17: [{ body: `${MARQUEUR}`, created_at: il_y_a(3) }] }, panne: /search\/issues/ });
  assert.deepEqual(r.illisibles, ['FinanceAI#17']);
  assert.equal(r.ecritures.length, 0);
});

test('pilotage : un événement de tâche signale la place immobile, et le signal part dans le réveil', () => {
  const g = github({ prises: [tache(17)], posesEnCours: { 17: il_y_a(4) } });
  const r = pilotage({ evt: { type: 'tache_fermee', depot: DEPOT }, gh: (m, c, b) => (m === 'GET' && /state=closed/.test(c) ? [] : g.gh(m, c, b)), maintenant: MAINTENANT });
  assert.deepEqual(r.erreurs, []);
  assert.equal(r.signaux.length, 1);
  assert.deepEqual(lignesDesSignaux(r.signaux), ['place immobile : FinanceAI#17 en-cours sans PR depuis plus de 3 h, signalée']);
});

test('aucun minuteur ni secret dans le script', async () => {
  const { readFileSync } = await import('node:fs');
  const code = readFileSync(new URL('./place-immobile.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(code, /secrets\.|schedule:|cron:/);
});
