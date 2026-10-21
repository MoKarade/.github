import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Le filtre `reduire` est pur (aucune dépendance Python au-delà de la bibliothèque standard) : on le charge tel quel,
// sur un graphe fictif en mémoire. Aucun réseau, aucun graphe réel.
const SCRIPT = fileURLToPath(new URL('./graphe-page.py', import.meta.url));

const noeud = (id, source_file, file_type = 'code') => ({ id, label: id, source_file, file_type });
const lien = (source, target) => ({ source, target, relation: 'calls' });

function reduire(graphe, maxNoeuds = 400) {
  const programme = [
    'import importlib.util, json, sys',
    'spec = importlib.util.spec_from_file_location("graphe_page", sys.argv[1])',
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    'gardes, liens, groupes, total = m.reduire(json.loads(sys.argv[2]), int(sys.argv[3]))',
    'print(json.dumps({"gardes": gardes, "liens": [[a, b, w] for (a, b), w in sorted(liens.items())], "groupes": groupes, "total": total}))',
  ].join('\n');
  const r = spawnSync('python3', ['-I', '-B', '-c', programme, SCRIPT, JSON.stringify(graphe), String(maxNoeuds)], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const G = {
  nodes: [
    noeud('a1', 'lib/a.ts'), noeud('a2', 'lib/a.ts'), noeud('b1', 'lib/b.ts'), noeud('c1', 'app/page.tsx'),
    noeud('t1', 'tests/a.test.ts'), noeud('d1', 'docs/guide.md', 'document'), noeud('cfg', 'package.json'),
    noeud('iso', 'lib/seul.ts'), noeud('doc2', 'HANDOVER.md', 'document'),
  ],
  links: [lien('a1', 'b1'), lien('a2', 'b1'), lien('b1', 'c1'), lien('t1', 'a1'), lien('d1', 'a1'), lien('a1', 'a2'), lien('cfg', 'a1')],
};

test('garde le code des dossiers sources et agrège les symboles par fichier', () => {
  const r = reduire(G);
  assert.deepEqual(r.gardes, ['app/page.tsx', 'lib/a.ts', 'lib/b.ts']);
  // a1->b1 et a2->b1 comptent pour un seul lien de poids 2 ; a1->a2 est interne au fichier : ignoré.
  assert.deepEqual(r.liens, [['app/page.tsx', 'lib/b.ts', 1], ['lib/a.ts', 'lib/b.ts', 2]]);
});

test('écarte tests, docs, config et fichiers isolés', () => {
  const r = reduire(G);
  for (const ecarte of ['tests/a.test.ts', 'docs/guide.md', 'package.json', 'HANDOVER.md', 'lib/seul.ts']) {
    assert.ok(!r.gardes.includes(ecarte), `${ecarte} ne doit pas figurer sur la page`);
  }
  assert.equal(r.total, 4, 'les fichiers de code comptés avant réduction : a, b, page, seul');
});

test('ne garde que les fichiers les plus reliés au-delà de max-noeuds', () => {
  const r = reduire(G, 2);
  assert.deepEqual(r.gardes, ['lib/a.ts', 'lib/b.ts']);
  assert.deepEqual(r.liens, [['lib/a.ts', 'lib/b.ts', 2]]);
});

test('un sous-dossier de moins de 3 fichiers retombe sur son parent', () => {
  const noeuds = ['x', 'y', 'z'].map((n) => noeud(n, `lib/db/${n}.ts`)).concat([noeud('s', 'lib/seul/s.ts'), noeud('r', 'lib/r.ts')]);
  const liens = [lien('x', 'y'), lien('y', 'z'), lien('z', 's'), lien('s', 'r')];
  const r = reduire({ nodes: noeuds, links: liens });
  assert.deepEqual(Object.keys(r.groupes).sort(), ['lib', 'lib/db']);
  assert.deepEqual(r.groupes['lib'].sort(), ['lib/r.ts', 'lib/seul/s.ts']);
});

test('un graphe sans lien entre fichiers ne produit aucune page', () => {
  const r = reduire({ nodes: [noeud('a', 'lib/a.ts')], links: [] });
  assert.deepEqual(r.gardes, []);
});

test('meta.json porte les champs lus par Hubperso, avec le filtre versionné', () => {
  const programme = [
    'import importlib.util, json, sys',
    'spec = importlib.util.spec_from_file_location("graphe_page", sys.argv[1])',
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    'print(json.dumps(m.meta("MoKarade/exemple", "abc1234", "2026-10-21T15:00:00Z", 12, 30, 400)))',
  ].join('\n');
  const r = spawnSync('python3', ['-I', '-B', '-c', programme, SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    depot: 'MoKarade/exemple', sha: 'abc1234', genereLe: '2026-10-21T15:00:00Z', noeuds: 12, aretes: 30, filtre: 'fichiers-v1;max400',
  });
});
