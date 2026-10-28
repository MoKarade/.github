import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const GABARIT_PATH = path.resolve('docs/gabarits/migration-modele.md');

test('le fichier gabarit de migration existe', () => {
  assert.ok(fs.existsSync(GABARIT_PATH), 'Le fichier docs/gabarits/migration-modele.md doit exister');
});

test('le gabarit contient chacune des 4 variables au moins une fois', () => {
  const content = fs.readFileSync(GABARIT_PATH, 'utf8');
  const variables = ['{{app}}', '{{ancien}}', '{{nouveau}}', '{{famille}}'];

  for (const variable of variables) {
    assert.ok(
      content.includes(variable),
      `La variable ${variable} doit être présente dans le gabarit`
    );
  }
});

test('la section « À surveiller » reprend EXACTEMENT la liste attendue', () => {
  const content = fs.readFileSync(GABARIT_PATH, 'utf8');

  const pointsAttendus = [
    'temperature, top_p, top_k sont refusés (erreur 400) ; budget_tokens refusé, pensée adaptative seulement ;',
    'la pensée est activée par défaut et comptée dans max_tokens : lire les blocs de réponse par type, jamais par position ;',
    'Sonnet 5.5 et Opus 5.5 refusent tool_choice « any » / « tool » et thinking: disabled (Sonnet 5.5 accepte between_tools) ; Haiku 5.5 accepte disabled à effort ≤ high ;',
    'le préremplissage de la réponse (prefill) est refusé ;',
    'les blocs de pensée se renvoient tels quels, l\'historique ne se fait qu\'en ajout ;',
    'nouveau tokenizer (+30 % de jetons pour Haiku 5.5) : revoir max_tokens et les coûts estimés ;',
    'un refus est possible (stop_reason: refusal) : le code doit le traiter, pas l\'avaler ;',
    'tableaux de prix indexés par préfixe : claude-sonnet-5 capte claude-sonnet-5-5 (piège) ; mettre le préfixe le plus long d\'abord ;',
    'supprimer l\'ancien identifiant du code, des tarifs, des tests et des docs, SAUF une table de prix en lecture seule qui sert à relire d\'anciens compteurs (dire laquelle dans la PR) ;',
    'prix à reprendre de la page officielle du jour, avec la date de relevé (au 2026-10-28 : Haiku 5.5 0,10/0,50 $, Sonnet 5.5 2/10 $, Opus 5.5 4/20 $ par million de jetons, lecture du cache ×0,05).'
  ];

  assert.ok(content.includes('**À surveiller** :'), 'La section **À surveiller** : doit exister');

  for (const point of pointsAttendus) {
    assert.ok(
      content.includes(point),
      `Le point suivant doit être présent exactement dans la section « À surveiller » :\n${point}`
    );
  }
});
