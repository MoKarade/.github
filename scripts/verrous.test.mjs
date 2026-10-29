import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controleMigrations, controleSecrets, controleTests, parserDiff, rapport, verifier } from './verrous.mjs';

// Aucune valeur réelle ici : tout motif sensible est assemblé par concaténation (et ne se lit pas tel quel dans ce fichier).
const SAUTE = (mot) => `  ${'it'}.${mot}('cas', () => {});`;
const FAUX_GITHUB = `const t = '${'gh' + 'p_'}${'a'.repeat(36)}';`;
const FAUX_AWS = `cle = ${'AK' + 'IA'}${'B'.repeat(16)}`;
const FAUX_CLE_PRIVEE = `${'-----BEGIN '}${'RSA PRIVATE'} KEY-----`;
const FAUX_URL = `url = '${'post' + 'gres'}://admin:${'Zq8' + 'rT5vLp'}@db.exemple.test/base'`;

const ajout = (filename, lignes, status = 'modified') => ({
  filename,
  status,
  patch: `@@ -1,0 +1,${lignes.length} @@\n${lignes.map((l) => `+${l}`).join('\n')}`,
});
const retrait = (filename, lignes) => ({
  filename,
  status: 'modified',
  patch: `@@ -1,${lignes.length} +1,0 @@\n${lignes.map((l) => `-${l}`).join('\n')}`,
});

// ── 1. Tests ────────────────────────────────────────────────────────────────────

test('tests : un cas ajouté sans rien retirer est accepté (raisons vides)', () => {
  assert.deepEqual(controleTests([ajout('scripts/a.test.mjs', ["test('ok', () => {});"])]), []);
});

test('tests : un fichier de test supprimé est rejeté, avec sa raison exacte', () => {
  assert.deepEqual(controleTests([{ filename: 'scripts/a.test.mjs', status: 'removed' }]), [
    { controle: 'tests', fichier: 'scripts/a.test.mjs', detail: 'fichier de test supprimé' },
  ]);
});

test('tests : skip, only, todo, xit et xdescribe ajoutés sont rejetés', () => {
  for (const mot of ['skip', 'only', 'todo']) {
    const raisons = controleTests([ajout('a.test.js', [SAUTE(mot), "it('b', () => {});"])]);
    assert.equal(raisons.length, 1, mot);
    assert.match(raisons[0].detail, /^test sauté ou isolé : /);
  }
  assert.equal(controleTests([ajout('a.spec.ts', [`${'x' + 'it'}('b', () => {});`, "it('c', () => {});"])]).length, 1);
  assert.equal(controleTests([ajout('a.spec.ts', [`${'x' + 'describe'}('b', () => {});`])]).length, 1);
});

test('tests : moins de cas qu\'avant est rejeté, autant de cas est accepté', () => {
  const baisse = controleTests([retrait('a.test.mjs', ["test('a', () => {});", "test('b', () => {});"])]);
  assert.deepEqual(baisse, [
    { controle: 'tests', fichier: '(PR)', detail: "moins de cas de test qu'avant : 2 retirés, 0 ajoutés" },
  ]);
  const remplace = [
    retrait('a.test.mjs', ["test('a', () => {});"]),
    ajout('b.test.mjs', ["test('a2', () => {});"]),
  ];
  assert.deepEqual(controleTests(remplace), []);
});

test('tests : un test renommé hors des dossiers de tests est rejeté', () => {
  const raisons = controleTests([{ filename: 'src/a.mjs', status: 'renamed', previous_filename: 'scripts/a.test.mjs' }]);
  assert.equal(raisons.length, 1);
  assert.match(raisons[0].detail, /renommé hors des tests \(était scripts\/a\.test\.mjs\)/);
});

test('tests : un skip dans un fichier qui n\'est pas un test est ignoré', () => {
  assert.deepEqual(controleTests([ajout('docs/guide.md', [SAUTE('skip')])]), []);
});

// ── 2. Secrets ──────────────────────────────────────────────────────────────────

test('secrets : une ligne sans secret est acceptée', () => {
  assert.deepEqual(controleSecrets([ajout('src/a.mjs', ['const jeton = process.env.JETON ?? null;'])]), []);
});

test('secrets : jeton GitHub, clé AWS, clé privée et URL avec mot de passe sont rejetés', () => {
  for (const ligne of [FAUX_GITHUB, FAUX_AWS, FAUX_CLE_PRIVEE, FAUX_URL]) {
    const raisons = controleSecrets([ajout('src/a.mjs', [ligne])]);
    assert.deepEqual(raisons, [
      { controle: 'secrets', fichier: 'src/a.mjs', detail: 'valeur qui ressemble à un secret en clair (ligne ajoutée)' },
    ]);
  }
});

test('secrets : la valeur n\'est jamais recopiée dans la raison', () => {
  const [raison] = controleSecrets([ajout('src/a.mjs', [FAUX_GITHUB])]);
  assert.ok(!raison.detail.includes('a'.repeat(36)));
});

test('secrets : un secret seulement RETIRÉ ou une URL à variable ne déclenche rien', () => {
  assert.deepEqual(controleSecrets([retrait('src/a.mjs', [FAUX_GITHUB])]), []);
  assert.deepEqual(controleSecrets([ajout('src/a.mjs', ['url = "postgres://user:${MOT}@hote/base"'])]), []);
});

test('secrets : un .env réel ajouté est rejeté, un .env.example est accepté', () => {
  assert.deepEqual(controleSecrets([ajout('.env.local', ['A=1'], 'added')]), [
    { controle: 'secrets', fichier: '.env.local', detail: 'fichier .env versionné ajouté ou modifié' },
  ]);
  assert.deepEqual(controleSecrets([ajout('.env.example', ['A=1'], 'added')]), []);
});

// ── 3. Migrations ───────────────────────────────────────────────────────────────

test('migrations : un CREATE TABLE ajouté est accepté', () => {
  const f = ajout('drizzle/0005_a.sql', ['CREATE TABLE "a" (id serial PRIMARY KEY);', 'ALTER TABLE "a" ADD COLUMN "b" text;'], 'added');
  assert.deepEqual(controleMigrations([f]), []);
});

test('migrations : DROP TABLE, DROP COLUMN, TRUNCATE et ALTER ... DROP sont rejetés', () => {
  const cas = {
    'DROP': 'DROP TABLE "a";',
    'ALTER ... DROP': 'ALTER TABLE "a" DROP CONSTRAINT "a_pk";',
    'TRUNCATE': 'TRUNCATE TABLE "a";',
  };
  for (const [nom, sql] of Object.entries(cas)) {
    const raisons = controleMigrations([ajout('drizzle/0006_b.sql', [sql], 'added')]);
    assert.equal(raisons.length, 1, nom);
    assert.equal(raisons[0].controle, 'migrations');
    assert.ok(raisons[0].detail.startsWith(`migration destructive (${nom}) : `), raisons[0].detail);
  }
  const colonne = controleMigrations([ajout('db/changer.sql', ['ALTER TABLE "a" DROP COLUMN "b";'], 'added')]);
  assert.match(colonne[0].detail, /^migration destructive \(ALTER \.\.\. DROP\) : /);
});

test('migrations : DELETE FROM sans WHERE rejeté, avec WHERE (même sur la ligne suivante) accepté', () => {
  const sans = controleMigrations([ajout('drizzle/0007_c.sql', ['DELETE FROM "a";'], 'added')]);
  assert.deepEqual(sans, [
    {
      controle: 'migrations',
      fichier: 'drizzle/0007_c.sql',
      detail: 'migration destructive (DELETE FROM sans WHERE) : DELETE FROM "a"',
    },
  ]);
  assert.deepEqual(controleMigrations([ajout('drizzle/0007_c.sql', ['DELETE FROM "a"', 'WHERE id = 3;'], 'added')]), []);
});

test('migrations : les commentaires SQL et les marqueurs drizzle ne déclenchent rien', () => {
  const f = ajout('drizzle/0008_d.sql', ['-- DROP TABLE "a";', '--> statement-breakpoint', '/* TRUNCATE a; */', 'CREATE INDEX i ON a (b);'], 'added');
  assert.deepEqual(controleMigrations([f]), []);
});

test('migrations : une migration existante modifiée ou supprimée est rejetée', () => {
  const raisons = controleMigrations([
    ajout('drizzle/0001_x.sql', ['CREATE INDEX j ON a (c);']),
    { filename: 'drizzle/0002_y.sql', status: 'removed' },
  ]);
  assert.equal(raisons.length, 2);
  assert.ok(raisons.every((r) => /migration existante modifiée ou supprimée/.test(r.detail)));
});

// ── Verdict complet, lecture du diff, rapport ───────────────────────────────────

const DIFF_PROPRE = `diff --git a/scripts/a.test.mjs b/scripts/a.test.mjs
index 111..222 100644
--- a/scripts/a.test.mjs
+++ b/scripts/a.test.mjs
@@ -1,0 +2,1 @@
+test('nouveau', () => {});
diff --git a/README.md b/README.md
index 333..444 100644
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-ancien
+nouveau
`;

const DIFF_ROUGE = `diff --git a/scripts/vieux.test.mjs b/scripts/vieux.test.mjs
deleted file mode 100644
index 111..000
--- a/scripts/vieux.test.mjs
+++ /dev/null
@@ -1,2 +0,0 @@
-test('un', () => {});
-test('deux', () => {});
diff --git a/src/cle.mjs b/src/cle.mjs
new file mode 100644
index 000..222
--- /dev/null
+++ b/src/cle.mjs
@@ -0,0 +1 @@
+${FAUX_GITHUB}
diff --git a/drizzle/0009_z.sql b/drizzle/0009_z.sql
new file mode 100644
index 000..333
--- /dev/null
+++ b/drizzle/0009_z.sql
@@ -0,0 +1 @@
+DROP TABLE "a";
diff --git a/ancien.mjs b/nouveau.mjs
similarity index 90%
rename from ancien.mjs
rename to nouveau.mjs
index 444..555 100644
--- a/ancien.mjs
+++ b/nouveau.mjs
@@ -1 +1 @@
-a
+b
`;

test('parserDiff : lit statuts, renommage, noms et patch', () => {
  const fichiers = parserDiff(DIFF_ROUGE);
  assert.deepEqual(
    fichiers.map((f) => [f.filename, f.status, f.previous_filename]),
    [
      ['scripts/vieux.test.mjs', 'removed', undefined],
      ['src/cle.mjs', 'added', undefined],
      ['drizzle/0009_z.sql', 'added', undefined],
      ['nouveau.mjs', 'renamed', 'ancien.mjs'],
    ],
  );
  assert.ok(fichiers[2].patch.includes('+DROP TABLE "a";'));
  assert.deepEqual(parserDiff(''), []);
});

test('verifier : un diff propre rend exactement vert, sans raison', () => {
  assert.deepEqual(verifier(parserDiff(DIFF_PROPRE)), { verdict: 'vert', raisons: [] });
});

test('verifier : un diff avec test retiré, secret et DROP rend rouge avec les trois raisons dans l\'ordre', () => {
  const { verdict, raisons } = verifier(parserDiff(DIFF_ROUGE));
  assert.equal(verdict, 'rouge');
  assert.deepEqual(
    raisons.map((r) => [r.controle, r.fichier]),
    [
      ['tests', 'scripts/vieux.test.mjs'],
      ['tests', '(PR)'],
      ['secrets', 'src/cle.mjs'],
      ['migrations', 'drizzle/0009_z.sql'],
    ],
  );
  assert.equal(raisons[0].detail, 'fichier de test supprimé');
  assert.equal(raisons[1].detail, "moins de cas de test qu'avant : 2 retirés, 0 ajoutés");
});

test('rapport : dit vert, ou liste chaque raison', () => {
  assert.match(rapport({ verdict: 'vert', raisons: [] }), /^Verrous : vert\./);
  const texte = rapport(verifier(parserDiff(DIFF_ROUGE)));
  assert.match(texte, /^Verrous : ROUGE \(4 raisons\)\./);
  assert.match(texte, /- \[migrations\] drizzle\/0009_z\.sql : migration destructive \(DROP\)/);
});
