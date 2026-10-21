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

test('securite.yml : OSV-Scanner a une voie sans Docker, vérifiée, pour le robot du PC (dépôt privé)', () => {
  const yaml = readFileSync(new URL('../.github/workflows/securite.yml', import.meta.url), 'utf8');
  // L'action Docker ne sert qu'en public ; l'étape privée vérifie la somme du binaire avant de l'exécuter.
  const bloc = yaml.slice(yaml.indexOf('Analyser les dépendances (binaire, dépôt privé)'));
  assert.ok(bloc.length > 0, 'étape OSV pour dépôt privé absente');
  assert.match(bloc, /visibility != 'public'/);
  assert.match(bloc, /sha256sum -c/);
  assert.match(bloc, /osv-scanner" scan source --lockfile=/);
  const action = yaml.slice(yaml.indexOf('name: Analyser les dépendances\n'), yaml.indexOf('Analyser les dépendances (binaire'));
  assert.match(action, /visibility == 'public'/, 'l\'action Docker doit être réservée au dépôt public');
});
