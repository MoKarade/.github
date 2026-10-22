import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Le banc lance `scripts/graphe.sh` et `git grep` dans le dépôt mesuré ; ici on ne teste que les fonctions pures,
// sur des sorties fictives. Aucun réseau, aucun graphe réel. Le script n'utilise que la bibliothèque standard Python.
const SCRIPT = fileURLToPath(new URL('./graphe-impact.py', import.meta.url));

// Appelle `m.<fonction>(*arguments JSON)` et rend le résultat JSON.
function appeler(fonction, ...args) {
  const programme = [
    'import importlib.util, json, sys',
    'spec = importlib.util.spec_from_file_location("graphe_impact", sys.argv[1])',
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    `print(json.dumps(m.${fonction}(*json.loads(sys.argv[2])), default=sorted))`,
  ].join('\n');
  const r = spawnSync('python3', ['-I', '-B', '-c', programme, SCRIPT, JSON.stringify(args)], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const noeud = (id, label, source_file, file_type = 'code') => ({ id, label, source_file, file_type, community: 1 });
const lien = (source, target) => ({ source, target, relation: 'calls' });

const AFFECTED = [
  'Affected nodes for decideAcces()',
  'Depth: 2',
  '- requireSession() [calls] lib/session.ts:L12',
  '- page.tsx [imports] app/page.tsx:L3',
  '- Titre de doc [references] docs/guide.md:L7',
  '- decideAcces.test.ts [references] tests/acces.test.ts:L9',
].join('\n');

const GREP = [
  'lib/acces.ts:10:export function decideAcces(x) {',
  'lib/session.ts:12:  return decideAcces(s);',
  'lib/ancien.ts:4:// decideAcces remplace aclAcces',
  'tests/acces.test.ts:9:decideAcces(',
  'docs/guide.md:7:decideAcces',
].join('\n');

test('choisit les symboles les plus reliés, un par libellé, en écartant tests, docs et mots courts', () => {
  const graphe = {
    nodes: [
      noeud('a', 'requireSession', 'lib/session.ts'), noeud('b', 'decideAcces', 'lib/acces.ts'),
      noeud('c', 'decideAcces', 'lib/doublon.ts'), noeud('d', 'get', 'lib/court.ts'),
      noeud('e', 'dansTest', 'tests/a.test.ts'), noeud('f', 'devDependencies', 'package.json'),
      noeud('g', 'Titre', 'docs/guide.md', 'document'), noeud('h', 'peuRelie', 'lib/peu.ts'),
    ],
    links: [lien('a', 'b'), lien('a', 'c'), lien('a', 'd'), lien('b', 'e'), lien('f', 'a'), lien('g', 'a'), lien('h', 'b')],
  };
  const r = appeler('choisir_symboles', graphe, 10);
  assert.deepEqual(r.map((s) => s.symbole), ['requireSession', 'decideAcces', 'peuRelie']);
  assert.equal(r[1].fichier, 'lib/acces.ts', 'le doublon garde le nœud le plus relié');
  assert.equal(appeler('choisir_symboles', graphe, 2).length, 2);
});

test('lit les fichiers cités par affected, sans doublon', () => {
  const r = appeler('fichiers_affectes', `${AFFECTED}\n- autre [calls] lib/session.ts:L40`);
  assert.deepEqual(r.sort(), ['app/page.tsx', 'docs/guide.md', 'lib/session.ts', 'tests/acces.test.ts']);
});

test('compte les fichiers et les lignes de commentaire de git grep', () => {
  const [fichiers, commentaires] = appeler('analyser_grep', GREP);
  assert.deepEqual(fichiers.sort(), ['docs/guide.md', 'lib/acces.ts', 'lib/ancien.ts', 'lib/session.ts', 'tests/acces.test.ts']);
  assert.equal(commentaires, 1);
});

test('une ligne du banc compare graphe et grep sur le code hors tests et hors docs', () => {
  const l = appeler('ligne_banc', 'decideAcces', 'lib/acces.ts', AFFECTED, 1400, GREP, 15);
  assert.equal(l.graphe_caracteres, AFFECTED.length);
  assert.equal(l.graphe_jetons, Math.round(AFFECTED.length / 4));
  assert.equal(l.fichiers_graphe, 2, 'lib/session.ts et app/page.tsx : ni doc ni test');
  assert.equal(l.fichiers_grep, 3, 'lib/acces.ts, lib/session.ts, lib/ancien.ts');
  assert.equal(l.fichiers_communs, 1);
  assert.equal(l.graphe_en_plus, 1);
  assert.equal(l.grep_en_plus, 2);
  assert.equal(l.rappel, 0.333);
  assert.equal(l.grep_commentaires, 1);
});

test('un appel échoué laisse ses mesures à null, jamais à 0', () => {
  const l = appeler('ligne_banc', 'decideAcces', 'lib/acces.ts', null, null, GREP, 15);
  for (const cle of ['graphe_caracteres', 'graphe_jetons', 'graphe_ms', 'fichiers_graphe', 'fichiers_communs', 'graphe_en_plus', 'rappel']) {
    assert.equal(l[cle], null, cle);
  }
  assert.equal(l.grep_jetons, Math.round(GREP.length / 4));
});

test('les totaux ne comptent que les lignes entièrement mesurées', () => {
  const bonne = appeler('ligne_banc', 'decideAcces', 'lib/acces.ts', AFFECTED, 1400, GREP, 15);
  const cassee = appeler('ligne_banc', 'autre', 'lib/b.ts', null, null, GREP, 15);
  const t = appeler('totaux', [bonne, cassee]);
  assert.equal(t.lignes_mesurees, 1);
  assert.equal(t.graphe_jetons, bonne.graphe_jetons);
  assert.equal(t.economie_jetons, Number((1 - bonne.graphe_jetons / bonne.grep_jetons).toFixed(3)));
  const vide = appeler('totaux', [cassee]);
  assert.equal(vide.lignes_mesurees, 0);
  assert.equal(vide.economie_jetons, null);
});

// Exemple complet, tel que le workflow le publie.
function exemple() {
  const banc = [appeler('ligne_banc', 'decideAcces', 'lib/acces.ts', AFFECTED, 1400, GREP, 15)];
  return {
    version: 'impact-v1', depot: 'MoKarade/exemple', sha: 'abc1234', genereLe: '2026-10-22T12:00:00Z', methode: 'test',
    taille: { noeuds: 10, aretes: 12, fichiers: 6, communautes: 2, langages: { ts: 5, md: 1 }, page_noeuds: 4, hors_page: 1, construction_s: 8.5 },
    banc, totaux: appeler('totaux', banc),
  };
}

test('impact-v1 : un exemple mesuré est valide, un exemple avec des null aussi', () => {
  assert.deepEqual(appeler('valider', exemple()), []);
  const sans = exemple();
  sans.taille.construction_s = null;
  sans.taille.hors_page = null;
  sans.banc = [appeler('ligne_banc', 'x', 'lib/x.ts', null, null, null, null)];
  sans.totaux = appeler('totaux', sans.banc);
  assert.deepEqual(appeler('valider', sans), []);
});

test('impact-v1 : refuse une valeur non mesurée autre que null', () => {
  for (const mauvaise of ['n/a', 'inconnu', -1, true, '12']) {
    const e = exemple();
    e.banc[0].graphe_ms = mauvaise;
    const ecarts = appeler('valider', e);
    assert.ok(ecarts.some((x) => x.includes('banc[0].graphe_ms')), `${JSON.stringify(mauvaise)} doit être refusé`);
  }
  const e = exemple();
  e.taille.construction_s = 'inconnue';
  assert.ok(appeler('valider', e).some((x) => x.includes('taille.construction_s')));
  const t = exemple();
  t.totaux.economie_jetons = 'n/a';
  assert.ok(appeler('valider', t).some((x) => x.includes('totaux.economie_jetons')));
});

test('impact-v1 : refuse un banc de plus de 10 lignes, une version inconnue et un champ absent', () => {
  const trop = exemple();
  trop.banc = Array.from({ length: 11 }, () => exemple().banc[0]);
  assert.ok(appeler('valider', trop).some((x) => x.startsWith('banc')));
  const v = exemple();
  v.version = 'impact-v2';
  assert.ok(appeler('valider', v).some((x) => x.startsWith('version')));
  const a = exemple();
  delete a.banc[0].rappel;
  assert.ok(appeler('valider', a).some((x) => x.includes('rappel : champ absent')));
  const r = exemple();
  r.banc[0].rappel = 1.5;
  assert.ok(appeler('valider', r).some((x) => x.includes('entre 0 et 1')));
});
