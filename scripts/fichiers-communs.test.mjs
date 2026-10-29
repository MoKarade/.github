import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fichiersDeclares, seRecouvrent, conflitDeFichiers, raisonIncompatible, controleFichiers, rapportFichiers } from './fichiers-communs.mjs';

test('fichiersDeclares lit « Fichiers permis » : chemins entre backticks, hors journaux', () => {
  const corps = [
    '**Avant** : x', '',
    '**Fichiers permis** (aucun autre) :', '- `src/a.ts` (le code)', '- `tests/a.test.ts`', '- `HANDOVER.md`', '',
    '**À faire** :', '1. `autre/chose.ts` ne compte pas',
  ].join('\n');
  assert.deepEqual(fichiersDeclares(corps), ['src/a.ts', 'tests/a.test.ts']);
});

test('fichiersDeclares : « **Attend** : … » sous la liste n\'est pas une puce (.github#374, #375)', () => {
  assert.deepEqual(fichiersDeclares('**Fichiers touchés** :\n- `scripts/a.mjs`\n- `docs/b.md`\n**Attend** : aucune\n'), ['scripts/a.mjs', 'docs/b.md']);
  assert.equal(fichiersDeclares('**Fichiers touchés** :\n**Attend** : aucune\n'), null);
});

test('fichiersDeclares lit aussi « Fichiers touchés » et, sans backticks, le premier mot de la puce', () => {
  assert.deepEqual(fichiersDeclares('**Fichiers touchés** :\n- app/page.tsx pour la carte\n* lib/x.ts'), ['app/page.tsx', 'lib/x.ts']);
});

test('fichiersDeclares rend null sans section, avec « aucun », ou avec les seuls journaux', () => {
  assert.equal(fichiersDeclares('**Avant** : rien'), null);
  assert.equal(fichiersDeclares(''), null);
  assert.equal(fichiersDeclares(undefined), null);
  assert.equal(fichiersDeclares('**Fichiers touchés** :\n- aucun'), null);
  assert.equal(fichiersDeclares('**Fichiers permis** :\n- `CHANGELOG.md`\n- `docs/HANDOVER.md`'), null);
});

test('seRecouvrent : même fichier, dossier parent, motif ; pas deux fichiers voisins', () => {
  assert.equal(seRecouvrent('src/a.ts', 'src/a.ts'), true);
  assert.equal(seRecouvrent('src/a.ts', 'src/'), true);
  assert.equal(seRecouvrent('src/', 'src/lib/'), true);
  assert.equal(seRecouvrent('src/a.ts', 'src/*.ts'), true);
  assert.equal(seRecouvrent('./SRC/a.ts', 'src/a.ts'), true, 'casse et ./ ignorés');
  assert.equal(seRecouvrent('src/a.ts', 'src/b.ts'), false);
  assert.equal(seRecouvrent('src/a.ts', 'src2/'), false);
  assert.equal(seRecouvrent('src/a.ts', '*.ts'), true, 'motif sans dossier : tout recouvre, dans le doute');
});

test('conflitDeFichiers : fichiers inconnus ou vides ne bloquent RIEN ; disjoints = null ; commun = la raison', () => {
  assert.equal(conflitDeFichiers(null, ['a']), null);
  assert.equal(conflitDeFichiers(['a'], undefined), null);
  assert.equal(conflitDeFichiers([], ['a']), null);
  assert.equal(conflitDeFichiers(['HANDOVER.md'], ['HANDOVER.md']), null, 'que des journaux = inconnu');
  assert.equal(conflitDeFichiers(['x/a.ts', 'x/b.ts'], ['y/c.ts']), null);
  assert.equal(conflitDeFichiers(['x/a.ts', 'HANDOVER.md'], ['y/c.ts', 'HANDOVER.md']), null);
  assert.equal(conflitDeFichiers(['x/a.ts'], ['x/a.ts']), 'fichier-commun:x/a.ts');
  assert.equal(conflitDeFichiers(['x/a.ts'], ['x/']), 'fichier-commun:x/a.ts ~ x/');
});

test('raisonIncompatible (Jules) : dans le doute on bloque', () => {
  assert.equal(raisonIncompatible(null, ['a']), 'fichiers-inconnus');
  assert.equal(raisonIncompatible(['a'], ['b']), null);
  assert.equal(raisonIncompatible(['x/a.ts'], ['x/']), 'fichier-commun:x/a.ts ~ x/');
});

test('fetch.py lit les fichiers déclarés comme fichiers-communs.mjs (même grammaire, même préférence pour « permis »)', () => {
  const corps = [
    '**Fichiers touchés** :\n- `lib/a.ts`\n- `HANDOVER.md`\n',
    '<!-- fichiers-auto -->\n**Fichiers touchés** (estimation automatique) :\n- `lib/large.ts`\n\n**Fichiers permis** (aucun autre) :\n- `./lib/exact.ts` (nouveau)\n- `tests/exact.test.ts`\n',
    '**Fichiers permis** (aucun autre) :\n- `lib/exact.ts`\n\n**Fichiers touchés** :\n- `lib/large.ts`\n',
    '**Fichiers touchés** : non déterminés (aucun chemin).\n',
    '**Fichiers touchés** :\n- `CHANGELOG.md`\n',
    '**Fichiers touchés** :\n- `lib/a.ts`\n- `docs/INDEX.md`\n- `docs/adr/README.md`\n',
    '**Fichiers touchés** :\n- `docs/INDEX.md`\n- `docs/adr/README.md`\n',
    'rien de tel',
    '',
  ];
  const source = readFileSync(new URL('../outils/gantt-pc/fetch.py', import.meta.url), 'utf8');
  const debut = source.indexOf('FD = re.compile(');
  const fin = source.indexOf("# Étapes d'une tâche");
  assert.ok(debut > 0 && fin > debut, 'bloc fichiers_declares introuvable dans fetch.py');
  const programme = `import re, json, sys\n${source.slice(debut, fin)}\nprint(json.dumps([fichiers_declares(c) for c in json.load(sys.stdin)]))\n`;
  const r = spawnSync('python3', ['-I', '-c', programme], { input: JSON.stringify(corps), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), corps.map((c) => fichiersDeclares(c)));
});

test('fichiersDuTravail : déclarés ∪ réels, journaux ignorés, null si rien de connu', async () => {
  const { fichiersDuTravail } = await import('./fichiers-communs.mjs');
  assert.deepEqual(fichiersDuTravail(['a.ts'], ['a.ts', 'b.ts', 'HANDOVER.md']), ['a.ts', 'b.ts']);
  assert.deepEqual(fichiersDuTravail(null, ['b.ts']), ['b.ts']);
  assert.deepEqual(fichiersDuTravail(['a.ts'], null), ['a.ts']);
  assert.equal(fichiersDuTravail(null, null), null);
  assert.equal(fichiersDuTravail(undefined, []), null);
  assert.equal(fichiersDuTravail(null, ['CHANGELOG.md']), null);
  // les deux index que chaque tâche complète (demande de JobAI, 21/10/2026) ne rendent pas deux travaux incompatibles ; un autre docs/README.md ou un autre INDEX compte
  assert.deepEqual(fichiersDuTravail(['lib/a.ts', 'docs/INDEX.md', 'docs/adr/README.md'], null), ['lib/a.ts']);
  assert.equal(fichiersDuTravail(null, ['docs/INDEX.md', 'docs/adr/README.md']), null);
  assert.deepEqual(fichiersDuTravail(['docs/claude/INDEX.md', 'README.md', 'web/docs/INDEX.md'], null), ['docs/claude/INDEX.md', 'README.md', 'web/docs/INDEX.md']);
  assert.equal(conflitDeFichiers(['lib/a.ts', 'docs/INDEX.md', 'docs/adr/README.md'], ['lib/b.ts', 'docs/INDEX.md', 'docs/adr/README.md']), null);
});

// --- contrôle « Fichiers » du Garde-fou : une fausse API en mémoire ---
const f = (filename, extra = {}) => ({ filename, ...extra });
const fauxApi = ({ ouvertes = [], fichiers = {}, panne = null } = {}) => async (methode, chemin) => {
  if (panne) throw panne;
  assert.equal(methode, 'GET');
  if (/\/pulls\?state=open/.test(chemin)) return ouvertes;
  const m = /\/pulls\/(\d+)\/files/.exec(chemin);
  return m ? fichiers[m[1]] ?? null : null;
};
const moi = { number: 20, draft: false };
const humain = { login: 'MoKarade', type: 'User' };

test('controleFichiers : brouillon, dispense, tâche de Jules, journaux seuls = sans objet', async () => {
  const api = fauxApi();
  assert.match(rapportFichiers(await controleFichiers({ api, depot: 'MoKarade/d', pr: { ...moi, draft: true }, fichiers: [f('a.ts')], lien: {} })), /sans objet \(brouillon\)/);
  assert.equal((await controleFichiers({ api, depot: 'MoKarade/d', pr: moi, fichiers: [f('a.ts')], lien: { dispense: 'robot' } })).raison, 'robot');
  assert.equal((await controleFichiers({ api, depot: 'MoKarade/d', pr: moi, fichiers: [f('a.ts')], lien: { ouvertes: [{ jules: true }] } })).raison, 'tâche de Jules');
  assert.equal((await controleFichiers({ api, depot: 'MoKarade/d', pr: moi, fichiers: [f('HANDOVER.md')], lien: {} })).raison, 'aucun fichier hors journaux');
});

test('controleFichiers : rouge sur un fichier commun avec une PR ouverte plus ancienne, hors brouillon', async () => {
  const ouvertes = [{ number: 5, draft: false, user: humain }, { number: 6, draft: true, user: humain }, { number: 21, draft: false, user: humain }, { number: 3, draft: false, user: { login: 'dependabot[bot]', type: 'Bot' } }];
  const fichiers = { 5: [f('lib/a.ts'), f('HANDOVER.md')], 6: [f('lib/b.ts')], 21: [f('lib/b.ts')], 3: [f('lib/b.ts')] };
  const v = await controleFichiers({ api: fauxApi({ ouvertes, fichiers }), depot: 'MoKarade/d', pr: moi, fichiers: [f('lib/a.ts'), f('lib/b.ts')], lien: {} });
  assert.equal(v.ok, false);
  assert.deepEqual(v.conflits, [{ pr: 5, chemin: 'lib/a.ts' }]);
  assert.match(rapportFichiers(v), /\*\*rouge\*\*.*#5/);
  const sain = await controleFichiers({ api: fauxApi({ ouvertes, fichiers }), depot: 'MoKarade/d', pr: moi, fichiers: [f('lib/c.ts')], lien: {} });
  assert.equal(sain.ok, true);
  assert.match(rapportFichiers(sain), /Fichiers : vert/);
});

test('controleFichiers : un fichier renommé compte sous son ancien nom ; liste tronquée ou illisible = aucun blocage ; panne = avertissement, pas refus', async () => {
  const ouvertes = [{ number: 5, draft: false, user: humain }];
  const renomme = await controleFichiers({ api: fauxApi({ ouvertes, fichiers: { 5: [f('lib/ancien.ts')] } }), depot: 'MoKarade/d', pr: moi, fichiers: [f('lib/nouveau.ts', { previous_filename: 'lib/ancien.ts' })], lien: {} });
  assert.equal(renomme.ok, false);
  const tronquee = await controleFichiers({ api: fauxApi({ ouvertes, fichiers: { 5: Array.from({ length: 300 }, (_, i) => f(i === 0 ? 'lib/a.ts' : `x/${i}.ts`)) } }), depot: 'MoKarade/d', pr: moi, fichiers: [f('lib/a.ts')], lien: {} });
  assert.equal(tronquee.ok, true);
  const panne = await controleFichiers({ api: fauxApi({ panne: new Error('HTTP 502') }), depot: 'MoKarade/d', pr: moi, fichiers: [f('lib/a.ts')], lien: {} });
  assert.equal(panne.ok, true);
  assert.match(rapportFichiers(panne), /non contrôlés.*HTTP 502/);
});
