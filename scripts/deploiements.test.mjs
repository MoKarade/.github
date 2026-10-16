import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appliquer, corpsOuverture, decider, dernierDeploiement, etatDeploiement, relever, releveEssai, tableau, titreEchec } from './deploiements.mjs';

/** Faux `gh api` : `reponses` associe un fragment de chemin à la sortie JSON, ou à une erreur à lever. */
const faux = (reponses) => async (args) => {
  const chemin = args[1];
  for (const [fragment, sortie] of Object.entries(reponses)) {
    if (!chemin.includes(fragment)) continue;
    if (sortie instanceof Error) throw sortie;
    return JSON.stringify(sortie);
  }
  throw new Error(`appel inattendu : ${chemin}`);
};
const non404 = Object.assign(new Error('gh api a échoué : gh: Not Found (HTTP 404)'), { stderr: 'gh: Not Found (HTTP 404)' });

test('etatDeploiement : chaque état GitHub', () => {
  assert.equal(etatDeploiement({ state: 'success' }), 'ok');
  assert.equal(etatDeploiement({ state: 'failure' }), 'echec');
  assert.equal(etatDeploiement({ state: 'error' }), 'echec');
  for (const s of ['queued', 'pending', 'in_progress']) assert.equal(etatDeploiement({ state: s }), 'en-cours');
  assert.equal(etatDeploiement(undefined), 'en-cours');
  assert.equal(etatDeploiement({ state: 'inactive' }), 'inconnu');
});

test('dernierDeploiement : lit le dernier déploiement de production et son dernier statut', async () => {
  const gh = faux({
    '/deployments/9/statuses': [{ state: 'failure', log_url: 'https://vercel.com/x/y/z' }],
    '/deployments?environment=Production': [{ id: 9, sha: 'abcdef0123456', created_at: '2026-10-16T01:00:00Z' }],
  });
  assert.deepEqual(await dernierDeploiement(gh, 'MoKarade/A'), { etat: 'echec', sha: 'abcdef0', date: '2026-10-16T01:00:00Z', url: 'https://vercel.com/x/y/z' });
});

test('dernierDeploiement : un log_url non https est écarté', async () => {
  const gh = faux({
    '/statuses': [{ state: 'success', log_url: 'javascript:alert(1)' }],
    '/deployments?': [{ id: 1, sha: 'a'.repeat(40), created_at: 'x' }],
  });
  assert.equal((await dernierDeploiement(gh, 'MoKarade/A')).url, null);
});

test('dernierDeploiement : aucun déploiement → null ; 404 → illisible ; autre erreur → remonte', async () => {
  assert.equal(await dernierDeploiement(faux({ '/deployments?': [] }), 'MoKarade/A'), null);
  assert.deepEqual(await dernierDeploiement(faux({ '/deployments?': non404 }), 'MoKarade/A'), { illisible: true });
  await assert.rejects(dernierDeploiement(faux({ '/deployments?': new Error('HTTP 500') }), 'MoKarade/A'), /500/);
});

test('relever : un relevé par app, aucun déploiement marqué', async () => {
  const gh = faux({ 'MoKarade/A/deployments?': [], 'MoKarade/B/deployments?': non404 });
  const releves = await relever([{ nom: 'a', depot: 'MoKarade/A' }, { nom: 'b', depot: 'MoKarade/B' }], gh);
  assert.deepEqual(releves, [{ nom: 'a', depot: 'MoKarade/A', aucun: true }, { nom: 'b', depot: 'MoKarade/B', illisible: true }]);
});

test('decider : échec ouvre, une seule fois ; réussite ferme ; en cours et inconnu ne font rien', () => {
  const ouvertes = [{ number: 7, title: titreEchec('b') }, { number: 8, title: 'Panne : b' }];
  const releves = [
    { nom: 'a', etat: 'echec' },
    { nom: 'b', etat: 'echec' }, // déjà une issue d'échec : pas de doublon
    { nom: 'c', etat: 'ok' },
    { nom: 'd', etat: 'en-cours' },
    { nom: 'e', etat: 'inconnu' },
    { nom: 'f', illisible: true },
  ];
  assert.deepEqual(decider({ releves, ouvertes }), [{ type: 'ouvrir', nom: 'a' }]);
  // le déploiement suivant réussi ferme l'issue d'échec, pas l'issue « Panne : b » de la sonde de santé
  assert.deepEqual(decider({ releves: [{ nom: 'b', etat: 'ok' }], ouvertes }), [{ type: 'fermer', nom: 'b', numero: 7 }]);
});

test('appliquer : crée avec l’étiquette panne, ferme avec un commentaire', async () => {
  const appels = [];
  const gh = async (args) => appels.push(args);
  const r = { nom: 'a', depot: 'MoKarade/A', sha: 'abc1234', url: null };
  const date = new Date('2026-10-16T12:00:00Z');
  await appliquer([{ type: 'ouvrir', nom: 'a' }, { type: 'fermer', nom: 'a', numero: 5 }], [r], gh, date);
  assert.deepEqual(appels[0].slice(0, 6), ['issue', 'create', '--title', 'Déploiement en échec : a', '--label', 'panne']);
  assert.match(appels[0][7], /abc1234/);
  assert.deepEqual(appels[1].slice(0, 5), ['issue', 'close', '5', '--reason', 'completed']);
  assert.match(appels[1][6], /\*\*a\*\* a réussi/);
});

test('corpsOuverture : ni jeton ni corps de réponse, lien de commit, journal seulement s’il existe', () => {
  const date = new Date('2026-10-16T12:00:00Z');
  const sans = corpsOuverture({ nom: 'a', depot: 'MoKarade/A', sha: 'abc1234', url: null }, date);
  assert.match(sans, /https:\/\/github\.com\/MoKarade\/A\/commit\/abc1234/);
  assert.doesNotMatch(sans, /Journal du déploiement/);
  assert.match(corpsOuverture({ nom: 'a', depot: 'MoKarade/A', sha: 'abc1234', url: 'https://vercel.com/j' }, date), /Journal du déploiement : https:\/\/vercel\.com\/j/);
});

test('tableau : dit « non mesuré » et « aucun déploiement », jamais un faux vert', () => {
  const t = tableau({
    releves: [{ nom: 'a', etat: 'ok', sha: 'abc1234' }, { nom: 'b', illisible: true }, { nom: 'c', aucun: true }, { nom: 'd', etat: 'echec', sha: 'def5678' }],
    actions: [{ type: 'ouvrir', nom: 'd' }],
  });
  assert.match(t, /\| a \| réussi \| commit abc1234 \|\s+\|/);
  assert.match(t, /\| b \| non mesuré \|/);
  assert.match(t, /\| c \| aucun déploiement \|/);
  assert.match(t, /\| d \| ÉCHEC \| commit def5678 \| issue ouverte \|/);
});

test('releveEssai : échec simulé ou réussite simulée', () => {
  assert.equal(releveEssai({ DEPLOIEMENT_ESSAI: 'echec' }).etat, 'echec');
  assert.equal(releveEssai({ DEPLOIEMENT_ESSAI: 'succes', SURVEILLANCE_ESSAI_NOM: 'x' }).etat, 'ok');
  assert.equal(releveEssai({ DEPLOIEMENT_ESSAI: 'succes', SURVEILLANCE_ESSAI_NOM: 'x' }).nom, 'x');
});
