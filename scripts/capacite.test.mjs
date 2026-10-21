import { test } from 'node:test';
import assert from 'node:assert/strict';
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
