// Tests du garde-fou : aucune dépendance, aucun réseau (`node --test scripts/`).
// Chaque règle a un cas qui doit passer ET un cas qui doit être refusé : un test qui ne
// vérifie que « ça ne lève pas » ne prouve rien.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareSeuils, evaluer, lignesDuPatch, rapport } from './garde-fou.mjs';

const PROTEGES = /^(\.github\/|scripts\/hooks\/|qualite\/|vercel\.json|drizzle\/|\.env|\.mergify\.yml)/;

const patch = (...lignes) => `@@ -1,3 +1,3 @@\n${lignes.join('\n')}`;
const fichier = (filename, extra = {}) => ({
  filename,
  status: 'modified',
  additions: 1,
  deletions: 1,
  patch: patch(' contexte'),
  ...extra,
});
const sansLecture = async () => null;

async function regles(fichiers, contenu = sansLecture) {
  const r = await evaluer({ fichiers, proteges: PROTEGES, contenu });
  return { ...r, regles: [...new Set(r.violations.map((v) => v.regle))].sort() };
}

test('rien de protégé : rien à contrôler, même si un test disparaît', async () => {
  const r = await regles([fichier('tests/a.test.ts', { status: 'removed', patch: undefined })]);
  assert.equal(r.protege, false);
  assert.deepEqual(r.violations, []);
});

test('chemin protégé sans rien de suspect : vert', async () => {
  const r = await regles([
    fichier('vercel.json', { patch: patch('-"a": 1', '+"a": 2') }),
    fichier('lib/x.ts', { patch: patch('+export const x = 1;') }),
  ]);
  assert.equal(r.protege, true);
  assert.deepEqual(r.violations, []);
});

test('dépendabot : un bump de version d’action ne déclenche aucune règle', async () => {
  const r = await regles([
    fichier('.github/workflows/ci.yml', {
      patch: patch(
        '-      - uses: actions/checkout@aaaaaaaa # v6',
        '+      - uses: actions/checkout@bbbbbbbb # v7',
      ),
    }),
  ]);
  assert.deepEqual(r.violations, []);
});

// ── 1. Tests ──────────────────────────────────────────────────────────────────
test('test : fichier de test supprimé', async () => {
  const r = await regles([
    fichier('vercel.json'),
    fichier('tests/a.test.ts', { status: 'removed', patch: undefined, additions: 0, deletions: 0 }),
  ]);
  assert.deepEqual(r.regles, ['test']);
});

test('test : fichier de test renommé hors des tests', async () => {
  const r = await regles([
    fichier('vercel.json'),
    fichier('lib/a.ts', { status: 'renamed', previous_filename: 'tests/a.test.ts', patch: undefined, additions: 0, deletions: 0 }),
  ]);
  assert.deepEqual(r.regles, ['test']);
});

test('test : it.skip, describe.only, xit sont refusés', async () => {
  for (const ligne of ["it.skip('a', () => {})", "describe.only('a', () => {})", "xit('a', () => {})", "test('a', { skip: true }, () => {})"]) {
    const r = await regles([fichier('vercel.json'), fichier('tests/a.test.ts', { patch: patch(`+${ligne}`) })]);
    assert.deepEqual(r.regles, ['test'], ligne);
  }
});

test('test : un test ajouté ou déplacé passe, moins de cas qu’avant non', async () => {
  const deplace = await regles([
    fichier('vercel.json'),
    fichier('tests/a.test.ts', { patch: patch("-  it('a', () => {})") }),
    fichier('tests/b.test.ts', { patch: patch("+  it('a', () => {})") }),
  ]);
  assert.deepEqual(deplace.violations, []);
  const perdu = await regles([
    fichier('vercel.json'),
    fichier('tests/a.test.ts', { patch: patch("-  it('a', () => {})", "-  test('b', () => {})", "+  it('c', () => {})") }),
  ]);
  assert.deepEqual(perdu.regles, ['test']);
});

test('test : étape de test retirée de la CI, continue-on-error, || true', async () => {
  const retiree = await regles([
    fichier('.github/workflows/ci.yml', { patch: patch('-        run: npm run test') }),
  ]);
  assert.ok(retiree.regles.includes('test'));
  const remplacee = await regles([
    fichier('.github/workflows/ci.yml', { patch: patch('-        run: npm run test', '+        run: npm run test -- --coverage') }),
  ]);
  assert.deepEqual(remplacee.violations, []);
  for (const ligne of ['    continue-on-error: true', '        run: npm test || true', '    if: false', '        run: npx vitest --passWithNoTests']) {
    const r = await regles([fichier('.github/workflows/ci.yml', { patch: patch(`+${ligne}`) })]);
    assert.ok(r.regles.includes('test'), ligne);
  }
});

test('test : script « test » du package.json vidé', async () => {
  const lire = async (ref) =>
    JSON.stringify({ scripts: { test: ref === 'base' ? 'vitest run' : 'echo "ok"' } });
  const r = await regles([fichier('vercel.json'), fichier('package.json')], lire);
  assert.deepEqual(r.regles, ['test']);
  const bon = async () => JSON.stringify({ scripts: { test: 'vitest run' } });
  assert.deepEqual((await regles([fichier('vercel.json'), fichier('package.json')], bon)).violations, []);
});

// ── 2. Seuils ─────────────────────────────────────────────────────────────────
const seuils = (portes, config = { app: 'X' }) => JSON.stringify({ config, portes });

test('seuil : resserrer ou ajouter une porte passe, desserrer non', async () => {
  const base = seuils({ 'couverture.lignes': { min: 80 }, 'code_mort.problemes': { max: 10 } });
  const lire = (tete) => async (ref) => (ref === 'base' ? base : tete);
  const mieux = seuils({ 'couverture.lignes': { min: 82 }, 'code_mort.problemes': { max: 8 }, 'nouvelle.porte': { max: 0 } });
  assert.deepEqual((await regles([fichier('qualite/seuils.json')], lire(mieux))).violations, []);
  const pire = seuils({ 'couverture.lignes': { min: 79 }, 'code_mort.problemes': { max: 10 } });
  assert.deepEqual((await regles([fichier('qualite/seuils.json')], lire(pire))).regles, ['seuil']);
  const pire2 = seuils({ 'couverture.lignes': { min: 80 }, 'code_mort.problemes': { max: 11 } });
  assert.deepEqual((await regles([fichier('qualite/seuils.json')], lire(pire2))).regles, ['seuil']);
});

test('seuil : porte supprimée, config modifiée, JSON cassé', async () => {
  assert.deepEqual(compareSeuils({ portes: { a: { max: 1 } } }, { portes: {} }), ['porte « a » supprimée']);
  assert.equal(compareSeuils({ config: { lint: 'eslint .' }, portes: {} }, { config: { lint: 'true' }, portes: {} }).length, 1);
  const casse = async (ref) => (ref === 'base' ? seuils({}) : '{pas du json');
  assert.deepEqual((await regles([fichier('qualite/seuils.json')], casse)).regles, ['seuil']);
});

test('seuil : toucher au mécanisme (portes.mjs) ou supprimer qualite/ est refusé', async () => {
  assert.deepEqual((await regles([fichier('qualite/portes.mjs')])).regles, ['seuil']);
  assert.deepEqual((await regles([fichier('app/qualite/portes.mjs'), fichier('vercel.json')])).regles, ['seuil']);
  assert.deepEqual(
    (await regles([fichier('qualite/seuils.json', { status: 'removed', patch: undefined, additions: 0, deletions: 0 })])).regles,
    ['seuil'],
  );
});

// ── 3. Secrets ────────────────────────────────────────────────────────────────
test('secret : référence à un secret de la CI (ajoutée, retirée ou modifiée)', async () => {
  for (const ligne of ['+  TOKEN: ${{ secrets.MON_JETON }}', '-  TOKEN: ${{ secrets.MON_JETON }}', '+    secrets: inherit']) {
    const r = await regles([fichier('.github/workflows/ci.yml', { patch: patch(ligne) })]);
    assert.deepEqual(r.regles, ['secret'], ligne);
  }
  const ok = await regles([fichier('.github/workflows/ci.yml', { patch: patch('+  TOKEN: ${{ github.token }}') })]);
  assert.deepEqual(ok.violations, []);
});

test('secret : .env.example, .env versionné, valeur en clair, nouvelle variable de code', async () => {
  const nonSecret = await regles([fichier('.env.example', { patch: patch('+NEXT_PUBLIC_URL=https://exemple.test') })]);
  assert.deepEqual(nonSecret.violations, []);
  const secret = await regles([fichier('.env.example', { patch: patch('+NEW_API_TOKEN=') })]);
  assert.deepEqual(secret.regles, ['secret']);
  const reel = await regles([fichier('.env.production', { patch: patch('+A=1') })]);
  assert.deepEqual(reel.regles, ['secret']);
  const clair = await regles([fichier('vercel.json'), fichier('lib/x.ts', { patch: patch('+const k = "AKIAABCDEFGHIJKLMNOP";') })]);
  assert.deepEqual(clair.regles, ['secret']);
  // Tâche #199 : lire une variable d'environnement dans le code d'une app n'est plus un secret (Sentry : SENTRY_DSN)
  const app = await regles([
    fichier('vercel.json'),
    fichier('instrumentation.ts', { patch: patch('+  Sentry.init(optionsSentry(process.env.SENTRY_DSN));') }),
    fichier('next.config.mjs', { patch: patch('+    NEXT_PUBLIC_SENTRY_DSN: process.env.SENTRY_DSN,') }),
    fichier('lib/x.ts', { patch: patch('+const k = process.env.STRIPE_SECRET_KEY;') }),
  ]);
  assert.deepEqual(app.violations, []);
  // … mais une valeur en clair dans ce même code reste refusée
  const encore = await regles([
    fichier('vercel.json'),
    fichier('instrumentation.ts', { patch: patch('+  Sentry.init(optionsSentry(process.env.SENTRY_DSN));') }),
    fichier('lib/x.ts', { patch: patch('+const k = "' + ['AK', 'IA', 'ABCDEFGHIJKLMNOP'].join('') + '";') }),
  ]);
  assert.deepEqual(encore.regles, ['secret']);
});

test('secret : dans un chemin protégé, une variable secrète sans repli est refusée, avec repli elle passe', async () => {
  const sans = await regles([fichier('.github/scripts/x.mjs', { patch: patch('+const jeton = process.env.REVEIL_TOKEN;') })]);
  assert.deepEqual(sans.regles, ['secret']);
  const dsn = await regles([fichier('scripts/hooks/envoi.mjs', { patch: patch('+envoyer(process.env.SENTRY_DSN);') })]);
  assert.deepEqual(dsn.regles, ['secret']);
  for (const ligne of [
    '+const jeton = process.env.REVEIL_TOKEN ?? "";',
    '+const jeton = process.env.REVEIL_TOKEN || null;',
    '+if (!process.env.REVEIL_TOKEN) return;',
    '+const actif = Boolean(process.env.REVEIL_TOKEN);',
    '+const actif = typeof process.env.REVEIL_TOKEN === "string";',
    '+const a = process.env.REVEIL_TOKEN ? 1 : 0;',
    '+const jeton = process.env["REVEIL_TOKEN"] ?? "";',
    "+const jeton = Deno.env.get('REVEIL_TOKEN') ?? '';",
    '+const jeton = (process.env.REVEIL_TOKEN) || null;',
  ]) {
    const ok = await regles([fichier('.github/scripts/x.mjs', { patch: patch(ligne) })]);
    assert.deepEqual(ok.violations, [], ligne);
  }
  // l'accès par crochets ou par Deno sans repli reste refusé (le reste de la lecture ne vaut pas repli)
  for (const ligne of ['+const jeton = process.env["REVEIL_TOKEN"];', "+const jeton = Deno.env.get('REVEIL_TOKEN');", '+const jeton = (process.env.REVEIL_TOKEN);']) {
    const ko = await regles([fichier('.github/scripts/x.mjs', { patch: patch(ligne) })]);
    assert.deepEqual(ko.regles, ['secret'], ligne);
  }
  // `secrets.X` d'un workflow ne change pas
  const ci = await regles([fichier('.github/workflows/ci.yml', { patch: patch('+  TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}') })]);
  assert.deepEqual(ci.regles, ['secret']);
});

test('secret : le réglage du scan de secrets ne se desserre pas seul', async () => {
  assert.deepEqual((await regles([fichier('.gitleaksignore'), fichier('vercel.json')])).regles, ['secret']);
});

// ── 4. Migrations ─────────────────────────────────────────────────────────────
test('migration : ajouter une table passe, détruire non', async () => {
  const neuve = await regles([fichier('drizzle/0007_x.sql', { status: 'added', patch: patch('+CREATE TABLE "x" ("id" serial);', '+--> statement-breakpoint', '+ALTER TABLE "y" ADD COLUMN "z" text;') })]);
  assert.deepEqual(neuve.violations, []);
  for (const ligne of ['DROP TABLE "x";', 'ALTER TABLE "x" DROP COLUMN "y";', 'TRUNCATE "x";', 'DELETE FROM "x";', 'ALTER TABLE "x" RENAME COLUMN "a" TO "b";', 'ALTER TABLE "x" ALTER COLUMN "a" SET DATA TYPE integer;', 'UPDATE "x" SET "a" = 1;']) {
    const r = await regles([fichier('drizzle/0008_x.sql', { status: 'added', patch: patch(`+${ligne}`) })]);
    assert.deepEqual(r.regles, ['migration'], ligne);
  }
  const commentaire = await regles([fichier('drizzle/0009_x.sql', { status: 'added', patch: patch('+-- DROP TABLE ancienne (rappel)') })]);
  assert.deepEqual(commentaire.violations, []);
});

test('migration : réécrire ou supprimer une migration existante est refusé', async () => {
  assert.deepEqual((await regles([fichier('drizzle/0001_a.sql', { patch: patch('+SELECT 1;') })])).regles, ['migration']);
  assert.deepEqual((await regles([fichier('drizzle/0001_a.sql', { status: 'removed', patch: undefined, additions: 0, deletions: 0 })])).regles, ['migration']);
  assert.deepEqual((await regles([fichier('drizzle/meta/_journal.json', { patch: patch('+{}') })])).violations, []);
});

// ── 5. Le garde-fou lui-même ──────────────────────────────────────────────────
test('garde-fou : .mergify.yml, CODEOWNERS, workflow et script ne se modifient pas seuls', async () => {
  for (const nom of ['.mergify.yml', '.github/CODEOWNERS', '.github/workflows/garde-fou.yml', 'scripts/garde-fou.mjs']) {
    const r = await evaluer({ fichiers: [fichier(nom)], proteges: /^zzz/, contenu: sansLecture });
    assert.equal(r.protege, true, nom);
    assert.ok(r.violations.some((v) => v.regle === 'garde-fou'), nom);
  }
});

test('illisible : un diff trop gros sur un fichier surveillé est refusé', async () => {
  const r = await regles([fichier('vercel.json', { patch: undefined, additions: 4000, deletions: 0 })]);
  assert.deepEqual(r.regles, ['illisible']);
  const lock = await regles([fichier('vercel.json'), fichier('package-lock.json', { patch: undefined, additions: 9000, deletions: 100 })]);
  assert.deepEqual(lock.violations, []);
});

test('rapport et lignes du patch', () => {
  assert.deepEqual(lignesDuPatch('@@ -1 +1 @@\n-a\n+b\n c'), { ajoutees: ['b'], retirees: ['a'] });
  assert.match(rapport({ concernes: ['a'], violations: [] }), /vert/);
  const rouge = rapport({ concernes: ['a'], violations: [{ regle: 'secret', fichier: 'f', detail: 'd' }] });
  assert.match(rouge, /rouge/);
  assert.match(rouge, /Référence à un secret/);
});
