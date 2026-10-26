// Les workflows communs appelés par les dix dépôts choisissent leur machine selon la visibilité du dépôt appelant :
// un `runs-on: ubuntu-latest` seul échoue aussitôt sur un dépôt privé (facturation GitHub refusée, FinanceAI le 21/10/2026).
// Aucune dépendance : `node --test scripts/runners.test.mjs`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const COMMUNS = ['securite', 'conformite', 'fumee', 'captures'];

/** Les valeurs de `runs-on:` d'un workflow, une par job (commentaire de fin de ligne retiré). */
export function runsOn(yaml) {
  return [...yaml.matchAll(/^\s*runs-on:\s*(.+?)\s*$/gm)].map((m) => m[1].replace(/\s+#.*$/, ''));
}

/** Vrai si la machine dépend de la visibilité : public = machines GitHub, privé = robot du PC. */
export function selonVisibilite(valeur) {
  return (
    valeur.includes('github.event.repository.visibility') &&
    valeur.includes("'ubuntu-latest'") &&
    valeur.includes('self-hosted') &&
    valeur.includes('pc-marc')
  );
}

for (const nom of COMMUNS) {
  test(`${nom}.yml : chaque job choisit sa machine selon la visibilité`, () => {
    const valeurs = runsOn(readFileSync(new URL(`../.github/workflows/${nom}.yml`, import.meta.url), 'utf8'));
    assert.ok(valeurs.length > 0, 'aucun runs-on lu : le test ne vérifie rien');
    for (const v of valeurs) assert.ok(selonVisibilite(v), `${nom}.yml : runs-on « ${v} » ne dépend pas de la visibilité`);
  });
}

test('un runs-on ubuntu-latest seul est refusé, l\'expression du garde-fou est acceptée', () => {
  assert.deepEqual(runsOn('jobs:\n  a:\n    runs-on: ubuntu-latest # x\n'), ['ubuntu-latest']);
  assert.equal(selonVisibilite('ubuntu-latest'), false);
  const bon =
    "${{ github.event.repository.visibility == 'public' && 'ubuntu-latest' || fromJSON('[\"self-hosted\",\"pc-marc\"]') }}";
  assert.equal(selonVisibilite(bon), true);
});

test('securite.yml : OSV-Scanner passe par un binaire vérifié, sans aucune action Docker', () => {
  const yaml = readFileSync(new URL('../.github/workflows/securite.yml', import.meta.url), 'utf8');
  // Le runner tire l'image d'une action Docker pendant « Set up job », même si son étape est sautée : une seule référence
  // à l'action suffit à faire échouer le job sur le robot du PC (pas de Docker).
  assert.doesNotMatch(yaml, /uses:\s*google\/osv-scanner-action/, 'l\'action Docker osv-scanner ne doit plus être référencée');
  assert.match(yaml, /sha256sum -c/);
  assert.match(yaml, /osv-scanner" scan source --lockfile=/);
});

test('captures.yml : --with-deps (sudo) seulement en dépôt public', () => {
  const yaml = readFileSync(new URL('../.github/workflows/captures.yml', import.meta.url), 'utf8');
  // Le robot du PC n'a pas sudo : `playwright install --with-deps` y échoue (« sudo: a password is required »).
  const lignes = yaml.split('\n');
  const idx = lignes.findIndex((l) => l.includes('npx playwright install --with-deps'));
  assert.ok(idx > 0, '--with-deps absent : le chemin public a disparu');
  assert.match(lignes[idx - 1], /if \[ "\$VISIBILITE" = "public" \]/, '--with-deps doit être réservé au dépôt public');
  assert.match(yaml, /VISIBILITE: \$\{\{ github\.event\.repository\.visibility \}\}/);
  assert.equal(yaml.match(/playwright install/g).length, 2, 'une seule installation par visibilité');
});

test('captures.yml : installe le CLI gh (binaire vérifié) avant de publier, seulement s\'il manque', () => {
  const yaml = readFileSync(new URL('../.github/workflows/captures.yml', import.meta.url), 'utf8');
  // Le robot du PC n'a pas gh : « gh: command not found » à `gh auth setup-git` (FinanceAI#1249, 22/10/2026).
  const installe = yaml.indexOf("Installer le CLI gh s'il manque");
  const publie = yaml.indexOf('gh auth setup-git');
  assert.ok(installe > 0 && publie > installe, "l'installation de gh doit précéder gh auth setup-git");
  const bloc = yaml.slice(installe, publie);
  assert.match(bloc, /command -v gh/);
  assert.match(bloc, /sha256sum -c/);
  assert.match(bloc, /GH_VERSION: \d+\.\d+\.\d+/);
  assert.match(bloc, /GITHUB_PATH/);
});

test('securite.yml : zizmor tourne sans bloquer, version fixée, installation vérifiée par empreinte, configuration commune', () => {
  const yaml = readFileSync(new URL('../.github/workflows/securite.yml', import.meta.url), 'utf8');
  const job = yaml.slice(yaml.indexOf('\n  workflows:'), yaml.indexOf('\n  codeql:'));
  assert.ok(job.length > 0, 'le job « workflows » (zizmor) a disparu');
  assert.match(job, /ZIZMOR_VERSION: \d+\.\d+\.\d+/);
  assert.equal([...job.matchAll(/ZIZMOR_HASH_\w+: ([0-9a-f]{64})\b/g)].length, 2, 'deux empreintes SHA-256 (manylinux et musllinux)');
  assert.match(job, /--require-hashes/);
  // Non bloquant (tâche #585) : passer en bloquant se décide dans une tâche à part, après la correction des trouvailles.
  assert.match(job, /--no-exit-codes/);
  // Le runner lance l'étape avec `bash -e` : sans `set +e`, une panne de l'outil ferait échouer le job au lieu d'être dite dans le résumé.
  assert.match(job, /set \+e/);
  assert.match(job, /--offline/);
  assert.match(job, /--config \.securite-commune\/securite\/zizmor\.yml/);
  assert.doesNotMatch(job, /uses:\s*(docker:\/\/|zizmorcore\/)/, 'aucune action Docker : le robot du PC n\'a pas Docker');
});

test('securite/zizmor.yml : chaque exception porte sa raison, nos workflows communs suivent main, le reste est épinglé', () => {
  const lignes = readFileSync(new URL('../securite/zizmor.yml', import.meta.url), 'utf8').split('\n');
  assert.ok(lignes.some((l) => /"MoKarade\/\.github\/\*": ref-pin/.test(l)));
  assert.ok(lignes.some((l) => /"\*": hash-pin/.test(l)));
  const ignorees = lignes.map((l, i) => [l, i]).filter(([l]) => /^\s+- \S+\.yml\s*$/.test(l));
  assert.ok(ignorees.length > 0, 'aucune exception lue : le test ne vérifie rien');
  for (const [l, i] of ignorees) assert.match(lignes[i - 1] ?? '', /^\s+#/, `exception « ${l.trim()} » sans raison écrite juste au-dessus`);
});
