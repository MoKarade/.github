import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LABEL_DEROGATION, LIMITE_LIGNES, controleTaille, lignesModifiees, rapportTaille } from './taille-pr.mjs';

// Données fictives, aucun réseau.
const humain = { login: 'MoKarade', type: 'User' };
const fichier = (filename, additions, deletions = 0) => ({ filename, additions, deletions });
const pr = (extra = {}) => ({ user: humain, head: { ref: 'claude/x' }, draft: false, labels: [], ...extra });

test('lignesModifiees : additions + suppressions, hors tests, lockfiles, dist et captures', () => {
  const fichiers = [
    fichier('scripts/a.mjs', 100, 20),
    fichier('scripts/a.test.mjs', 500),
    fichier('web/tests/b.ts', 500),
    fichier('package-lock.json', 3000),
    fichier('dist/index.js', 900),
    fichier('docs/captures/x.png', 10),
    fichier('Cargo.lock', 70),
    fichier('src/c.spec.tsx', 80),
  ];
  assert.equal(lignesModifiees(fichiers), 120);
  assert.equal(lignesModifiees([]), 0);
  assert.equal(lignesModifiees(null), 0);
});

test('lignesModifiees : l’instantané et le journal de drizzle-kit ne comptent pas, le SQL oui', () => {
  const fichiers = [
    fichier('drizzle/0007_neuve.sql', 12),
    fichier('drizzle/meta/0007_snapshot.json', 251),
    fichier('drizzle/meta/_journal.json', 7),
    fichier('lib/schema.ts', 30),
  ];
  assert.equal(lignesModifiees(fichiers), 42);
  assert.equal(lignesModifiees([fichier('web/drizzle/meta/0001_snapshot.json', 900)]), 0);
  assert.equal(lignesModifiees([fichier('docs/drizzle/metadonnees.md', 5)]), 5);
});

test('controleTaille : 400 lignes acceptées, 401 refusées', () => {
  assert.equal(controleTaille({ pr: pr(), fichiers: [fichier('a.mjs', 399, 1)] }).ok, true);
  const trop = controleTaille({ pr: pr(), fichiers: [fichier('a.mjs', 400, 1)] });
  assert.equal(trop.ok, false);
  assert.equal(trop.lignes, 401);
  assert.equal(trop.limite, LIMITE_LIGNES);
});

test('controleTaille : un brouillon de 3000 lignes n’est jamais refusé', () => {
  const v = controleTaille({ pr: pr({ draft: true }), fichiers: [fichier('a.mjs', 3000)] });
  assert.equal(v.ok, true);
  assert.equal(v.raison, 'brouillon');
});

test('controleTaille : 3000 lignes avec l’étiquette de dérogation sont acceptées (étiquette en objet ou en texte)', () => {
  for (const l of [{ name: LABEL_DEROGATION }, LABEL_DEROGATION]) {
    const v = controleTaille({ pr: pr({ labels: [{ name: 'prio:1' }, l] }), fichiers: [fichier('a.mjs', 3000)] });
    assert.equal(v.ok, true);
    assert.match(v.raison, /dérogation/);
  }
});

test('controleTaille : tests, lockfiles et dist ne comptent pas', () => {
  const v = controleTaille({ pr: pr(), fichiers: [fichier('a.mjs', 10), fichier('a.test.mjs', 2000), fichier('package-lock.json', 5000), fichier('dist/x.js', 4000)] });
  assert.equal(v.ok, true);
  assert.equal(v.lignes, 10);
});

test('controleTaille : un robot dispensé (Dependabot, file de Mergify) n’est pas refusé', () => {
  const robot = { login: 'dependabot[bot]', type: 'Bot' };
  assert.equal(controleTaille({ pr: pr({ user: robot }), fichiers: [fichier('a.mjs', 3000)] }).ok, true);
});

test('rapportTaille : le refus donne le nombre de lignes, la règle et les deux sorties ; le vert reste court', () => {
  const rouge = rapportTaille(controleTaille({ pr: pr(), fichiers: [fichier('a.mjs', 1101)] }));
  assert.match(rouge, /\*\*rouge\*\*/);
  assert.match(rouge, /1101 lignes/);
  assert.match(rouge, /limite 400/);
  assert.match(rouge, /découper/);
  assert.match(rouge, new RegExp(LABEL_DEROGATION));
  assert.match(rapportTaille(controleTaille({ pr: pr(), fichiers: [fichier('a.mjs', 12)] })), /^Taille : vert \(12 /);
  assert.match(rapportTaille(controleTaille({ pr: pr({ draft: true }), fichiers: [fichier('a.mjs', 12)] })), /sans objet \(brouillon\)/);
});
