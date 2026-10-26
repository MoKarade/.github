import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lireApps } from './surveillance.mjs';
import { appsRetour, causeHorsDeploiement, choisirCible, clientVercel, corpsIncident, lireProjet, normaliser, tableau, titreIncident, traiter } from './retour-arriere.mjs';

const MAINTENANT = new Date('2026-10-16T12:00:00Z');
const dep = (id, minutes, sha, message = 'feat: truc (#12)') => ({
  uid: id,
  created: MAINTENANT.getTime() - minutes * 60_000,
  meta: { githubCommitSha: sha.padEnd(40, '0'), githubCommitMessage: `${message}\n\ncorps` },
});
const recent = dep('dpl_new', 10, 'aaaaaaa');
const ancien = dep('dpl_old', 300, 'bbbbbbb');
const app = { nom: 'hubperso', depot: 'MoKarade/Hubperso', sante: 'https://x.example/api/sante', vercel: 'hubperso' };

test('choisirCible : panne juste après un déploiement en ligne, version précédente présente → retour', () => {
  const c = choisirCible({ courantId: 'dpl_new', deploiements: [recent, ancien], maintenant: MAINTENANT.getTime() });
  assert.equal(c.action, 'retour');
  assert.equal(c.fautif.id, 'dpl_new');
  assert.equal(c.precedent.id, 'dpl_old');
});

test('choisirCible : rien sans lien avec un déploiement récent, déjà retiré, sans précédent ou illisible', () => {
  const m = MAINTENANT.getTime();
  assert.match(choisirCible({ courantId: 'dpl_new', deploiements: [dep('dpl_new', 500, 'a'), ancien], maintenant: m }).raison, /vieux/);
  assert.match(choisirCible({ courantId: 'dpl_old', deploiements: [recent, ancien], maintenant: m }).raison, /déjà retiré/);
  assert.match(choisirCible({ courantId: 'dpl_new', deploiements: [recent], maintenant: m }).raison, /aucune version précédente/);
  assert.match(choisirCible({ courantId: null, deploiements: [recent, ancien], maintenant: m }).raison, /introuvable/);
  assert.match(choisirCible({ courantId: 'x', deploiements: [], maintenant: m }).raison, /aucun déploiement/);
});

test('normaliser : première ligne du message seulement, tronquée', () => {
  const n = normaliser({ id: 'd', created: 5, meta: { githubCommitSha: 'abc', githubCommitMessage: `${'x'.repeat(300)}\nsuite` } });
  assert.equal(n.message.length, 120);
  assert.equal(n.id, 'd');
});

/** Faux client Vercel : consigne les appels, rend la réponse dont le chemin correspond. */
const fauxApi = (reponses, appels = []) => {
  const api = async (methode, chemin, params = {}) => {
    appels.push({ methode, chemin, params });
    for (const [fragment, sortie] of Object.entries(reponses)) if (chemin.includes(fragment)) return sortie;
    throw new Error(`appel inattendu : ${methode} ${chemin}`);
  };
  return api;
};
const vercelOk = (appels) =>
  fauxApi({ '/v9/projects/': { id: 'prj_1' }, '/v6/deployments': { deployments: [recent, ancien] }, '/v13/deployments/dpl_new': { alias: ['x.example'] }, '/v13/deployments/dpl_old': { alias: [] }, '/rollback/': {} }, appels);
const ghFaux = (existantes = []) => {
  const appels = [];
  const gh = async (args) => {
    appels.push(args);
    return args[0] === 'issue' && args[1] === 'list' ? JSON.stringify(existantes) : '';
  };
  return { gh, appels };
};

test('lireProjet : projet, déploiement en ligne et liste READY de production', async () => {
  const appels = [];
  const p = await lireProjet(vercelOk(appels), 'hubperso', 'x.example');
  assert.deepEqual([p.projetId, p.courantId, p.deploiements.length], ['prj_1', 'dpl_new', 2]);
  assert.deepEqual(appels[1].params, { projectId: 'prj_1', target: 'production', state: 'READY', limit: 5 });
});

test('lireProjet : le déploiement en ligne est celui qui porte l’alias de production, pas le plus récent', async () => {
  const api = fauxApi({ '/v9/projects/': { id: 'prj_1', targets: { production: { id: 'dpl_new' } } }, '/v6/deployments': { deployments: [recent, ancien] }, '/v13/deployments/dpl_new': { alias: [] }, '/v13/deployments/dpl_old': { alias: ['x.example'] } });
  assert.equal((await lireProjet(api, 'hubperso', 'x.example')).courantId, 'dpl_old');
});

test('lireProjet : aucun alias de production trouvé → courantId nul (rien ne sera fait)', async () => {
  const api = fauxApi({ '/v9/projects/': { id: 'prj_1' }, '/v6/deployments': { deployments: [recent] }, '/v13/deployments/': { alias: ['autre.example'] } });
  assert.equal((await lireProjet(api, 'hubperso', 'x.example')).courantId, null);
});

test('traiter : remet la version précédente, refait la sonde, ouvre l’issue incident', async () => {
  const appels = [];
  const { gh, appels: ghAppels } = ghFaux();
  const r = await traiter(app, { api: vercelOk(appels), sondeApres: async () => ({ nom: 'hubperso', ok: true, cause: null }), gh, maintenant: MAINTENANT });
  const post = appels.find((a) => a.methode === 'POST');
  assert.equal(post.chemin, '/v1/projects/prj_1/rollback/dpl_old');
  assert.match(r.etat, /retour en arrière fait vers bbbbbbb ; sonde verte/);
  const creation = ghAppels.find((a) => a[0] === 'issue' && a[1] === 'create');
  assert.equal(creation[creation.indexOf('--title') + 1], titreIncident('hubperso', 'aaaaaaa'));
  assert.ok(creation.includes('incident'));
  assert.match(creation[creation.indexOf('--body') + 1], /pull\/12/);
});

test('traiter : sonde toujours rouge après le retour → l’issue le dit', async () => {
  const { gh, appels } = ghFaux();
  const r = await traiter(app, { api: vercelOk([]), sondeApres: async () => ({ nom: 'hubperso', ok: false, cause: 'HTTP 500' }), gh, maintenant: MAINTENANT });
  assert.match(r.etat, /sonde ROUGE/);
  const creation = appels.find((a) => a[0] === 'issue' && a[1] === 'create');
  const corps = creation[creation.indexOf('--body') + 1];
  assert.match(corps, /toujours rouge/);
  assert.match(corps, /HTTP 500/);
});

test('traiter : l’issue existe déjà → pas de doublon', async () => {
  const { gh, appels } = ghFaux([{ title: titreIncident('hubperso', 'aaaaaaa') }]);
  await traiter(app, { api: vercelOk([]), sondeApres: async () => ({ ok: true }), gh, maintenant: MAINTENANT });
  assert.equal(appels.filter((a) => a[1] === 'create' && a[0] === 'issue').length, 0);
});

test('traiter : rien à faire → aucun POST, aucune issue', async () => {
  const appels = [];
  // Déjà retiré : le déploiement en ligne est l'ancien, le fautif récent n'est plus servi.
  const api = fauxApi({ '/v9/projects/': { id: 'prj_1' }, '/v6/deployments': { deployments: [recent, ancien] }, '/v13/deployments/dpl_new': { alias: [] }, '/v13/deployments/dpl_old': { alias: ['x.example'] } }, appels);
  const { gh, appels: ghAppels } = ghFaux();
  const r = await traiter(app, { api, sondeApres: async () => assert.fail('pas de sonde'), gh, maintenant: MAINTENANT });
  assert.match(r.etat, /rien fait/);
  assert.equal(appels.some((a) => a.methode === 'POST'), false);
  assert.equal(ghAppels.length, 0);
});

test('traiter : mode contrôle → lecture seule, dit si la version précédente est prête', async () => {
  const appels = [];
  const { gh, appels: ghAppels } = ghFaux();
  const r = await traiter(app, { api: vercelOk(appels), sondeApres: async () => assert.fail('pas de sonde'), gh, maintenant: MAINTENANT, controle: true });
  assert.match(r.etat, /prêt \(précédente bbbbbbb\)/);
  assert.equal(appels.some((a) => a.methode === 'POST'), false);
  assert.equal(ghAppels.length, 0);
});

test('clientVercel : jeton en en-tête, équipe en paramètre, erreur sans jeton', async () => {
  let vu;
  const ok = clientVercel({ jeton: 'SECRET-123', equipe: 'eq', appel: async (url, init) => ((vu = { url, init }), { ok: true, status: 200, text: async () => '{"a":1}' }) });
  assert.deepEqual(await ok('GET', '/v6/deployments', { limit: 5 }), { a: 1 });
  assert.equal(vu.init.headers.authorization, 'Bearer SECRET-123');
  assert.equal(vu.url.searchParams.get('slug'), 'eq');
  assert.equal(vu.url.searchParams.get('limit'), '5');
  const ko = clientVercel({ jeton: 'SECRET-123', appel: async () => ({ ok: false, status: 403 }) });
  await assert.rejects(ko('GET', '/v9/projects/x'), (err) => /HTTP 403/.test(err.message) && !err.message.includes('SECRET-123'));
});

test('corpsIncident : commit, tâche d’origine, version remise ; le message n’ouvre pas de code', () => {
  const c = corpsIncident({
    app,
    fautif: { sha: 'a'.repeat(40), message: 'feat: `evil` (#7)' },
    precedent: { sha: 'b'.repeat(40) },
    probeApres: { ok: true },
    date: MAINTENANT,
  });
  assert.match(c, /commit\/a{40}/);
  assert.match(c, /pull\/7/);
  assert.match(c, /verte, la production répond de nouveau/);
  assert.doesNotMatch(c, /`evil`/);
});

test('tableau : inactif sans jeton, rien à faire sans panne, une ligne par app sinon', () => {
  assert.match(tableau([], { actif: false }), /Inactif.*VERCEL_TOKEN/);
  assert.match(tableau([], { actif: true }), /Aucune app en panne/);
  assert.match(tableau([{ nom: 'a', etat: 'x' }], { actif: true }), /\| a \| x \|/);
});

test('lireApps : le champ vercel est gardé et validé', () => {
  const base = { nom: 'a', depot: 'M/a', sante: 'https://a.example/s' };
  assert.equal(lireApps([{ ...base, vercel: 'mon-projet' }])[0].vercel, 'mon-projet');
  assert.equal('vercel' in lireApps([base])[0], false);
  assert.throws(() => lireApps([{ ...base, vercel: 'Mauvais Nom' }]), /vercel doit être/);
});

test('appsRetour : surveillance normale = apps avec sonde ET projet Vercel', () => {
  const liste = [app, { nom: 'sans-vercel', depot: 'x/y', sante: 'https://z.example/api/sante' }, { nom: 'sans-sante', depot: 'x/y', vercel: 'p' }];
  assert.deepEqual(appsRetour({}, liste), [app]);
});

test('appsRetour : lancement d\u2019essai = une seule app simulée, jamais une vraie', () => {
  const env = { SURVEILLANCE_ESSAI_URL: 'https://essai.example/api/sante', SURVEILLANCE_ESSAI_NOM: 'essai-retour', RETOUR_ESSAI_VERCEL: 'essai-retour', GITHUB_REPOSITORY: 'MoKarade/.github' };
  assert.deepEqual(appsRetour(env, [app]), [{ nom: 'essai-retour', depot: 'MoKarade/.github', sante: 'https://essai.example/api/sante', vercel: 'essai-retour' }]);
  // URL d'essai sans projet Vercel d'essai (ou nom invalide) : rien n'est traité.
  assert.deepEqual(appsRetour({ ...env, RETOUR_ESSAI_VERCEL: '' }, [app]), []);
  assert.deepEqual(appsRetour({ ...env, RETOUR_ESSAI_VERCEL: '../x' }, [app]), []);
});

test('appsRetour : événement fumee-rouge = seulement l’app de l’URL reçue', () => {
  const autre = { nom: 'autre', depot: 'x/z', sante: 'https://autre.example/api/sante', vercel: 'p2' };
  const liste = [app, autre];
  const origine = new URL(app.sante).origin;
  assert.deepEqual(appsRetour({ RETOUR_URL_BASE: `${origine}/login` }, liste), [app]);
  // URL inconnue ou illisible : rien n'est traité (jamais « toutes les apps » par défaut).
  assert.deepEqual(appsRetour({ RETOUR_URL_BASE: 'https://inconnue.example' }, liste), []);
  assert.deepEqual(appsRetour({ RETOUR_URL_BASE: 'pas une url' }, liste), []);
});

test('clientVercel : un corps vide (retour en arrière) n’est pas une erreur', async () => {
  const api = clientVercel({ jeton: 'J', appel: async () => ({ ok: true, status: 200, text: async () => '' }) });
  assert.deepEqual(await api('POST', '/v1/projects/p/rollback/d'), {});
  const api204 = clientVercel({ jeton: 'J', appel: async () => ({ ok: true, status: 204, text: async () => '' }) });
  assert.deepEqual(await api204('POST', '/x'), {});
});

test('causeHorsDeploiement : la base en panne n\u2019est pas un déploiement fautif', () => {
  assert.equal(causeHorsDeploiement('HTTP 503 (base)'), true);
  assert.equal(causeHorsDeploiement('HTTP 503'), false);
  assert.equal(causeHorsDeploiement('connexion impossible'), false);
  assert.equal(causeHorsDeploiement(undefined), false);
});
