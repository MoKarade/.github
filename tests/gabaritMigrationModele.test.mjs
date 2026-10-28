import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Le chemin se résout depuis ce fichier, jamais depuis le dossier courant.
const GABARIT_PATH = fileURLToPath(new URL('../docs/gabarits/migration-modele.md', import.meta.url));

const SECTIONS = ['Avant', 'Après', 'Fini quand', 'À faire', 'À ne pas faire', 'À surveiller', 'Vérifier', 'Fichiers permis', 'Source'];

const POINTS_ATTENDUS = [
  'temperature, top_p, top_k sont refusés (erreur 400) ; budget_tokens refusé, pensée adaptative seulement ;',
  'la pensée est activée par défaut et comptée dans max_tokens : lire les blocs de réponse par type, jamais par position ;',
  'Sonnet 5.5 et Opus 5.5 refusent tool_choice « any » / « tool » et thinking: disabled (Sonnet 5.5 accepte between_tools) ; Haiku 5.5 accepte disabled à effort ≤ high ;',
  'le préremplissage de la réponse (prefill) est refusé ;',
  "les blocs de pensée se renvoient tels quels, l'historique ne se fait qu'en ajout ;",
  'nouveau tokenizer (+30 % de jetons pour Haiku 5.5) : revoir max_tokens et les coûts estimés ;',
  "un refus est possible (stop_reason: refusal) : le code doit le traiter, pas l'avaler ;",
  "tableaux de prix indexés par préfixe : claude-sonnet-5 capte claude-sonnet-5-5 (piège) ; mettre le préfixe le plus long d'abord ;",
  "supprimer l'ancien identifiant du code, des tarifs, des tests et des docs, SAUF une table de prix en lecture seule qui sert à relire d'anciens compteurs (dire laquelle dans la PR) ;",
  'prix à reprendre de la page officielle du jour, avec la date de relevé (au 2026-10-28 : Haiku 5.5 0,10/0,50 $, Sonnet 5.5 2/10 $, Opus 5.5 4/20 $ par million de jetons, lecture du cache ×0,05).',
];

/** La section commence à son titre en gras et finit au titre en gras suivant. */
function extraireSection(contenu, titre) {
  const debut = contenu.indexOf(`**${titre}**`);
  assert.notEqual(debut, -1, `La section « ${titre} » doit exister`);
  const suite = contenu.slice(debut + titre.length + 4);
  const fin = suite.search(/\n\*\*[^*\n]+\*\*/);
  return fin === -1 ? suite : suite.slice(0, fin);
}

test('le fichier gabarit de migration existe', () => {
  assert.ok(fs.existsSync(GABARIT_PATH), 'Le fichier docs/gabarits/migration-modele.md doit exister');
});

test('le gabarit contient chacune des 4 variables au moins une fois', () => {
  const contenu = fs.readFileSync(GABARIT_PATH, 'utf8');
  for (const variable of ['{{app}}', '{{ancien}}', '{{nouveau}}', '{{famille}}']) {
    assert.ok(contenu.includes(variable), `La variable ${variable} doit être présente dans le gabarit`);
  }
});

test('le gabarit a toutes les sections attendues', () => {
  const contenu = fs.readFileSync(GABARIT_PATH, 'utf8');
  for (const titre of SECTIONS) {
    assert.ok(contenu.includes(`**${titre}**`), `La section « ${titre} » doit être présente`);
  }
});

test('la section « À surveiller » reprend EXACTEMENT les dix points, dans l\'ordre, sans point en plus', () => {
  const contenu = fs.readFileSync(GABARIT_PATH, 'utf8');
  const section = extraireSection(contenu, 'À surveiller');
  const points = section
    .split('\n')
    .filter((ligne) => ligne.startsWith('- '))
    .map((ligne) => ligne.slice(2));
  assert.deepEqual(points, POINTS_ATTENDUS);
});
