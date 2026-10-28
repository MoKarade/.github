import test from 'node:test';
import assert from 'node:assert/strict';
import {
  modelesAMigrer,
  familleDuModele,
  cleBaseModele,
  estPlusRecent,
  genererCorpsTache,
  PARENT_MISSION,
} from '../scripts/modeles-nouveaux.mjs';

test('familleDuModele identifie correctement haiku, sonnet et opus', () => {
  assert.equal(familleDuModele('claude-3-5-sonnet-20241022'), 'sonnet');
  assert.equal(familleDuModele('claude-3-haiku-20240307'), 'haiku');
  assert.equal(familleDuModele('claude-3-opus-20240229'), 'opus');
  assert.equal(familleDuModele('claude-sonnet-5-5-20260901'), 'sonnet');
  assert.equal(familleDuModele('gpt-4o'), null);
});

test('cleBaseModele normalise un alias flottant et son instantané daté', () => {
  assert.equal(cleBaseModele('claude-3-5-sonnet-20241022'), 'claude-3-5-sonnet');
  assert.equal(cleBaseModele('claude-3-5-sonnet-latest'), 'claude-3-5-sonnet');
  assert.equal(cleBaseModele('claude-3-haiku-20240307'), 'claude-3-haiku');
  assert.equal(cleBaseModele('claude-haiku-4-5-20260301'), 'claude-haiku-4-5');
});

test('estPlusRecent compare deux modèles selon leur version ou date', () => {
  assert.equal(estPlusRecent('claude-3-5-sonnet-20241022', 'claude-3-7-sonnet-20250219'), true);
  assert.equal(estPlusRecent('claude-3-7-sonnet-20250219', 'claude-3-5-sonnet-20241022'), false);
  // Alias flottant vs instantané daté du même modèle : même clé de base, donc non plus récent
  assert.equal(estPlusRecent('claude-3-5-sonnet-20241022', 'claude-3-5-sonnet-latest'), false);
});

test('genererCorpsTache remplace toutes les variables du gabarit et inclut la mission', () => {
  const corps = genererCorpsTache({
    app: 'emploi',
    ancien: 'claude-3-5-sonnet-20241022',
    nouveau: 'claude-3-7-sonnet-20250219',
    famille: 'sonnet',
  });

  assert.ok(corps.includes('emploi'));
  assert.ok(corps.includes('claude-3-5-sonnet-20241022'));
  assert.ok(corps.includes('claude-3-7-sonnet-20250219'));
  assert.ok(corps.includes('sonnet'));
  assert.ok(corps.includes(PARENT_MISSION));
});

test('1. un plus récent dans une famille utilisée donne une tâche', () => {
  const listeModeles = [
    { id: 'claude-3-5-sonnet-20241022', created_at: '2024-10-22T00:00:00Z' },
    { id: 'claude-3-7-sonnet-20250219', created_at: '2025-02-19T00:00:00Z' },
  ];

  const idsParApp = [
    {
      nom: 'emploi',
      depot: 'MoKarade/JobAI',
      utilises: ['claude-3-5-sonnet-20241022'],
      ouvertes: [],
    },
  ];

  const resultats = modelesAMigrer(listeModeles, idsParApp);

  assert.equal(resultats.length, 1);
  assert.equal(resultats[0].app, 'emploi');
  assert.equal(resultats[0].depot, 'MoKarade/JobAI');
  assert.equal(resultats[0].ancien, 'claude-3-5-sonnet-20241022');
  assert.equal(resultats[0].nouveau, 'claude-3-7-sonnet-20250219');
  assert.equal(resultats[0].famille, 'sonnet');
  assert.equal(resultats[0].titre, 'Migration de emploi vers le modèle claude-3-7-sonnet-20250219');
  assert.ok(resultats[0].corps.includes('claude-3-7-sonnet-20250219'));
});

test('2. aucun plus récent donne rien', () => {
  const listeModeles = [
    { id: 'claude-3-5-sonnet-20241022', created_at: '2024-10-22T00:00:00Z' },
  ];

  const idsParApp = [
    {
      nom: 'emploi',
      depot: 'MoKarade/JobAI',
      utilises: ['claude-3-5-sonnet-20241022'],
      ouvertes: [],
    },
  ];

  const resultats = modelesAMigrer(listeModeles, idsParApp);
  assert.equal(resultats.length, 0);
});

test('3. une famille non utilisée par l’app donne rien', () => {
  const listeModeles = [
    { id: 'claude-3-opus-20240229', created_at: '2024-02-29T00:00:00Z' },
    { id: 'claude-opus-5-5-20260901', created_at: '2026-09-01T00:00:00Z' },
  ];

  const idsParApp = [
    {
      nom: 'emploi',
      depot: 'MoKarade/JobAI',
      utilises: ['claude-3-5-sonnet-20241022'], // famille sonnet
      ouvertes: [],
    },
  ];

  const resultats = modelesAMigrer(listeModeles, idsParApp);
  assert.equal(resultats.length, 0);
});

test('4. une tâche déjà ouverte pour le même couple (app, nouveau modèle) ne donne pas de doublon (titre contenant l’identifiant)', () => {
  const listeModeles = [
    { id: 'claude-3-5-sonnet-20241022', created_at: '2024-10-22T00:00:00Z' },
    { id: 'claude-3-7-sonnet-20250219', created_at: '2025-02-19T00:00:00Z' },
  ];

  const idsParApp = [
    {
      nom: 'emploi',
      depot: 'MoKarade/JobAI',
      utilises: ['claude-3-5-sonnet-20241022'],
      ouvertes: ['Migration de emploi vers le modèle claude-3-7-sonnet-20250219'],
    },
  ];

  const resultats = modelesAMigrer(listeModeles, idsParApp);
  assert.equal(resultats.length, 0);
});

test('5. un alias flottant et son instantané daté sont comptés comme le même modèle', () => {
  const listeModeles = [
    { id: 'claude-3-5-sonnet-latest', created_at: '2024-10-22T00:00:00Z' },
  ];

  const idsParApp = [
    {
      nom: 'emploi',
      depot: 'MoKarade/JobAI',
      utilises: ['claude-3-5-sonnet-20241022'],
      ouvertes: [],
    },
  ];

  const resultats = modelesAMigrer(listeModeles, idsParApp);
  assert.equal(resultats.length, 0);
});
