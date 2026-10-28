import test from 'node:test';
import assert from 'node:assert/strict';
import { avertissement, controleFiniQuand, lireClasse, lireLecturesPage, MARQUEUR_AVERTISSEMENT } from './fini-quand.mjs';

const corpsB = [
  '**Avant** : x',
  '**Fini quand** (classe B) : la page des totaux affiche les données de test.',
  '**Lecture de page** : GET /totaux → 200, contient « Total général »',
  '**Fichiers touchés** : `a.ts`',
].join('\n');

test('valide : une classe A, B ou C se lit sur la ligne « Fini quand »', () => {
  assert.deepEqual(lireClasse('**Fini quand** (classe A) : le test passe'), { classe: 'A', erreur: null });
  assert.deepEqual(lireClasse('**Fini quand** (classe b) : …'), { classe: 'B', erreur: null });
  assert.deepEqual(lireClasse('- **Fini quand** (preuve C) : …'), { classe: 'C', erreur: null });
});

test('rejeté : sans classe, classe inconnue, parenthèse étrangère, sans ligne', () => {
  assert.match(lireClasse('**Fini quand** : le test passe').erreur, /ne dit pas sa classe/);
  assert.match(lireClasse('**Fini quand** (classe D) : …').erreur, /inconnue « D »/);
  assert.match(lireClasse('**Fini quand** (voir plus bas) : …').erreur, /n’est pas « classe A\|B\|C »/);
  assert.match(lireClasse('rien').erreur, /aucune ligne/);
  assert.equal(lireClasse('**Fini quand** : x').classe, null);
});

test('« Fini quand exécutable » n’est pas la ligne « Fini quand »', () => {
  const r = lireClasse('**Fini quand exécutable** : GET https://a.hubperso.com/ → 200');
  assert.equal(r.classe, null);
  assert.match(r.erreur, /aucune ligne/);
});

test('valide : classe B avec une lecture de page', () => {
  const v = controleFiniQuand(corpsB);
  assert.equal(v.ok, true);
  assert.equal(v.classe, 'B');
  assert.deepEqual(v.lectures, [{ chemin: '/totaux', statut: 200, texte: 'Total général' }]);
  assert.equal(avertissement(corpsB), null);
});

test('rejeté : classe B sans lecture, ou lecture illisible, hôte, double barre, « .. »', () => {
  assert.match(controleFiniQuand('**Fini quand** (classe B) : x').motifs.join(), /aucune ligne « \*\*Lecture de page/);
  for (const ligne of ['GET https://evil.test/ → 200', 'GET //evil.test/x → 200', 'GET /a/../b → 200', 'POST /x → 200', 'GET /x']) {
    const v = controleFiniQuand(`**Fini quand** (classe B) : x\n**Lecture de page** : ${ligne}`);
    assert.equal(v.ok, false, ligne);
  }
});

test('valide : un chemin avec requête ou fragment (FinanceAI route par le hash)', () => {
  const v = lireLecturesPage('**Lecture de page** : GET /#DEBT → 200, contient « Dettes »\n**Lecture de page** : GET /liste?tri=nom → 200');
  assert.deepEqual(v.lectures, [{ chemin: '/#DEBT', statut: 200, texte: 'Dettes' }, { chemin: '/liste?tri=nom', statut: 200, texte: null }]);
  assert.deepEqual(v.erreurs, []);
});

test('rejeté : plus de cinq lectures', () => {
  const lignes = Array.from({ length: 6 }, (_, i) => `**Lecture de page** : GET /p${i} → 200`).join('\n');
  const v = lireLecturesPage(lignes);
  assert.equal(v.lectures.length, 5);
  assert.match(v.erreurs.join(), /plus de 5/);
});

test('classe C exige sa raison écrite', () => {
  assert.equal(controleFiniQuand('**Fini quand** (classe C) : x').ok, false);
  assert.equal(controleFiniQuand('**Fini quand** (classe C) : x\n**Raison de la classe C** : trop court').ok, false);
  assert.equal(controleFiniQuand('**Fini quand** (classe C) : x\n**Raison de la classe C** : la page exige la session Google de Marc dans Chrome').ok, true);
});

test('classe A : rien d’autre à écrire', () => {
  const v = controleFiniQuand('**Fini quand** (classe A) : `npm test` rend 0');
  assert.equal(v.ok, true);
  assert.deepEqual(v.lectures, []);
});

test('l’avertissement porte son marqueur et liste les motifs, sans rien bloquer', () => {
  const t = avertissement('**Fini quand** : le test passe');
  assert.ok(t.startsWith(MARQUEUR_AVERTISSEMENT));
  assert.match(t, /ne dit pas sa classe/);
  assert.match(t, /avertissement, rien n’est bloqué/);
});
