import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ECRAN, MARQUEUR_AUTO, accepterApresFusion, regleImplicite, corpsAcceptee, derniersParNom, ecran, evaluerEligibilite, lireProduction, lireSonde, veutAuto } from './acceptation-auto.mjs';
import { ENTETE_ABANDON, evaluer, trouverPreuve } from './preuve.mjs';

const DEPOT = 'MoKarade/JobAI';
const SHA = 'ea239e9a1b2c3d4e5f60718293a4b5c6d7e8f901';
const TETE = 'bbbbbbbb1b2c3d4e5f60718293a4b5c6d7e8f901';
const FUSION = '2026-10-21T14:00:00Z';
const AUTO = '**Acceptation automatique** : oui — le « Fini quand » est un contrôle CI.';

/** Une fausse API GitHub avec état : fermer l'issue la ferme pour de bon, un commentaire s'ajoute à la liste. */
function faux({ corps = `Tâche : #115`, issueBody = `**Avant** : x\n${AUTO}\n**Attend** : aucune`, labels = ['niveau:tâche', 'en-cours'], fichiers = ['docs/cycle-de-vie-tache.md'], controles = [{ name: 'Gate', status: 'completed', conclusion: 'success' }], ouvertes = [], deploiements = [], merged = true, refusPr = false } = {}) {
  const etat = { issue: { number: 115, state: 'open', state_reason: null, body: issueBody, labels: labels.map((name) => ({ name })) }, commentaires: [], ecritures: [] };
  const api = async (methode, chemin, body) => {
    const ligne = `${methode} ${chemin.split('?')[0]}`;
    if (methode !== 'GET') etat.ecritures.push(ligne);
    if (ligne === `GET /repos/${DEPOT}/pulls/7`) return { number: 7, merged, merged_at: FUSION, merge_commit_sha: SHA, head: { sha: TETE }, body: corps, user: { login: 'MoKarade', type: 'User' } };
    if (ligne === `GET /repos/${DEPOT}/issues/115`) return etat.issue;
    if (ligne === `GET /repos/${DEPOT}/pulls/7/files`) return fichiers.map((filename) => ({ filename }));
    if (ligne === `GET /repos/${DEPOT}/commits/${TETE}/check-runs`) return { check_runs: controles };
    if (ligne === `GET /repos/${DEPOT}/pulls`) return ouvertes;
    if (ligne === `GET /repos/${DEPOT}/deployments`) return deploiements.map((d) => d.dep);
    if (/\/deployments\/\d+\/statuses$/.test(ligne)) return [{ state: 'success' }];
    if (/\/compare\//.test(ligne)) return { status: 'identical' };
    if (ligne === `GET /repos/${DEPOT}/issues/115/comments`) return etat.commentaires;
    if (ligne === `POST /repos/${DEPOT}/issues/115/comments`) {
      etat.commentaires.push({ body: body.body, user: { login: 'github-actions[bot]', type: 'Bot' }, created_at: '2026-10-21T14:01:00Z' });
      return {};
    }
    if (ligne === `PATCH /repos/${DEPOT}/issues/115`) {
      Object.assign(etat.issue, body);
      return etat.issue;
    }
    if (methode === 'DELETE') {
      const nom = decodeURIComponent(chemin.split('/labels/')[1]);
      etat.issue.labels = etat.issue.labels.filter((l) => l.name !== nom);
      return null;
    }
    if (ligne === `POST /repos/${DEPOT}/issues/7/comments`) {
      if (refusPr) throw new Error('HTTP 403 Resource not accessible by integration');
      return {};
    }
    return null;
  };
  return { api, etat };
}
const dormir = async () => {};
const lancer = (f, config = { deploiement: 'aucun' }) => accepterApresFusion({ api: f.api, depot: DEPOT, numeroPr: 7, config, maintenant: () => new Date('2026-10-21T14:01:00Z'), dormir, essais: 2, pause: 0 });

test('docs seules, tâche qui le demande : acceptée, fermée, étiquettes retirées, signal sur la PR', async () => {
  const f = faux();
  const r = await lancer(f);
  assert.equal(r.statut, 'acceptee');
  assert.equal(r.tache, 115);
  assert.equal(f.etat.issue.state, 'closed');
  assert.equal(f.etat.issue.state_reason, 'completed');
  assert.deepEqual(f.etat.issue.labels.map((l) => l.name), ['niveau:tâche']);
  const preuve = f.etat.commentaires[0].body;
  assert.match(preuve, /^\*\*Acceptée\*\* — PR #7 fusionnée \(ea239e9\), sans déploiement : ce dépôt ne se déploie pas, preuve : contrôles réussis sur la tête bbbbbbb de la PR \(1\), aucun rouge ; 1 fichiers touchés, aucun écran/);
  assert.ok(preuve.includes(MARQUEUR_AUTO));
  assert.match(preuve, /la production n’a pas été lue par une personne/);
  assert.ok(f.etat.ecritures.includes(`POST /repos/${DEPOT}/issues/7/comments`));
  // le garde-fou de preuve reconnaît ce commentaire, et lui seul : sans le marqueur, un robot ne prouve rien
  assert.ok(trouverPreuve(f.etat.commentaires));
  assert.equal(trouverPreuve([{ ...f.etat.commentaires[0], body: preuve.replace(MARQUEUR_AUTO, '') }]), null);
});

test('rien ne s’écrit quand la tâche ne demande pas l’acceptation automatique', async () => {
  const f = faux({ issueBody: '**Avant** : x\n**Attend** : aucune' });
  const r = await lancer(f);
  assert.equal(r.statut, 'ignoree');
  assert.deepEqual(f.etat.ecritures, []);
});

test('un écran touché, un contrôle rouge, une attente ou une autre PR qui cite la tâche : refusé, rien n’est écrit', async () => {
  const cas = [
    [{ fichiers: ['docs/a.md', 'app/page.tsx'] }, /écran/],
    [{ fichiers: ['public/logo.png'] }, /écran/],
    [{ controles: [{ name: 'Gate', status: 'completed', conclusion: 'failure' }] }, /rouge/],
    [{ labels: ['niveau:tâche', 'en-cours', 'qui:marc'] }, /attend quelque chose/],
    [{ labels: ['niveau:tâche', 'preuve-attendue'] }, /attend quelque chose/],
    [{ ouvertes: [{ number: 9, body: 'Tâche : #115' }] }, /autre PR ouverte/],
    [{ corps: 'Tâche : #115 et #116' }, /exactement une tâche/],
    [{ corps: 'Aucune tâche' }, /exactement une tâche/],
    [{ merged: false }, /pas fusionnée/],
  ];
  for (const [options, motif] of cas) {
    const f = faux(options);
    const r = await lancer(f);
    assert.equal(r.statut, 'ignoree', JSON.stringify(options));
    assert.match(r.motifs.join(' '), motif, JSON.stringify(options));
    assert.deepEqual(f.etat.ecritures, [], JSON.stringify(options));
    assert.equal(f.etat.issue.state, 'open');
  }
});

test('code servi : sans déploiement READY dans le délai la tâche reste ouverte ; avec, elle est acceptée et le déploiement est cité', async () => {
  const servi = faux({ fichiers: ['lib/calcul.ts'] });
  const r = await lancer(servi, { deploiement: 'vercel' });
  assert.equal(r.statut, 'ignoree');
  assert.match(r.motifs[0], /aucun déploiement de production réussi/);
  assert.deepEqual(servi.etat.ecritures, []);

  const ok = faux({ fichiers: ['lib/calcul.ts'], deploiements: [{ dep: { id: 42, sha: SHA, created_at: '2026-10-21T14:00:40Z' } }] });
  const r2 = await lancer(ok, { deploiement: 'vercel' });
  assert.equal(r2.statut, 'acceptee');
  assert.match(ok.etat.commentaires[0].body, /déploiement READY \(déploiement 42 sur ea239e9\)/);
});

test('le commentaire de la PR refusé (403) ne défait pas l\'acceptation, et le dit dans le journal', async () => {
  const f = faux({ refusPr: true });
  const avertissements = [];
  const avertir = console.warn;
  console.warn = (m) => avertissements.push(String(m));
  try {
    const r = await lancer(f);
    assert.equal(r.statut, 'acceptee');
  } finally {
    console.warn = avertir;
  }
  assert.equal(f.etat.issue.state, 'closed');
  assert.equal(avertissements.length, 1);
  assert.match(avertissements[0], /non posté sur la PR #7.*403/);
});

test('le commentaire posé passe toujours le garde-fou de preuve (jamais de réouverture après coup)', async () => {
  const f = faux();
  await lancer(f);
  const pr = { merged: true, merged_at: FUSION, merge_commit_sha: SHA, head_sha: TETE };
  const v = evaluer({ raison: 'completed', commentaires: f.etat.commentaires, pr, fichiers: ['docs/x.md'], deploiement: { requis: false, ok: null, detail: '' } });
  assert.deepEqual(v.motifs, []);
});

test('le marqueur ne vaut que pour « Acceptée », que pour github-actions[bot], et jamais pour un abandon', () => {
  const corps = `**Acceptée** — PR #7 fusionnée (ea239e9), preuve : ${'x'.repeat(50)}\n${MARQUEUR_AUTO}`;
  const bot = (login) => ({ body: corps, user: { login, type: 'Bot' }, created_at: '2026-10-21T14:01:00Z' });
  assert.ok(trouverPreuve([bot('github-actions[bot]')]));
  assert.equal(trouverPreuve([bot('dependabot[bot]')]), null);
  assert.equal(trouverPreuve([bot('google-labs-jules[bot]')]), null);
  const abandon = { body: `**Abandonnée** — ${'x'.repeat(30)}\n${MARQUEUR_AUTO}`, user: { login: 'github-actions[bot]', type: 'Bot' }, created_at: '2026-10-21T14:01:00Z' };
  assert.equal(trouverPreuve([abandon], ENTETE_ABANDON), null);
});

test('écran : composants, styles, images, HTML, public/ ; une route d’API ou un contrat n’en est pas un', () => {
  for (const f of ['app/page.tsx', 'a/b.jsx', 'styles/x.css', 'index.html', 'img/a.svg', 'public/robots.txt', 'x/public/a.js']) assert.ok(ecran([f]), f);
  for (const f of ['app/api/hub/summary/route.ts', 'lib/calcul.ts', 'docs/a.md', 'scripts/a.mjs', 'tests/a.test.ts', '.github/workflows/a.yml']) assert.equal(ecran([f]), false, f);
  assert.ok(ECRAN instanceof RegExp);
});

test('la ligne « Acceptation automatique » se reconnaît en gras, en liste ou nue, et seulement avec « oui »', () => {
  for (const body of ['**Acceptation automatique** : oui — CI', 'x\nAcceptation automatique : oui', '- **Acceptation automatique**: oui']) assert.ok(veutAuto({ body }), body);
  for (const body of ['**Acceptation automatique** : non', 'je veux une acceptation automatique oui', '']) assert.equal(veutAuto({ body }), false, body);
});

test('éligibilité : une tâche fermée ou sans l’étiquette niveau:tâche n’est pas acceptée', () => {
  const base = { numeroTache: 1, pr: { merged: true }, fichiers: ['docs/a.md'], controles: [], autresPr: [], depot: DEPOT };
  const issue = (o) => ({ number: 1, state: 'open', body: AUTO, labels: [{ name: 'niveau:tâche' }], ...o });
  assert.equal(evaluerEligibilite({ ...base, issue: issue() }).ok, true);
  assert.match(evaluerEligibilite({ ...base, issue: issue({ state: 'closed' }) }).motifs[0], /fermée/);
  assert.match(evaluerEligibilite({ ...base, issue: issue({ labels: [] }) }).motifs[0], /niveau:tâche/);
  assert.equal(evaluerEligibilite({ ...base, issue: issue(), fichiers: [] }).ok, false);
});

test('la tâche citée avec son dépôt (« Tâche : MoKarade/JobAI#115 ») est reconnue comme celle du dépôt', async () => {
  const f = faux({ corps: 'Tâche : MoKarade/JobAI#115' });
  const r = await lancer(f);
  assert.equal(r.statut, 'acceptee');
  const autre = faux({ corps: 'Tâche : MoKarade/CarAI#115' });
  assert.equal((await lancer(autre)).statut, 'ignoree');
  assert.deepEqual(autre.etat.ecritures, []);
});

test('un contrôle annulé puis relancé avec succès ne bloque pas ; la dernière exécution rouge, si', async () => {
  const gate = { name: 'Gate', status: 'completed', conclusion: 'success', id: 5 };
  const f = faux({ controles: [{ name: 'Garde-fou', status: 'completed', conclusion: 'cancelled', id: 1 }, { name: 'Garde-fou', status: 'completed', conclusion: 'success', id: 2 }, gate] });
  assert.equal((await lancer(f)).statut, 'acceptee');
  const rouge = faux({ controles: [{ name: 'Garde-fou', status: 'completed', conclusion: 'success', id: 1 }, { name: 'Garde-fou', status: 'completed', conclusion: 'failure', id: 2 }, gate] });
  const r = await lancer(rouge);
  assert.equal(r.statut, 'ignoree');
  assert.match(r.motifs[0], /rouge/);
  assert.deepEqual(derniersParNom([{ name: 'a', id: 2, conclusion: 'success' }, { name: 'a', id: 1, conclusion: 'failure' }]).map((c) => c.conclusion), ['success']);
});

// ---- « Fini quand exécutable » : la production est lue par une sonde (refonte du 26/10/2026, décision 1) ----
const LIGNE = (texte) => `**Avant** : x\n**Fini quand exécutable** : ${texte}\n**Attend** : aucune`;

test('la ligne « Fini quand exécutable » : adresse, statut et texte attendus', () => {
  assert.deepEqual(lireSonde({ body: LIGNE('GET https://emploi.hubperso.com/api/sante → 200') }), { sonde: { url: 'https://emploi.hubperso.com/api/sante', statut: 200, contient: '' } });
  assert.deepEqual(lireSonde({ body: LIGNE('GET https://hubperso.com/ -> 200, contient « Hub perso »') }), { sonde: { url: 'https://hubperso.com/', statut: 200, contient: 'Hub perso' } });
  assert.deepEqual(lireSonde({ body: '**Avant** : rien' }), { sonde: null });
});

test('la sonde refuse tout ce qui n’est pas du https sur hubperso.com, sans port ni identifiant, ni forme exacte', () => {
  const refus = [
    'GET http://emploi.hubperso.com/ → 200',
    'GET https://exemple.com/ → 200',
    'GET https://hubperso.com.exemple.com/ → 200',
    'GET https://exemple.com/?x=.hubperso.com → 200',
    'GET https://emploi.hubperso.com:8443/ → 200',
    'GET https://marc:secret@emploi.hubperso.com/ → 200',
    'GET https://127.0.0.1/ → 200',
    'POST https://emploi.hubperso.com/ → 200',
    'GET https://emploi.hubperso.com/ → 99',
    'GET https://emploi.hubperso.com/ → 700',
    'GET https://emploi.hubperso.com/',
    `GET https://emploi.hubperso.com/${'a'.repeat(300)} → 200`,
  ];
  for (const texte of refus) {
    const r = lireSonde({ body: LIGNE(texte) });
    assert.ok(r.erreur, texte);
    assert.equal(r.sonde, undefined, texte);
  }
});

const reponse = (status, texte = '') => ({ status, text: async () => texte });
const sonde = { url: 'https://emploi.hubperso.com/api/sante', statut: 200, contient: '' };
const MAINTENANT = () => new Date('2026-10-26T22:00:00Z');

test('lireProduction : réponse conforme, ce qui est lu est rendu tel quel', async () => {
  const appels = [];
  const r = await lireProduction({ sonde: { ...sonde, contient: 'ok' }, fetchImpl: async (url, options) => (appels.push([url, options.redirect, options.method]), reponse(200, '{"statut":"ok"}')), dormir: async () => {}, maintenant: MAINTENANT });
  assert.deepEqual(r, { ok: true, detail: 'GET https://emploi.hubperso.com/api/sante → 200, contient « ok » : oui, lu le 2026-10-26T22:00:00.000Z' });
  assert.deepEqual(appels, [[sonde.url, 'manual', 'GET']]);
});

test('lireProduction : mauvais statut, texte absent, redirection (jamais suivie), erreur réseau : 3 essais puis refus qui dit pourquoi', async () => {
  const dormis = [];
  const dormir = async (ms) => dormis.push(ms);
  const cas = [
    [reponse(503), /→ 503, attendu 200/, sonde],
    [reponse(200, 'autre chose'), /texte « ok » est absent/, { ...sonde, contient: 'ok' }],
    [reponse(302), /→ 302, attendu 200/, sonde],
  ];
  for (const [rep, motif, s] of cas) {
    dormis.length = 0;
    const r = await lireProduction({ sonde: s, fetchImpl: async () => rep, dormir, maintenant: MAINTENANT });
    assert.equal(r.ok, false);
    assert.match(r.detail, motif);
    assert.equal(dormis.length, 2, '3 essais, 2 pauses');
  }
  const r = await lireProduction({ sonde, fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); }, dormir, maintenant: MAINTENANT });
  assert.equal(r.ok, false);
  assert.match(r.detail, /ENOTFOUND/);
});

test('lireProduction : la nouvelle version arrive au 2e essai, c’est accepté', async () => {
  let n = 0;
  const r = await lireProduction({ sonde, fetchImpl: async () => reponse(++n === 1 ? 502 : 200), dormir: async () => {}, maintenant: MAINTENANT });
  assert.equal(r.ok, true);
  assert.equal(n, 2);
});

test('tâche avec « Fini quand exécutable » : la production est lue après le déploiement, le commentaire copie la lecture, le garde-fou de preuve le valide', async () => {
  const f = faux({ issueBody: LIGNE('GET https://emploi.hubperso.com/api/sante → 200, contient « ok »'), fichiers: ['lib/calcul.ts'], deploiements: [{ dep: { id: 42, sha: SHA, created_at: '2026-10-21T14:00:40Z' } }] });
  const appels = [];
  const r = await accepterApresFusion({
    api: f.api, depot: DEPOT, numeroPr: 7, config: { deploiement: 'vercel' }, maintenant: MAINTENANT, dormir, essais: 2, pause: 0,
    sonde: { fetchImpl: async (url) => (appels.push(url), reponse(200, '{"statut":"ok"}')), dormir },
  });
  assert.equal(r.statut, 'acceptee');
  assert.deepEqual(appels, ['https://emploi.hubperso.com/api/sante']);
  assert.equal(f.etat.issue.state, 'closed');
  const preuve = f.etat.commentaires[0].body;
  assert.match(preuve, /déploiement READY \(déploiement 42 sur ea239e9\)/);
  assert.match(preuve, /production lue par la sonde : GET https:\/\/emploi\.hubperso\.com\/api\/sante → 200, contient « ok » : oui, lu le 2026-10-26T22:00:00\.000Z\./);
  assert.doesNotMatch(preuve, /n’a pas été lue par une personne/);
  assert.ok(trouverPreuve(f.etat.commentaires));
  const pr = { merged: true, merged_at: FUSION, merge_commit_sha: SHA, head_sha: TETE };
  const v = evaluer({ raison: 'completed', commentaires: f.etat.commentaires, pr, fichiers: ['lib/calcul.ts'], deploiement: { requis: true, ok: true, detail: 'déploiement 42 sur ea239e9' } });
  assert.deepEqual(v.motifs, []);
});

test('sonde en échec ou ligne refusée : rien ne s’écrit, un fil prouvera', async () => {
  const cas = [
    [LIGNE('GET https://emploi.hubperso.com/api/sante → 200'), async () => reponse(500), /sonde de la tâche n’a pas lu ce qui était attendu.*500/],
    [LIGNE('GET https://exemple.com/ → 200'), async () => reponse(200), /ne lit que du https sur hubperso\.com/],
  ];
  for (const [issueBody, fetchImpl, motif] of cas) {
    const f = faux({ issueBody });
    const r = await accepterApresFusion({ api: f.api, depot: DEPOT, numeroPr: 7, config: { deploiement: 'aucun' }, maintenant: MAINTENANT, dormir, essais: 2, pause: 0, sonde: { fetchImpl, dormir } });
    assert.equal(r.statut, 'ignoree', issueBody);
    assert.match(r.motifs.join(' '), motif);
    assert.deepEqual(f.etat.ecritures, []);
    assert.equal(f.etat.issue.state, 'open');
  }
});

test('un écran touché reste prouvé par un fil, même avec une sonde', async () => {
  const f = faux({ issueBody: LIGNE('GET https://emploi.hubperso.com/ → 200'), fichiers: ['app/page.tsx'] });
  const r = await accepterApresFusion({ api: f.api, depot: DEPOT, numeroPr: 7, config: { deploiement: 'aucun' }, maintenant: MAINTENANT, dormir, essais: 2, pause: 0, sonde: { fetchImpl: async () => reponse(200), dormir } });
  assert.equal(r.statut, 'ignoree');
  assert.match(r.motifs.join(' '), /écran/);
});

test('le corps sans sonde garde sa phrase d’origine', () => {
  const corps = corpsAcceptee({ pr: { number: 7, merge_commit_sha: SHA, head: { sha: TETE } }, controles: [], fichiers: ['a.md'], deploiement: { ok: null }, servie: false, sansDeploiement: 'docs' });
  assert.match(corps, /la production n’a pas été lue par une personne\./);
});

// Règle prudente appliquée À LA FUSION (tâche #699) : la ligne n'a plus besoin d'avoir été posée avant, ce qui perdait la course contre les fils.
const SANS_LIGNE = '**Avant** : x\n\n**Après** : y\n\n**Fini quand** : les tests et la CI sont verts.\n\n**Fichiers touchés** :\n- `scripts/a.mjs`\n\n**Attend** : aucune';

test('sans aucune ligne « Acceptation automatique », un « Fini quand » de machine s’accepte à la fusion, et le commentaire le dit', async () => {
  const f = faux({ issueBody: SANS_LIGNE });
  const r = await lancer(f);
  assert.equal(r.statut, 'acceptee');
  assert.equal(f.etat.issue.state, 'closed');
  const preuve = f.etat.commentaires[0].body;
  assert.match(preuve, /règle prudente appliquée à la fusion/);
  assert.match(preuve, /la production n’a pas été lue par une personne/);
  assert.ok(trouverPreuve(f.etat.commentaires));
});

test('une ligne « non » se respecte, une tâche non éligible, Jules ou une attente ne s’acceptent pas seuls', async () => {
  const cas = [
    [{ issueBody: `${SANS_LIGNE}\n**Acceptation automatique** : non — à regarder.` }, /ne demande pas/],
    [{ issueBody: '**Avant** : x\n**Fini quand** : la page affiche le bouton.\n**Fichiers touchés** :\n- `scripts/a.mjs`' }, /ne demande pas/],
    [{ issueBody: SANS_LIGNE, labels: ['niveau:tâche', 'jules'] }, /ne demande pas/],
    [{ issueBody: SANS_LIGNE, labels: ['niveau:tâche', 'qui:marc'] }, /attend quelque chose/],
    [{ issueBody: SANS_LIGNE, fichiers: ['app/page.tsx'] }, /écran/],
    [{ issueBody: SANS_LIGNE, controles: [{ name: 'Gate', status: 'completed', conclusion: 'failure' }] }, /rouge/],
  ];
  for (const [options, motif] of cas) {
    const f = faux(options);
    const r = await lancer(f);
    assert.equal(r.statut, 'ignoree', JSON.stringify(options));
    assert.match(r.motifs.join(' '), motif, JSON.stringify(options));
    assert.deepEqual(f.etat.ecritures, [], JSON.stringify(options));
  }
});

test('regleImplicite : vraie seulement sans ligne, sans Jules, avec un « Fini quand » de machine', async () => {
  assert.equal(await regleImplicite({ title: 't', body: SANS_LIGNE, labels: [] }), true);
  assert.equal(await regleImplicite({ title: 't', body: `${SANS_LIGNE}\n${AUTO}`, labels: [] }), false);
  assert.equal(await regleImplicite({ title: 't', body: SANS_LIGNE, labels: [{ name: 'jules' }] }), false);
  assert.equal(await regleImplicite({ title: 't', body: 'rien', labels: [] }), false);
});

test('le corps de la règle prudente remplace la phrase d’origine', () => {
  const corps = corpsAcceptee({ pr: { number: 7, merge_commit_sha: SHA, head: { sha: TETE } }, controles: [], fichiers: ['a.md'], deploiement: { ok: null }, servie: false, sansDeploiement: 'docs', implicite: true });
  assert.doesNotMatch(corps, /demandée par la ligne/);
  assert.match(corps, /règle prudente appliquée à la fusion/);
});

// Classe B (scripts/fini-quand.mjs, scripts/preuve-page.mjs) : l'écran a été lu en mode fictif par un navigateur sans tête.
const PAGE_LUE = { ok: true, detail: 'GET /totaux → 200, contient « Total » : lu' };
const CORPS_B = '**Avant** : x\n**Fini quand** (classe B) : la page des totaux s’affiche.\n**Lecture de page** : GET /totaux → 200, contient « Total »\n**Attend** : aucune';

test('classe B : un écran lu en mode fictif s’accepte, le commentaire dit que la lecture est fictive et passe le garde-fou de preuve', async () => {
  const f = faux({ issueBody: CORPS_B, fichiers: ['app/totaux/page.tsx'], deploiements: [{ dep: { id: 42, sha: SHA, created_at: '2026-10-21T14:00:40Z' } }] });
  const r = await accepterApresFusion({ api: f.api, depot: DEPOT, numeroPr: 7, config: { deploiement: 'vercel' }, maintenant: MAINTENANT, dormir, essais: 2, pause: 0, pageLue: PAGE_LUE });
  assert.equal(r.statut, 'acceptee');
  assert.equal(f.etat.issue.state, 'closed');
  const preuve = f.etat.commentaires[0].body;
  assert.match(preuve, /déploiement READY \(déploiement 42 sur ea239e9\)/);
  assert.match(preuve, /écran lu par un navigateur sans tête sur le commit fusionné, en mode fictif \(données des tests, jamais la production\) : GET \/totaux → 200, contient « Total » : lu/);
  assert.match(preuve, /acceptation automatique de classe B/);
  assert.doesNotMatch(preuve, /aucun écran/);
  assert.ok(trouverPreuve(f.etat.commentaires));
  const pr = { merged: true, merged_at: FUSION, merge_commit_sha: SHA, head_sha: TETE };
  const v = evaluer({ raison: 'completed', commentaires: f.etat.commentaires, pr, fichiers: ['app/totaux/page.tsx'], deploiement: { requis: true, ok: true, detail: 'déploiement 42 sur ea239e9' } });
  assert.deepEqual(v.motifs, []);
});

test('classe B : sans lecture réussie l’écran reste prouvé par un fil ; un contrôle rouge ou une attente refusent quand même', async () => {
  for (const pageLue of [null, { ok: false, detail: 'GET /totaux → 500' }]) {
    const f = faux({ issueBody: CORPS_B, fichiers: ['app/totaux/page.tsx'] });
    const r = await accepterApresFusion({ api: f.api, depot: DEPOT, numeroPr: 7, config: { deploiement: 'aucun' }, maintenant: MAINTENANT, dormir, essais: 2, pause: 0, pageLue });
    assert.equal(r.statut, 'ignoree');
    assert.deepEqual(f.etat.ecritures, []);
  }
  const rouge = faux({ issueBody: CORPS_B, fichiers: ['app/totaux/page.tsx'], controles: [{ name: 'Gate', status: 'completed', conclusion: 'failure' }] });
  const r1 = await accepterApresFusion({ api: rouge.api, depot: DEPOT, numeroPr: 7, config: { deploiement: 'aucun' }, maintenant: MAINTENANT, dormir, essais: 2, pause: 0, pageLue: PAGE_LUE });
  assert.equal(r1.statut, 'ignoree');
  assert.match(r1.motifs.join(' '), /contrôle est rouge/);
  const attend = faux({ issueBody: CORPS_B, labels: ['niveau:tâche', 'en-cours', 'qui:marc'], fichiers: ['app/totaux/page.tsx'] });
  const r2 = await accepterApresFusion({ api: attend.api, depot: DEPOT, numeroPr: 7, config: { deploiement: 'aucun' }, maintenant: MAINTENANT, dormir, essais: 2, pause: 0, pageLue: PAGE_LUE });
  assert.equal(r2.statut, 'ignoree');
  assert.match(r2.motifs.join(' '), /attend quelque chose/);
});
