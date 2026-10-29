import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MARQUEUR, choisirFichiers, construireCommentaire, echapper, lireAffected, poster } from './impact-pr.mjs';

// Sorties FICTIVES de `graphify affected`. Tâche MoKarade/.github#842.
const AFFECTED = (...lignes) => `Affected nodes for x.mjs\nRelations: calls, imports_from\nDepth: 2\n${lignes.join('\n')}\n`;
const dep = (chemin, n = 3) => `- ${chemin.split('/').pop()} [imports_from] ${chemin}:L${n}`;
const chemins = (n, prefixe = 'scripts/dep') => Array.from({ length: n }, (_, i) => `${prefixe}${i}.mjs`);

test('choisirFichiers : du code seulement, tests en dernier, 12 au plus et le reste compté', () => {
  const modifies = ['README.md', 'docs/a.md', 'scripts/a.test.mjs', 'scripts/b.mjs', 'app/page.tsx', 'x.sql', 'scripts/b.mjs', ...chemins(14, 'src/f')];
  const { choisis, reste } = choisirFichiers(modifies);
  assert.equal(choisis.length, 12);
  assert.equal(choisis.includes('README.md'), false);
  assert.equal(choisis.includes('scripts/a.test.mjs'), false, 'le test passe après les 17 fichiers de code');
  assert.equal(choisis[0], 'scripts/b.mjs');
  assert.equal(reste, 6, '18 fichiers de code distincts (b.mjs compté une fois), 12 retenus');
});

test('lireAffected : chemins uniques, sans le fichier lui-même ni les docs, tests comptés', () => {
  const texte = AFFECTED(dep('scripts/a.mjs'), dep('scripts/a.mjs', 9), dep('scripts/a.test.mjs'), dep('scripts/cible.mjs'), '- 5 quater. Titre [references] docs/cycle.md:L261', 'ligne qui n’est pas un dépendant');
  const r = lireAffected(texte, 'scripts/cible.mjs');
  assert.deepEqual(r.dependants, ['scripts/a.mjs', 'scripts/a.test.mjs']);
  assert.equal(r.tests, 1);
});

test('lireAffected : « No unique node match », texte vide ou absent → aucun dépendant', () => {
  for (const t of ['No unique node match for x.mjs', '', null, undefined]) assert.deepEqual(lireAffected(t, 'x.mjs'), { dependants: [], tests: 0 });
});

test('commentaire valide : marqueur, fichier modifié, nombre de dépendants, 8 chemins au plus avec « et N autres »', () => {
  const sorties = [AFFECTED(...chemins(11).map((c) => dep(c)), dep('scripts/x.test.mjs'))];
  const corps = construireCommentaire({ modifies: ['scripts/x.mjs'], sorties });
  assert.ok(corps.startsWith(MARQUEUR));
  assert.match(corps, /`scripts\/x\.mjs` : \*\*12 fichiers\*\* en dépendent, dont 1 test\b/);
  assert.equal((corps.match(/`scripts\/dep\d+\.mjs`/g) ?? []).length, 8);
  assert.match(corps, /et 4 autres/);
});

test('un seul dépendant : singulier', () => {
  const corps = construireCommentaire({ modifies: ['a.mjs'], sorties: [AFFECTED(dep('b.mjs'))] });
  assert.match(corps, /\*\*1 fichier\*\* en dépend, dont 0 test\b/);
});

test('aucun fichier de code modifié, ou aucun dépendant → pas de commentaire', () => {
  assert.equal(construireCommentaire({ modifies: ['README.md', 'docs/x.md', 'package-lock.json'], sorties: [] }), null);
  assert.equal(construireCommentaire({ modifies: ['scripts/x.mjs'], sorties: [AFFECTED()] }), null);
  assert.equal(construireCommentaire({ modifies: ['scripts/x.mjs'], sorties: ['No unique node match for scripts/x.mjs'] }), null);
  assert.equal(construireCommentaire({ modifies: [], sorties: [] }), null);
});

test('un fichier sans dépendant n’apparaît pas ; celui qui en a, oui', () => {
  const corps = construireCommentaire({ modifies: ['a.mjs', 'b.mjs'], sorties: [AFFECTED(), AFFECTED(dep('c.mjs'))] });
  assert.doesNotMatch(corps, /`a\.mjs`/);
  assert.match(corps, /`b\.mjs`/);
});

test('chemins avec caractères Markdown, accent grave ou retour à la ligne : échappés dans un segment de code', () => {
  assert.equal(echapper('a`b.mjs'), "`a'b.mjs`");
  assert.equal(echapper('a\nb\r\nc.mjs'), '`a b c.mjs`');
  assert.equal(echapper('x'.repeat(500)).length, 202);
  const mechant = 'scripts/[x](http://evil) # titre @mario.mjs'; // les retours à la ligne sont couverts par echapper ci-dessus ; dans la sortie d’affected ils coupent la ligne, qui est alors écartée
  const corps = construireCommentaire({ modifies: ['a.mjs'], sorties: [AFFECTED(`- n [calls] ${mechant}:L3`)] });
  assert.match(corps, /`scripts\/\[x\]\(http:\/\/evil\) # titre @mario\.mjs`/);
  assert.equal(corps.split('\n').filter((l) => l.includes('evil')).length, 1);
  assert.equal(construireCommentaire({ modifies: ['a.mjs'], sorties: [AFFECTED('- n [calls] scripts/x\n.mjs:L3')] }), null, 'chemin coupé par un retour à la ligne : écarté, rien de partiel');
});

test('plus de 12 fichiers de code modifiés : coupé avec « et N autres »', () => {
  const modifies = chemins(15, 'src/m');
  const sorties = modifies.slice(0, 12).map(() => AFFECTED(dep('src/lecteur.mjs')));
  const corps = construireCommentaire({ modifies, sorties });
  assert.equal((corps.match(/en dépendent?,/g) ?? []).length, 12);
  assert.match(corps, /et 3 autres fichiers de code modifiés/);
});

// poster : une fausse API en mémoire.
function fausseApi(commentaires = []) {
  const appels = [];
  const api = async (methode, chemin, corps) => {
    appels.push({ methode, chemin, corps });
    if (methode === 'GET') return commentaires;
    return null;
  };
  return { api, appels };
}
const robot = (id, body) => ({ id, body, user: { type: 'Bot' } });

test('poster : crée le commentaire s’il n’existe pas', async () => {
  const { api, appels } = fausseApi([{ id: 1, body: 'autre', user: { type: 'User' } }]);
  assert.equal(await poster({ api, depot: 'MoKarade/x', pr: 5, corps: `${MARQUEUR}\nA` }), 'cree');
  assert.deepEqual(appels.at(-1), { methode: 'POST', chemin: '/repos/MoKarade/x/issues/5/comments', corps: { body: `${MARQUEUR}\nA` } });
});

test('poster : met à jour sur place le commentaire du robot, sans en créer un second', async () => {
  const { api, appels } = fausseApi([robot(9, `${MARQUEUR}\nvieux`)]);
  assert.equal(await poster({ api, depot: 'MoKarade/x', pr: 5, corps: `${MARQUEUR}\nneuf` }), 'mis-a-jour');
  assert.equal(appels.at(-1).methode, 'PATCH');
  assert.equal(appels.at(-1).chemin, '/repos/MoKarade/x/issues/comments/9');
  assert.equal(appels.filter((a) => a.methode === 'POST').length, 0);
});

test('poster : contenu identique → aucune écriture ; commentaire marqué par un humain → ignoré', async () => {
  const { api, appels } = fausseApi([robot(9, `${MARQUEUR}\nA`)]);
  assert.equal(await poster({ api, depot: 'MoKarade/x', pr: 5, corps: `${MARQUEUR}\nA` }), 'rien');
  assert.equal(appels.every((a) => a.methode === 'GET'), true);
  const humain = fausseApi([{ id: 3, body: `${MARQUEUR}\nfaux`, user: { type: 'User' } }]);
  assert.equal(await poster({ api: humain.api, depot: 'MoKarade/x', pr: 5, corps: `${MARQUEUR}\nA` }), 'cree');
});

test('poster : plus rien à dire → l’ancien commentaire est retiré ; sinon aucune écriture', async () => {
  const avec = fausseApi([robot(9, `${MARQUEUR}\nvieux`)]);
  assert.equal(await poster({ api: avec.api, depot: 'MoKarade/x', pr: 5, corps: null }), 'retire');
  assert.equal(avec.appels.at(-1).methode, 'DELETE');
  const sans = fausseApi([]);
  assert.equal(await poster({ api: sans.api, depot: 'MoKarade/x', pr: 5, corps: null }), 'rien');
  assert.equal(sans.appels.every((a) => a.methode === 'GET'), true);
});
