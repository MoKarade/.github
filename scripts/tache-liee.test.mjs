import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { avertissementDeLaTache, controleTacheLiee, defautDeLaTache, dispense, estUneTacheJules, extraireTaches, rapportTacheLiee, tientUnePlace } from './tache-liee.mjs';

// Données fictives, aucun réseau : une fausse API GitHub en mémoire.
const humain = { login: 'MoKarade', type: 'User' };
const tacheOuverte = { number: 120, state: 'open', parent_issue_url: 'https://api.github.com/repos/MoKarade/Hubperso/issues/100', labels: [{ name: 'niveau:tâche' }, { name: 'prio:1' }] };
const issues = (table) => async (methode, chemin) => {
  assert.equal(methode, 'GET');
  const m = /^\/repos\/MoKarade\/([^/]+)\/issues\/(\d+)$/.exec(chemin);
  assert.ok(m, `chemin inattendu : ${chemin}`);
  return table[`${m[1]}#${m[2]}`] ?? null;
};
const pr = (body, extra = {}) => ({ body, user: humain, head: { ref: 'claude/x' }, draft: false, ...extra });

test('extraireTaches : la ligne « Tâche : », les deux formes de référence, sans doublon', () => {
  assert.deepEqual(extraireTaches('Tâche : #12', 'Hubperso'), [{ depot: 'Hubperso', numero: 12 }]);
  assert.deepEqual(extraireTaches('Tâche : MoKarade/.github#120', 'Hubperso'), [{ depot: '.github', numero: 120 }]);
  assert.deepEqual(extraireTaches('**Tâche** : #1, #2 et #1\n> tache: MoKarade/CarAI#9', 'a'), [
    { depot: 'a', numero: 1 }, { depot: 'a', numero: 2 }, { depot: 'CarAI', numero: 9 },
  ]);
});

test('extraireTaches : rien sans la ligne « Tâche : » (Closes, mot dans une phrase, corps vide)', () => {
  assert.deepEqual(extraireTaches('Closes #5', 'a'), []);
  assert.deepEqual(extraireTaches('Cette tâche : voir #5', 'a'), []);
  assert.deepEqual(extraireTaches('Avant : #5 Après : #6', 'a'), []);
  assert.deepEqual(extraireTaches('', 'a'), []);
  assert.deepEqual(extraireTaches(null, 'a'), []);
});

test('dispense : seuls Dependabot, Mergify et GitHub Actions ; ni Jules, ni une personne', () => {
  for (const login of ['dependabot[bot]', 'mergify[bot]', 'github-actions[bot]']) {
    assert.match(dispense({ user: { login, type: 'Bot' } }), /robot/);
  }
  assert.equal(dispense({ user: { login: 'google-labs-jules[bot]', type: 'Bot' } }), null);
  assert.equal(dispense({ user: humain }), null);
  // Un humain qui s'appellerait comme un robot n'est pas dispensé : c'est le type qui compte.
  assert.equal(dispense({ user: { login: 'dependabot[bot]', type: 'User' } }), null);
});

test('dispense : la boîte du Réacteur (brouillon sur sa branche) et rien d’autre', () => {
  assert.equal(dispense({ user: humain, head: { ref: 'claude/boite-reacteur' }, draft: true }), 'boîte du Réacteur');
  assert.equal(dispense({ user: humain, head: { ref: 'claude/boite-reacteur' }, draft: false }), null);
  assert.equal(dispense({ user: humain, head: { ref: 'claude/autre' }, draft: true }), null);
});

test('defautDeLaTache : ouverte avec niveau:tâche ou refus motivé', () => {
  assert.equal(defautDeLaTache(tacheOuverte), null);
  assert.match(defautDeLaTache(null), /introuvable/);
  assert.match(defautDeLaTache({ ...tacheOuverte, state: 'closed' }), /fermée/);
  assert.match(defautDeLaTache({ ...tacheOuverte, labels: [{ name: 'niveau:mission' }] }), /niveau:tâche/);
  assert.match(defautDeLaTache({ ...tacheOuverte, pull_request: {} }), /PR/);
});

test('une PR qui cite une tâche ouverte est verte', async () => {
  const r = await controleTacheLiee({ api: issues({ 'Hubperso#120': tacheOuverte }), depot: 'MoKarade/Hubperso', pr: pr('Tâche : #120') });
  assert.equal(r.ok, true);
  assert.deepEqual(r.citees, [{ depot: 'Hubperso', numero: 120 }]);
  assert.match(rapportTacheLiee(r), /vert \(Hubperso#120\)/);
});

test('une tâche sans parent : vert, mais l’avertissement le dit et il disparaît avec le parent', async () => {
  const sansParent = { ...tacheOuverte, parent_issue_url: null };
  assert.match(avertissementDeLaTache(sansParent), /pas de parent/);
  assert.equal(avertissementDeLaTache(tacheOuverte), null);
  const r = await controleTacheLiee({ api: issues({ 'Hubperso#120': sansParent }), depot: 'MoKarade/Hubperso', pr: pr('Tâche : #120') });
  assert.equal(r.ok, true);
  assert.equal(r.avertissements.length, 1);
  assert.match(rapportTacheLiee(r), /vert \(Hubperso#120\)[\s\S]*sans bloquer[\s\S]*Hubperso#120 : elle n’a pas de parent/);
  const garni = await controleTacheLiee({ api: issues({ 'Hubperso#120': tacheOuverte }), depot: 'MoKarade/Hubperso', pr: pr('Tâche : #120') });
  assert.deepEqual(garni.avertissements, []);
  // une tâche fermée refuse la PR : pas d'avertissement en plus du motif
  const fermee = await controleTacheLiee({ api: issues({ 'Hubperso#120': { ...sansParent, state: 'closed' } }), depot: 'MoKarade/Hubperso', pr: pr('Tâche : #120') });
  assert.equal(fermee.ok, false);
  assert.deepEqual(fermee.avertissements, []);
});

test('une PR sans ligne « Tâche : » est rouge, et le rapport dit quoi faire', async () => {
  const r = await controleTacheLiee({ api: issues({}), depot: 'MoKarade/Hubperso', pr: pr('Avant / Après / Comment') });
  assert.equal(r.ok, false);
  assert.match(rapportTacheLiee(r), /rouge[\s\S]*Tâche : #n[\s\S]*Re-run/);
});

test('une tâche fermée, inconnue, d’un autre niveau ou une PR citée : rouge, avec le motif', async () => {
  const table = {
    'a#1': { ...tacheOuverte, state: 'closed' },
    'a#3': { ...tacheOuverte, labels: [{ name: 'niveau:mission' }] },
    'a#4': { ...tacheOuverte, pull_request: {} },
  };
  for (const [corps, motif] of [['Tâche : #1', /fermée/], ['Tâche : #2', /introuvable/], ['Tâche : #3', /niveau:tâche/], ['Tâche : #4', /PR/]]) {
    const r = await controleTacheLiee({ api: issues(table), depot: 'MoKarade/a', pr: pr(corps) });
    assert.equal(r.ok, false, corps);
    assert.match(r.motifs.join(' '), motif);
  }
});

test('plusieurs références : une seule tâche ouverte suffit', async () => {
  const api = issues({ 'a#1': { ...tacheOuverte, state: 'closed' }, 'a#2': tacheOuverte });
  const r = await controleTacheLiee({ api, depot: 'MoKarade/a', pr: pr('Tâche : #1, #2') });
  assert.equal(r.ok, true);
  assert.deepEqual(r.motifs, []);
});

test('un robot dispensé ne déclenche aucun appel à l’API', async () => {
  const api = async () => { throw new Error('ne doit pas être appelé'); };
  const r = await controleTacheLiee({ api, depot: 'MoKarade/a', pr: { user: { login: 'dependabot[bot]', type: 'Bot' }, body: '' } });
  assert.equal(r.ok, true);
  assert.match(rapportTacheLiee(r), /sans objet/);
});

test('une erreur de l’API se propage (échec fermé : jamais un feu vert)', async () => {
  const api = async () => { throw new Error('HTTP 502'); };
  await assert.rejects(controleTacheLiee({ api, depot: 'MoKarade/a', pr: pr('Tâche : #1') }), /502/);
});

// ── Le Garde-fou de bout en bout : vrai script, fausse API GitHub sur un port local ─────────────────

/** Lance garde-fou.mjs contre une fausse API ; rend le code de sortie et les écritures faites. */
async function lancerGardeFou({ corps, auteur = humain, tache = tacheOuverte, branche = 'claude/x', lignes = 1, labels = [], brouillon = false, enCours = [] }) {
  const ecritures = [];
  const serveur = createServer((req, res) => {
    let donnees = '';
    req.on('data', (c) => { donnees += c; });
    req.on('end', () => {
      const chemin = req.url.split('?')[0];
      const rep = (statut, objet) => { res.writeHead(statut, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(objet)); };
      if (req.method !== 'GET') { ecritures.push(`${req.method} ${chemin} ${donnees}`); return rep(200, { id: 1, number: 99 }); }
      if (chemin === '/repos/MoKarade/depot/pulls/7') {
        return rep(200, { number: 7, state: 'open', draft: brouillon, labels, body: corps, user: auteur, title: 'feat: x', base: { sha: 'b' }, head: { sha: 'h', ref: branche, repo: { full_name: 'MoKarade/depot' } } });
      }
      if (chemin === '/repos/MoKarade/depot/pulls/7/files') return rep(200, [{ filename: 'docs/a.md', status: 'modified', additions: lignes, deletions: 0, patch: '@@ -1 +1 @@\n+x' }]);
      if (chemin === '/repos/MoKarade/depot/issues') return rep(200, req.url.includes('labels=en-cours') ? enCours : []);
      if (chemin === '/repos/MoKarade/depot/issues/7/comments') return rep(200, []);
      if (chemin === '/repos/MoKarade/depot/issues/120') return tache ? rep(200, tache) : rep(404, {});
      return rep(404, {});
    });
  });
  await new Promise((r) => serveur.listen(0, '127.0.0.1', r));
  const script = fileURLToPath(new URL('./garde-fou.mjs', import.meta.url));
  const env = {
    PATH: process.env.PATH, GITHUB_TOKEN: 'jeton-fictif', GITHUB_REPOSITORY: 'MoKarade/depot', PR_NUMBER: '7',
    CHEMINS_PROTEGES: '^(\\.github/|scripts/hooks/|qualite/|vercel\\.json|drizzle/|\\.env|\\.mergify\\.yml)',
    GITHUB_API_URL: `http://127.0.0.1:${serveur.address().port}`,
  };
  const sortie = await new Promise((resolve) => {
    const enfant = spawn(process.execPath, [script], { env });
    let texte = '';
    enfant.stdout.on('data', (c) => { texte += c; });
    enfant.stderr.on('data', (c) => { texte += c; });
    enfant.on('close', (code) => resolve({ code, texte }));
  });
  serveur.close();
  return { ...sortie, ecritures };
}

test('Garde-fou de bout en bout : PR avec tâche ouverte, vert et aucune écriture', async () => {
  const r = await lancerGardeFou({ corps: 'Tâche : #120' });
  assert.equal(r.code, 0, r.texte);
  assert.match(r.texte, /Tâche liée : vert/);
  assert.deepEqual(r.ecritures, []);
});

test('Garde-fou de bout en bout : PR sans tâche, rouge, un commentaire, jamais d’issue qui:marc', async () => {
  const r = await lancerGardeFou({ corps: 'Avant / Après' });
  assert.equal(r.code, 1, r.texte);
  assert.match(r.texte, /Tâche liée : \*\*rouge\*\*/);
  assert.equal(r.ecritures.length, 1);
  assert.match(r.ecritures[0], /^POST \/repos\/MoKarade\/depot\/issues\/7\/comments .*garde-fou-tache/);
  assert.equal(r.ecritures.some((e) => /qui:marc/.test(e)), false);
});

test('Garde-fou de bout en bout : tâche fermée, rouge ; robot dispensé, vert', async () => {
  const fermee = await lancerGardeFou({ corps: 'Tâche : #120', tache: { ...tacheOuverte, state: 'closed' } });
  assert.equal(fermee.code, 1, fermee.texte);
  assert.match(fermee.texte, /fermée/);
  const robot = await lancerGardeFou({ corps: '', auteur: { login: 'dependabot[bot]', type: 'Bot' }, tache: null });
  assert.equal(robot.code, 0, robot.texte);
  assert.match(robot.texte, /sans objet/);
});

test('Garde-fou de bout en bout : PR de 401 lignes sortie du brouillon, rouge avec un commentaire « taille » ; 400 vert', async () => {
  const trop = await lancerGardeFou({ corps: 'Tâche : #120', lignes: 401 });
  assert.equal(trop.code, 1, trop.texte);
  assert.match(trop.texte, /Taille : \*\*rouge\*\*, 401 lignes/);
  assert.equal(trop.ecritures.length, 1);
  assert.match(trop.ecritures[0], /^POST \/repos\/MoKarade\/depot\/issues\/7\/comments .*garde-fou-taille/);
  const limite = await lancerGardeFou({ corps: 'Tâche : #120', lignes: 400 });
  assert.equal(limite.code, 0, limite.texte);
  assert.match(limite.texte, /Taille : vert/);
});

test('Garde-fou de bout en bout : 3000 lignes en brouillon ou avec la dérogation, vert', async () => {
  const brouillon = await lancerGardeFou({ corps: 'Tâche : #120', lignes: 3000, brouillon: true });
  assert.equal(brouillon.code, 0, brouillon.texte);
  const deroge = await lancerGardeFou({ corps: 'Tâche : #120', lignes: 3000, labels: [{ name: 'derogation-taille' }] });
  assert.equal(deroge.code, 0, deroge.texte);
  assert.match(deroge.texte, /dérogation/);
});

test('Garde-fou de bout en bout : dépôt plein (un autre travail en cours), rouge avec un commentaire « places » ; tâche déjà en cours, vert', async () => {
  const unAutre = (number) => ({ number, title: 'autre', labels: [{ name: 'niveau:tâche' }, { name: 'en-cours' }] });
  const autre = [unAutre(130), unAutre(131), unAutre(132)]; // trois places depuis le 26/10/2026
  const deux = await lancerGardeFou({ corps: 'Tâche : #120', enCours: autre.slice(0, 2) });
  assert.equal(deux.code, 0, deux.texte);
  const plein = await lancerGardeFou({ corps: 'Tâche : #120', enCours: autre });
  assert.equal(plein.code, 1, plein.texte);
  assert.match(plein.texte, /Places : \*\*rouge\*\*/);
  assert.equal(plein.ecritures.length, 1);
  assert.match(plein.ecritures[0], /^POST \/repos\/MoKarade\/depot\/issues\/7\/comments .*garde-fou-places/);
  const tient = await lancerGardeFou({ corps: 'Tâche : #120', enCours: autre, tache: { ...tacheOuverte, labels: [{ name: 'niveau:tâche' }, { name: 'en-cours' }] } });
  assert.equal(tient.code, 0, tient.texte);
  const brouillon = await lancerGardeFou({ corps: 'Tâche : #120', enCours: autre, brouillon: true });
  assert.equal(brouillon.code, 0, brouillon.texte);
});

test('une tâche jules ne tient pas de place (23/10/2026), une tâche en-cours si ; la tâche jules est repérée pour n\u2019être jamais refusée', () => {
  const avec = (...noms) => ({ labels: noms.map((name) => ({ name })) });
  assert.equal(tientUnePlace(avec('niveau:tâche', 'en-cours')), true);
  assert.equal(tientUnePlace(avec('niveau:tâche', 'jules')), false);
  assert.equal(estUneTacheJules(avec('niveau:tâche', 'jules')), true);
  assert.equal(estUneTacheJules(avec('niveau:tâche', 'en-cours')), false);
});
