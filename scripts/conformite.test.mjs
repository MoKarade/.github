// Tests de la grille de conformité : une photo de dépôt entièrement conforme, puis une cassure par ligne.
// Aucune dépendance, aucun réseau (`node --test scripts/conformite.test.mjs`). Chaque ligne a un cas vert ET un cas rouge.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PRIVES_VOULUS, cronQuotidien, evaluer, jobsDe, scriptsAppeles, sombreSeulDeclare, tableau } from './conformite.mjs';

const SHA = 'a'.repeat(40);
const CI = `name: CI
on:
  pull_request:
  push:
    branches: [main]
jobs:
  gate:
    timeout-minutes: 15
    runs-on: \${{ github.event.repository.visibility == 'public' && 'ubuntu-latest' || 'x' }}
    steps:
      - uses: actions/checkout@${SHA} # v7
      - run: npm run typecheck && npm run lint && npm test && npm run build
      - run: npm audit --omit=dev
  securite:
    uses: MoKarade/.github/.github/workflows/securite.yml@main
  fumee:
    uses: MoKarade/.github/.github/workflows/fumee.yml@main
  surveillance:
    uses: MoKarade/.github/.github/workflows/surveillance.yml@main
`;

/** Un dépôt d'app entièrement conforme ; `casse` remplace des fichiers, `en_moins` en retire. */
function depot({ fichiers: extra = {}, retirer = [], api = {} } = {}) {
  const contenu = {
    '.github/workflows/ci.yml': CI,
    '.github/dependabot.yml': 'version: 2\n',
    'package.json': JSON.stringify({
      scripts: { typecheck: 'tsc', lint: 'eslint .', test: 'vitest run', build: 'next build', 'vercel-build': 'npm run db:migrate && next build' },
      dependencies: { next: '^16.3.5', react: '^19.3.0', zod: '^4.6.7', '@sentry/nextjs': '^10.0.0', 'drizzle-orm': '^0.45.2', '@mokarade/hub-contract': 'github:MoKarade/hub-contract#v1.4.0' },
      devDependencies: { typescript: '^5.9.0', vitest: '^5.0.1' },
    }),
    'package-lock.json': JSON.stringify({ packages: { 'node_modules/next': { version: '16.3.5' }, 'node_modules/typescript': { version: '5.9.3' } } }),
    'tsconfig.json': '{ // commentaire\n "compilerOptions": { "strict": true, }\n}',
    '.nvmrc': '24\n',
    'vercel.json': JSON.stringify({ git: { deploymentEnabled: { '**': false, '*': false, main: true } } }),
    'qualite/seuils.json': JSON.stringify({ portes: { 'couverture.lignes_coeur': { min: 80 } } }),
    'CLAUDE.md': 'a\n'.repeat(40),
    'HANDOVER.md': 'x',
    'docs/adr/0001-x.md': 'x',
    'BACKLOG.md': '# Backlog\nLe backlog vit dans les issues GitHub.\n',
    'docs/COMPTE-RENDU.md': 'x',
    'app/globals.css': ':root { --fond: #fff; }\n@media (prefers-color-scheme: dark) { :root { --fond: #000; } }',
    'tests/theme.test.ts': 'x',
    'app/api/sante/route.ts': 'x',
    'lib/migrations.ts': 'x',
    ...extra,
  };
  for (const r of retirer) delete contenu[r];
  return {
    fichiers: Object.keys(contenu),
    lire: (c) => contenu[c] ?? null,
    depot: { nom: 'MoKarade/x', prive: false, branche: 'main', securite: { secret_scanning: { status: 'enabled' }, secret_scanning_push_protection: { status: 'enabled' } } },
    protection: { protegee: true, verifs: ['Gate'] },
    tagContrat: 'v1.4.0',
    commits: [{ message: 'feat: x (#1)', parents: 1 }, { message: 'Merge pull request #2 from a/b', parents: 2 }, { message: '[V1-03] corriger', parents: 1 }],
    titrePr: 'fix: y',
    surveilles: ['MoKarade/x'],
    ...api,
  };
}
const etats = (ctx) => Object.fromEntries(evaluer(ctx).map((r) => [r.n, r.etat]));
const detail = (ctx, n) => evaluer(ctx).find((r) => r.n === n).details.map((d) => d.texte).join(' | ');

test('dépôt entièrement conforme : 14 lignes vertes, la sauvegarde (10) reste « à relire » car elle vit sur le PC', () => {
  const e = etats(depot());
  assert.equal(e[10], 'non-verifiable');
  assert.deepEqual(Object.entries(e).filter(([n, v]) => n !== '10' && v !== 'vert'), []);
});

test('1 et 2 : dépôt privé voulu (DriveAI) → visibilité et machines « sans objet », le reste reste contrôlé', () => {
  const pc = CI.replace(/runs-on: .*/, 'runs-on: [self-hosted, pc-marc]');
  const drive = (extra = {}, api = {}) => depot({ fichiers: { '.github/workflows/ci.yml': pc, ...extra }, api: { depot: { nom: 'MoKarade/DriveAI', prive: true, branche: 'main', securite: null }, ...api } });
  assert.ok(PRIVES_VOULUS['mokarade/driveai']);
  const e = etats(drive());
  assert.equal(e[1], 'vert');
  assert.equal(e[2], 'vert');
  assert.match(detail(drive(), 1), /sans objet : privé par décision de Marc/);
  assert.match(detail(drive(), 2), /sans objet : machines du PC admises/);
  // La protection de branche, les timeouts et les paths: comptent toujours.
  assert.equal(etats(drive({}, { protection: { protegee: false, verifs: [] } }))[1], 'rouge');
  assert.equal(etats(drive({ '.github/workflows/ci.yml': pc.replace('timeout-minutes: 15\n', '') }))[2], 'rouge');
  assert.equal(etats(drive({ '.github/workflows/ci.yml': pc.replace('  pull_request:\n', '  pull_request:\n    paths: [a]\n') }))[2], 'rouge');
  // Un autre dépôt privé ou hors machines GitHub reste rouge.
  assert.equal(etats(depot({ fichiers: { '.github/workflows/ci.yml': pc }, api: { depot: { nom: 'MoKarade/autre', prive: true, branche: 'main' } } }))[1], 'rouge');
  assert.equal(etats(depot({ fichiers: { '.github/workflows/ci.yml': pc } }))[2], 'rouge');
});

test('1 : dépôt privé, branche non protégée, protection sans contrôle exigé', () => {
  assert.equal(etats(depot({ api: { depot: { prive: true, branche: 'main' } } }))[1], 'rouge');
  assert.equal(etats(depot({ api: { protection: { protegee: false, verifs: [] } } }))[1], 'rouge');
  assert.equal(etats(depot({ api: { protection: { protegee: true, verifs: [] } } }))[1], 'rouge');
  assert.equal(etats(depot({ api: { protection: null } }))[1], 'non-verifiable');
});

test('2 : machine hors GitHub, job sans timeout, paths: sur une PR', () => {
  const sans = (t) => etats(depot({ fichiers: { '.github/workflows/ci.yml': t } }))[2];
  assert.equal(sans(CI.replace(/\$\{\{[^\n]*\}\}/, 'self-hosted')), 'rouge');
  assert.equal(sans(CI.replace('    timeout-minutes: 15\n', '')), 'rouge');
  assert.equal(sans(CI.replace('  pull_request:\n', '  pull_request:\n    paths: [src/**]\n')), 'rouge');
  assert.match(detail(depot({ fichiers: { '.github/workflows/ci.yml': CI.replace('    timeout-minutes: 15\n', '') } }), 2), /ci\.yml:gate/);
});

test('3 : script absent ; script présent mais jamais lancé par la CI', () => {
  const pkg = JSON.parse(depot().lire('package.json'));
  delete pkg.scripts.lint;
  assert.equal(etats(depot({ fichiers: { 'package.json': JSON.stringify(pkg) } }))[3], 'rouge');
  assert.equal(etats(depot({ fichiers: { '.github/workflows/ci.yml': CI.replace('npm run lint && ', '') } }))[3], 'rouge');
});

test('4 : aucun seuil de couverture', () => {
  assert.equal(etats(depot({ fichiers: { 'qualite/seuils.json': '{"portes":{}}' } }))[4], 'rouge');
});

test('5 : fumée non appelée ; bibliothèque sans objet', () => {
  assert.equal(etats(depot({ fichiers: { '.github/workflows/ci.yml': CI.replace('fumee.yml', 'autre.yml') } }))[5], 'rouge');
  const biblio = depot({ retirer: ['vercel.json', 'app/globals.css'], fichiers: { 'package.json': '{"scripts":{},"dependencies":{}}' } });
  assert.equal(etats(biblio)[5], 'sans-objet');
  assert.equal(etats(biblio)[8], 'sans-objet');
  assert.equal(etats(biblio)[12], 'sans-objet');
});

test('6 : outils maison acceptés, mais OSV et CodeQL manquants sont dits ; réglage admin illisible', () => {
  const maison = CI.replace(/  securite:\n    uses:[^\n]*\n/, '      - run: gitleaks git .\n');
  const r = depot({ fichiers: { '.github/workflows/ci.yml': maison } });
  assert.equal(etats(r)[6], 'rouge');
  assert.match(detail(r, 6), /CodeQL absent/);
  assert.match(detail(r, 6), /OSV-Scanner absent/);
  assert.equal(etats(depot({ api: { depot: { prive: false, branche: 'main', securite: null } } }))[6], 'non-verifiable');
  assert.equal(etats(depot({ retirer: ['.github/dependabot.yml'] }))[6], 'rouge');
  assert.equal(etats(depot({ api: { depot: { prive: false, branche: 'main', securite: { secret_scanning: { status: 'disabled' }, secret_scanning_push_protection: { status: 'enabled' } } } } }))[6], 'rouge');
});

test('7 : zod 3, TypeScript 5.7, strict absent, Node 22, contrat en retard', () => {
  const avec = (modif) => {
    const pkg = JSON.parse(depot().lire('package.json'));
    modif(pkg);
    return etats(depot({ fichiers: { 'package.json': JSON.stringify(pkg) } }))[7];
  };
  assert.equal(avec((p) => (p.dependencies.zod = '^3.25.0')), 'rouge');
  // TypeScript : la version installée (package-lock) fait foi, pas la fourchette déclarée.
  assert.equal(avec((p) => (p.devDependencies.typescript = '^5.7.0')), 'vert');
  assert.equal(etats(depot({ fichiers: { 'tsconfig.json': '{"compilerOptions":{"strict":false}}' } }))[7], 'rouge');
  assert.equal(etats(depot({ fichiers: { '.nvmrc': '22\n' } }))[7], 'rouge');
  assert.equal(etats(depot({ api: { tagContrat: 'v1.5.0' } }))[7], 'rouge');
  assert.equal(etats(depot({ api: { tagContrat: null } }))[7], 'non-verifiable');
});

test('8 : préversions non coupées', () => {
  const v = (g) => etats(depot({ fichiers: { 'vercel.json': JSON.stringify(g) } }))[8];
  assert.equal(v({}), 'rouge');
  assert.equal(v({ git: { deploymentEnabled: { main: true } } }), 'rouge');
  assert.equal(v({ git: { deploymentEnabled: { '*': false, main: true, staging: true } } }), 'rouge');
  assert.equal(v({ git: { deploymentEnabled: { '*': false, main: true } } }), 'vert');
});

test('9 : ni Sentry, ni /api/sante, ni surveillance', () => {
  assert.equal(etats(depot({ retirer: ['app/api/sante/route.ts'] }))[9], 'rouge');
  // app Vite : la fonction Vercel api/sante.ts vaut la route Next.js
  const vite = depot({ retirer: ['app/api/sante/route.ts'], fichiers: { 'api/sante.ts': 'x' } });
  assert.equal(etats(vite)[9], 'vert');
  assert.doesNotMatch(detail(vite, 9), /route \/api\/sante absente/);
  assert.equal(etats(depot({ retirer: ['app/api/sante/route.ts'], fichiers: { 'src/api/sante.ts': 'x' } }))[9], 'rouge', 'seul api/ à la racine compte');
  assert.match(detail(depot({ retirer: ['app/api/sante/route.ts'] }), 9), /route \/api\/sante absente/);
  assert.equal(etats(depot({ api: { surveilles: [] } }))[9], 'rouge');
  assert.match(detail(depot({ api: { surveilles: ['MoKarade/autre'] } }), 9), /surveillance\/apps\.json/);
  assert.equal(etats(depot({ api: { surveilles: ['mokarade/X'] } }))[9], 'vert', 'la casse du nom de dépôt ne compte pas');
  const pkg = JSON.parse(depot().lire('package.json'));
  delete pkg.dependencies['@sentry/nextjs'];
  assert.equal(etats(depot({ fichiers: { 'package.json': JSON.stringify(pkg) } }))[9], 'rouge');
});

test('10 : base sans migration automatique ; la sauvegarde reste « à relire », jamais verte', () => {
  const pkg = JSON.parse(depot().lire('package.json'));
  delete pkg.scripts['vercel-build'];
  const sans = depot({ retirer: ['lib/migrations.ts'], fichiers: { 'package.json': JSON.stringify(pkg) } });
  assert.equal(etats(sans)[10], 'rouge');
  assert.match(detail(depot(), 10), /sauvegarde/);
});

test('10 : vercel-build qui délègue à un script du dépôt — db:migrate y est cherché', () => {
  const avec = (script, racine = '.') => {
    const pkg = JSON.parse(depot().lire('package.json'));
    pkg.scripts['vercel-build'] = 'node scripts/vercel-build.mjs';
    const chemin = (c) => (racine === '.' ? c : `${racine}/${c}`);
    return depot({
      retirer: ['lib/migrations.ts'],
      fichiers: { [chemin('package.json')]: JSON.stringify(pkg), [chemin('vercel.json')]: depot().lire('vercel.json'), [chemin('package-lock.json')]: depot().lire('package-lock.json'), ...(script === null ? {} : { [chemin('scripts/vercel-build.mjs')]: script }) },
      api: { racine },
    });
  };
  const migrations = avec("run('npm', ['run', 'db:migrate']);\nrun('npm', ['run', 'db:verifier-migrations']);");
  assert.equal(etats(migrations)[10], 'non-verifiable', 'valide : le script appelé contient db:migrate (la sauvegarde reste « à relire »)');
  assert.match(detail(migrations, 10), /migrations automatiques/);
  const sans = avec("run('npm', ['run', 'build']);");
  assert.equal(etats(sans)[10], 'rouge', 'rejeté : le script appelé ne contient pas db:migrate');
  assert.match(detail(sans, 10), /ni lib\/migrations\.ts ni db:migrate dans vercel-build \(ni dans scripts\/vercel-build\.mjs\)/);
  assert.equal(etats(avec(null))[10], 'rouge', 'rejeté : le script appelé est introuvable');
  assert.match(detail(avec("run('npm', ['run', 'db:migrate']);", 'web'), 10), /migrations automatiques/, 'le chemin du script se lit sous le dossier de l\u2019app (web/)');
  assert.deepEqual(scriptsAppeles('node scripts/a.mjs && next build'), ['scripts/a.mjs']);
  assert.deepEqual(scriptsAppeles('node ./scripts/a.mjs && node --max-old-space-size=4096 scripts/b.js'), ['scripts/a.mjs', 'scripts/b.js']);
  assert.deepEqual(scriptsAppeles('node ../hors.mjs && node /abs/x.mjs && npm run db:migrate && next build'), [], 'ni sortie du dossier, ni chemin absolu');
});

test('11 : CLAUDE.md trop long, HANDOVER, adr, BACKLOG non réduit, COMPTE-RENDU', () => {
  assert.equal(etats(depot({ fichiers: { 'CLAUDE.md': 'a\n'.repeat(61) } }))[11], 'rouge');
  assert.equal(etats(depot({ retirer: ['HANDOVER.md'] }))[11], 'rouge');
  assert.equal(etats(depot({ retirer: ['docs/adr/0001-x.md'] }))[11], 'rouge');
  assert.equal(etats(depot({ fichiers: { 'BACKLOG.md': 'a\n'.repeat(30) } }))[11], 'rouge');
  assert.equal(etats(depot({ fichiers: { 'BACKLOG.md': '# B\nFaire des choses\n' } }))[11], 'rouge');
  assert.equal(etats(depot({ retirer: ['docs/COMPTE-RENDU.md'] }))[11], 'rouge');
});

test('12 : pas de variables, pas de thème sombre, pas de verrou', () => {
  assert.equal(etats(depot({ fichiers: { 'app/globals.css': 'body { color: #fff; }' } }))[12], 'rouge');
  assert.equal(etats(depot({ fichiers: { 'app/globals.css': ':root { --a: #fff; }' } }))[12], 'rouge');
  assert.equal(etats(depot({ retirer: ['tests/theme.test.ts'] }))[12], 'rouge');
});

test('12 : sombre seul voulu = color-scheme: dark à la racine, avec variables et verrou', () => {
  const sombreSeul = ':root {\n  color-scheme: dark;\n  --fond: #07090d;\n}\nbody { color: var(--fond); }';
  assert.equal(etats(depot({ fichiers: { 'app/globals.css': sombreSeul } }))[12], 'vert');
  assert.match(detail(depot({ fichiers: { 'app/globals.css': sombreSeul } }), 12), /sombre seul voulu/);
  // Le verrou et les variables restent exigés.
  assert.equal(etats(depot({ fichiers: { 'app/globals.css': sombreSeul }, retirer: ['tests/theme.test.ts'] }))[12], 'rouge');
  assert.equal(etats(depot({ fichiers: { 'app/globals.css': 'html { color-scheme: dark; }' } }))[12], 'rouge');
});

test('12 : color-scheme: dark hors de la racine ne vaut pas sombre seul', () => {
  const rouge = (css) => etats(depot({ fichiers: { 'app/globals.css': `:root { --a: #fff; }\n${css}` } }))[12];
  assert.equal(rouge('.terminal { color-scheme: dark; }'), 'rouge');
  assert.equal(rouge('@supports (color: red) { :root { color-scheme: dark; } }'), 'rouge');
  assert.equal(rouge(':root { color-scheme: light dark; }'), 'rouge');
  assert.equal(rouge(':root { color-scheme: light; }'), 'rouge');
  assert.equal(rouge('/* :root { color-scheme: dark; } */'), 'rouge');
  assert.equal(rouge(':root { --color-scheme: dark; }'), 'rouge');
  assert.equal(rouge('html, body { color-scheme: dark }'), 'vert');
  assert.equal(rouge('.a, :root { color-scheme: dark; }'), 'rouge');
});

test('sombreSeulDeclare : entrées vides ou illisibles', () => {
  assert.equal(sombreSeulDeclare(''), false);
  assert.equal(sombreSeulDeclare(null), false);
  assert.equal(sombreSeulDeclare(':root { color-scheme: dark; '), false);
  assert.equal(sombreSeulDeclare(':root{color-scheme:dark}'), true);
});

test('sombreSeulDeclare : une instruction de premier niveau terminée par « ; » (@import…) ne masque pas :root', () => {
  assert.equal(sombreSeulDeclare('@import "tailwindcss"; :root { color-scheme: dark }'), true, 'valide : @import en tête, sombre seul sur :root');
  assert.equal(sombreSeulDeclare('@import "x"; .terminal { color-scheme: dark }'), false, 'rejeté : sur un composant, l\u2019@import ne change rien');
  assert.equal(sombreSeulDeclare('@charset "utf-8";\n@import "a";\n@plugin "b";\nhtml, body { color-scheme: dark; }'), true, 'plusieurs instructions, plusieurs sélecteurs');
  assert.equal(sombreSeulDeclare('@import "tailwindcss";\n@media (min-width: 1px) { :root { color-scheme: dark } }'), false, 'dans un @media, toujours refusé');
  assert.equal(sombreSeulDeclare('@import "tailwindcss";\n:root { --a: #fff; }\n.x { color-scheme: dark }'), false, 'un « ; » dans un corps ne remet rien à zéro');
});

test('13 : action épinglée par tag ; appel d’un workflow commun en @main toléré', () => {
  assert.equal(etats(depot({ fichiers: { '.github/workflows/ci.yml': CI.replace(`@${SHA}`, '@v7') } }))[13], 'rouge');
  assert.equal(etats(depot({ fichiers: { '.github/workflows/ci.yml': CI.replace('securite.yml@main', 'securite.yml@v1') } }))[13], 'rouge');
  assert.equal(etats(depot())[13], 'vert');
});

test('14 : cron toutes les heures refusé, une fois par jour accepté', () => {
  const c = (schedule) => etats(depot({ fichiers: { 'vercel.json': JSON.stringify({ git: { deploymentEnabled: { '*': false, main: true } }, crons: [{ path: '/x', schedule }] }) } }))[14];
  assert.equal(c('0 * * * *'), 'rouge');
  assert.equal(c('*/5 * * * *'), 'rouge');
  assert.equal(c('0 6 * * *'), 'vert');
  assert.equal(cronQuotidien('30 4 * * 1'), true);
  assert.equal(cronQuotidien('0 */2 * * *'), false);
});

test('15 : commit sans préfixe, titre de PR sans préfixe, historique illisible', () => {
  const sans = [{ message: 'Correction de trucs', parents: 1 }];
  assert.equal(etats(depot({ api: { commits: sans } }))[15], 'rouge');
  assert.equal(etats(depot({ api: { titrePr: 'Mise à jour' } }))[15], 'rouge');
  assert.equal(etats(depot({ api: { commits: null } }))[15], 'non-verifiable');
  assert.equal(etats(depot({ api: { commits: [{ message: 'Merge pull request #1 x', parents: 2 }, { message: 'Merge branch main', parents: 1 }] } }))[15], 'vert');
});

test('jobsDe : un job sans timeout est détecté, un appel `uses:` ne l’exige pas', () => {
  const jobs = jobsDe(CI);
  assert.deepEqual(jobs.map((j) => j.nom), ['gate', 'securite', 'fumee', 'surveillance']);
});

test('le tableau dit l’état et la cause de chaque ligne rouge', () => {
  const t = tableau(evaluer(depot({ retirer: ['HANDOVER.md'] })), 'MoKarade/x');
  assert.match(t, /\| 11 \| .* \| ROUGE \| .*HANDOVER\.md absent/);
  assert.match(t, /13 vert · 1 rouge · 1 à relire/);
});
