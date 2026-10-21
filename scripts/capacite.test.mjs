import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { PLACES_PAR_DEPOT, fichiersDeclares, seRecouvrent, compatibles, raisonIncompatible } from './capacite.mjs';

test('deux places par dépôt', () => assert.equal(PLACES_PAR_DEPOT, 2));

test('fichiersDeclares lit « Fichiers permis » : chemins entre backticks, hors journaux', () => {
  const corps = [
    '**Avant** : x', '',
    '**Fichiers permis** (aucun autre) :', '- `src/a.ts` (le code)', '- `tests/a.test.ts`', '- `HANDOVER.md`', '',
    '**À faire** :', '1. `autre/chose.ts` ne compte pas',
  ].join('\n');
  assert.deepEqual(fichiersDeclares(corps), ['src/a.ts', 'tests/a.test.ts']);
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

test('compatibles : fichiers inconnus ou vides = jamais ; disjoints = oui ; commun = non, avec la raison', () => {
  assert.equal(compatibles(null, ['a']), false);
  assert.equal(compatibles(['a'], undefined), false);
  assert.equal(compatibles([], ['a']), false);
  assert.equal(compatibles(['HANDOVER.md'], ['a']), false, 'que des journaux = inconnu');
  assert.equal(compatibles(['x/a.ts', 'x/b.ts'], ['y/c.ts']), true);
  assert.equal(compatibles(['x/a.ts', 'HANDOVER.md'], ['y/c.ts', 'HANDOVER.md']), true);
  assert.equal(compatibles(['x/a.ts'], ['x/']), false);
  assert.equal(raisonIncompatible(['x/a.ts'], ['x/a.ts']), 'fichier-commun:x/a.ts');
  assert.equal(raisonIncompatible(['x/a.ts'], ['x/']), 'fichier-commun:x/a.ts ~ x/');
  assert.equal(raisonIncompatible(null, ['a']), 'fichiers-inconnus');
  assert.equal(raisonIncompatible(['a'], ['b']), null);
});

test('fetch.py lit les fichiers déclarés comme capacite.mjs (même grammaire, même préférence pour « permis »)', () => {
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
  const { fichiersDuTravail } = await import('./capacite.mjs');
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
  assert.equal(compatibles(['lib/a.ts', 'docs/INDEX.md', 'docs/adr/README.md'], ['lib/b.ts', 'docs/INDEX.md', 'docs/adr/README.md']), true);
});
