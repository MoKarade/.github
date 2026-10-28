import test from 'node:test';
import assert from 'node:assert/strict';
import {
  modelesAMigrer,
  familleDuModele,
  cleBaseModele,
  versionDuModele,
  estPlusRecent,
  genererCorpsTache,
  cheminCompte,
  idsDansTexte,
  lireListeModelesAnthropic,
  rechercherModelesApp,
  lireTachesApp,
  ouvrirTacheMigration,
  executer,
  PARENT_MISSION,
} from '../scripts/modeles-nouveaux.mjs';

const GABARIT = 'Tâche pour {{app}} : {{ancien}} → {{nouveau}} ({{famille}})';

const reponse = (status, json) => ({ ok: status >= 200 && status < 300, status, json: async () => json });

test('familleDuModele identifie correctement haiku, sonnet et opus', () => {
  assert.equal(familleDuModele('claude-3-5-sonnet-20241022'), 'sonnet');
  assert.equal(familleDuModele('claude-3-haiku-20240307'), 'haiku');
  assert.equal(familleDuModele('claude-3-opus-20240229'), 'opus');
  assert.equal(familleDuModele('claude-sonnet-5-5'), 'sonnet');
  assert.equal(familleDuModele('gpt-4o'), null);
});

test('cleBaseModele normalise un alias flottant et son instantané daté', () => {
  assert.equal(cleBaseModele('claude-3-5-sonnet-20241022'), 'claude-3-5-sonnet');
  assert.equal(cleBaseModele('claude-3-5-sonnet-latest'), 'claude-3-5-sonnet');
  assert.equal(cleBaseModele('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
});

test('versionDuModele lit la version, quel que soit l’ordre famille / numéro', () => {
  assert.deepEqual(versionDuModele('claude-3-5-sonnet-20241022'), [3, 5]);
  assert.deepEqual(versionDuModele('claude-sonnet-5-5'), [5, 5]);
  assert.deepEqual(versionDuModele('claude-opus-4-1-20250805'), [4, 1]);
  assert.deepEqual(versionDuModele('claude-sonnet-4'), [4]);
});

test('estPlusRecent compare deux modèles selon leur version', () => {
  assert.equal(estPlusRecent('claude-3-5-sonnet-20241022', 'claude-3-7-sonnet-20250219'), true);
  assert.equal(estPlusRecent('claude-3-7-sonnet-20250219', 'claude-3-5-sonnet-20241022'), false);
  assert.equal(estPlusRecent('claude-3-5-sonnet-20241022', 'claude-3-5-sonnet-latest'), false);
  assert.equal(estPlusRecent('claude-3-7-sonnet-20250219', 'claude-sonnet-4'), true);
  assert.equal(estPlusRecent('claude-sonnet-4', 'claude-sonnet-4-5'), true);
});

test('un 5.5 sans date est plus récent qu’un 4.5 daté (une date ne doit jamais l’emporter sur la version)', () => {
  assert.equal(estPlusRecent('claude-haiku-4-5-20251001', 'claude-haiku-5-5'), true);
  assert.equal(estPlusRecent('claude-haiku-5-5', 'claude-haiku-4-5-20251001'), false);
});

test('genererCorpsTache remplace toutes les variables du gabarit et inclut la mission', () => {
  const corps = genererCorpsTache(
    { app: 'emploi', ancien: 'claude-3-5-sonnet-20241022', nouveau: 'claude-3-7-sonnet-20250219', famille: 'sonnet' },
    GABARIT,
  );
  assert.ok(corps.includes('emploi'));
  assert.ok(corps.includes('claude-3-5-sonnet-20241022'));
  assert.ok(corps.includes('claude-3-7-sonnet-20250219'));
  assert.ok(corps.includes('sonnet'));
  assert.ok(!corps.includes('{{'));
  assert.ok(corps.includes(PARENT_MISSION));
});

const LISTE = [{ id: 'claude-3-5-sonnet-20241022' }, { id: 'claude-3-7-sonnet-20250219' }];
const app = (utilises, ouvertes = []) => [{ nom: 'emploi', depot: 'MoKarade/JobAI', utilises, ouvertes }];

test('1. un plus récent dans une famille utilisée donne une tâche', () => {
  const r = modelesAMigrer(LISTE, app(['claude-3-5-sonnet-20241022']));
  assert.equal(r.length, 1);
  assert.equal(r[0].app, 'emploi');
  assert.equal(r[0].depot, 'MoKarade/JobAI');
  assert.equal(r[0].ancien, 'claude-3-5-sonnet-20241022');
  assert.equal(r[0].nouveau, 'claude-3-7-sonnet-20250219');
  assert.equal(r[0].famille, 'sonnet');
  assert.equal(r[0].titre, 'Migration de emploi vers le modèle claude-3-7-sonnet-20250219');
  assert.deepEqual(r[0].labels, ['niveau:tâche']);
});

test('1 bis. la génération 5.5 sans date remplace un 4.5 daté', () => {
  const r = modelesAMigrer([{ id: 'claude-haiku-4-5-20251001' }, { id: 'claude-haiku-5-5' }], app(['claude-haiku-4-5-20251001']));
  assert.equal(r.length, 1);
  assert.equal(r[0].nouveau, 'claude-haiku-5-5');
});

test('2. aucun plus récent donne rien', () => {
  assert.equal(modelesAMigrer([{ id: 'claude-3-5-sonnet-20241022' }], app(['claude-3-5-sonnet-20241022'])).length, 0);
});

test('3. une famille non utilisée par l’app donne rien', () => {
  const liste = [{ id: 'claude-3-opus-20240229' }, { id: 'claude-opus-5-5' }];
  assert.equal(modelesAMigrer(liste, app(['claude-3-5-sonnet-20241022'])).length, 0);
});

test('4. une tâche déjà faite pour le même modèle ne donne pas de doublon, qu’elle soit ouverte ou fermée', () => {
  const titre = 'Migration de emploi vers le modèle claude-3-7-sonnet-20250219';
  assert.equal(modelesAMigrer(LISTE, app(['claude-3-5-sonnet-20241022'], [titre])).length, 0);
  assert.equal(modelesAMigrer(LISTE, app(['claude-3-5-sonnet-20241022'], [{ title: titre }])).length, 0);
});

test('5. un alias flottant et son instantané daté sont comptés comme le même modèle', () => {
  assert.equal(modelesAMigrer([{ id: 'claude-3-5-sonnet-latest' }], app(['claude-3-5-sonnet-20241022'])).length, 0);
});

test('6. une app qui utilise déjà le plus récent ne reçoit rien', () => {
  assert.equal(modelesAMigrer(LISTE, app(['claude-3-5-sonnet-20241022', 'claude-3-7-sonnet-20250219'])).length, 0);
});

test('cheminCompte écarte les tests, les docs et les journaux de changement', () => {
  assert.equal(cheminCompte('lib/llm/modele.ts'), true);
  assert.equal(cheminCompte('web/lib/llmUsage.ts'), true);
  assert.equal(cheminCompte('tests/modeleChoisi.test.ts'), false);
  assert.equal(cheminCompte('web/tests/x.ts'), false);
  assert.equal(cheminCompte('docs/claude/09-variables.md'), false);
  assert.equal(cheminCompte('HANDOVER.md'), false);
  assert.equal(cheminCompte('services/prix.test.ts'), false);
});

test('idsDansTexte lit les identifiants sans la ponctuation de fin et ignore ce qui n’est pas un modèle', () => {
  assert.deepEqual(idsDansTexte('const m = "claude-sonnet-5-5"; // voir claude-haiku-5-5. et claude-code'), ['claude-sonnet-5-5', 'claude-haiku-5-5']);
});

test('une liste de modèles illisible fait échouer le script, sans tâche inventée', async () => {
  await assert.rejects(lireListeModelesAnthropic({ apiKey: undefined }), /clé API absente/);
  await assert.rejects(lireListeModelesAnthropic({ apiKey: 'x', fetchFn: async () => reponse(401, {}) }), /HTTP 401/);
  await assert.rejects(lireListeModelesAnthropic({ apiKey: 'x', fetchFn: async () => reponse(200, { autre: 1 }) }), /sans liste/);
});

test('une recherche de code ou une lecture d’issues en échec n’est pas avalée', async () => {
  await assert.rejects(rechercherModelesApp({ depot: 'MoKarade/JobAI', fetchFn: async () => reponse(403, {}) }), /HTTP 403/);
  await assert.rejects(lireTachesApp({ depot: 'MoKarade/JobAI', fetchFn: async () => reponse(500, {}) }), /HTTP 500/);
});

test('une erreur HTTP porte le message de GitHub (accès refusé ou limite de débit)', async () => {
  const fetchFn = async () => reponse(403, { message: 'Resource not accessible by personal access token' });
  await assert.rejects(rechercherModelesApp({ depot: 'MoKarade/FinanceAI', fetchFn }), /HTTP 403 : Resource not accessible/);
});

test('rechercherModelesApp ne compte que les fichiers de code', async () => {
  const items = [
    { path: 'lib/llm/modele.ts', text_matches: [{ fragment: 'const M = "claude-haiku-4-5-20251001";' }] },
    { path: 'tests/modeleChoisi.test.ts', text_matches: [{ fragment: 'refuse "claude-sonnet-4"' }] },
    { path: 'CHANGELOG.md', text_matches: [{ fragment: 'retiré claude-opus-4-1' }] },
  ];
  const ids = await rechercherModelesApp({ depot: 'MoKarade/JobAI', ghToken: 't', fetchFn: async () => reponse(200, { items }) });
  assert.deepEqual(ids, ['claude-haiku-4-5-20251001']);
});

test('lireTachesApp ne rend que les issues, pas les PR', async () => {
  const json = [{ title: 'Migration de x vers le modèle y' }, { title: 'PR', pull_request: {} }];
  const taches = await lireTachesApp({ depot: 'MoKarade/JobAI', fetchFn: async () => reponse(200, json) });
  assert.deepEqual(taches, [{ title: 'Migration de x vers le modèle y' }]);
});

test('executer en essai à blanc rend 1 tâche et ne fait aucun POST', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const appels = [];
  globalThis.fetch = async (url, options = {}) => {
    appels.push({ url, options });
    if (url.startsWith('https://api.anthropic.com/')) {
      return reponse(200, { data: [{ id: 'claude-sonnet-5-5' }, { id: 'claude-3-5-sonnet-20241022' }] });
    }
    if (url.includes('search/code')) {
      return reponse(200, {
        items: [{ path: 'src/llm.js', text_matches: [{ fragment: 'const m = "claude-3-5-sonnet-20241022";' }] }],
      });
    }
    if (url.includes('/issues')) {
      return reponse(200, []);
    }
    return reponse(404, {});
  };

  const aOuvrir = await executer({
    aBlanc: true,
    apps: [{ nom: 'emploi', depot: 'MoKarade/JobAI' }],
    apiKey: 'test-key',
    ghToken: 'test-token',
    pause: async () => {},
  });

  assert.equal(aOuvrir.length, 1);
  const posts = appels.filter((a) => a.options?.method?.toUpperCase() === 'POST');
  assert.equal(posts.length, 0);
});

test('executer en passage réel ouvre exactement 1 issue avec le bon titre et labels', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const appels = [];
  globalThis.fetch = async (url, options = {}) => {
    appels.push({ url, options });
    if (url.startsWith('https://api.anthropic.com/')) {
      return reponse(200, { data: [{ id: 'claude-sonnet-5-5' }, { id: 'claude-3-5-sonnet-20241022' }] });
    }
    if (url.includes('search/code')) {
      return reponse(200, {
        items: [{ path: 'src/llm.js', text_matches: [{ fragment: 'const m = "claude-3-5-sonnet-20241022";' }] }],
      });
    }
    if (url.includes('/issues') && options.method?.toUpperCase() !== 'POST') {
      return reponse(200, []);
    }
    if (url === 'https://api.github.com/repos/MoKarade/JobAI/issues' && options.method?.toUpperCase() === 'POST') {
      return reponse(201, { id: 1 });
    }
    return reponse(404, {});
  };

  const aOuvrir = await executer({
    aBlanc: false,
    apps: [{ nom: 'emploi', depot: 'MoKarade/JobAI' }],
    apiKey: 'test-key',
    ghToken: 'test-token',
    pause: async () => {},
  });

  assert.equal(aOuvrir.length, 1);
  const posts = appels.filter((a) => a.options?.method?.toUpperCase() === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'https://api.github.com/repos/MoKarade/JobAI/issues');
  const body = JSON.parse(posts[0].options.body);
  assert.equal(body.title, 'Migration de emploi vers le modèle claude-sonnet-5-5');
  assert.deepEqual(body.labels, ['niveau:tâche']);
});

test('executer ne fait aucun POST si l’issue existe déjà même fermée', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const appels = [];
  globalThis.fetch = async (url, options = {}) => {
    appels.push({ url, options });
    if (url.startsWith('https://api.anthropic.com/')) {
      return reponse(200, { data: [{ id: 'claude-sonnet-5-5' }, { id: 'claude-3-5-sonnet-20241022' }] });
    }
    if (url.includes('search/code')) {
      return reponse(200, {
        items: [{ path: 'src/llm.js', text_matches: [{ fragment: 'const m = "claude-3-5-sonnet-20241022";' }] }],
      });
    }
    if (url.includes('/issues')) {
      return reponse(200, [{ title: 'Migration de emploi vers le modèle claude-sonnet-5-5', state: 'closed' }]);
    }
    return reponse(404, {});
  };

  const aOuvrir = await executer({
    aBlanc: false,
    apps: [{ nom: 'emploi', depot: 'MoKarade/JobAI' }],
    apiKey: 'test-key',
    ghToken: 'test-token',
    pause: async () => {},
  });

  assert.equal(aOuvrir.length, 0);
  const posts = appels.filter((a) => a.options?.method?.toUpperCase() === 'POST');
  assert.equal(posts.length, 0);
});

test('executer est rejeté si la liste Anthropic répond HTTP 401 et ne fait aucun POST', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const appels = [];
  globalThis.fetch = async (url, options = {}) => {
    appels.push({ url, options });
    return reponse(401, { message: 'Unauthorized' });
  };

  await assert.rejects(
    executer({
      aBlanc: false,
      apps: [{ nom: 'emploi', depot: 'MoKarade/JobAI' }],
      apiKey: 'test-key',
      ghToken: 'test-token',
      pause: async () => {},
    }),
    /HTTP 401/,
  );

  const posts = appels.filter((a) => a.options?.method?.toUpperCase() === 'POST');
  assert.equal(posts.length, 0);
});

test('ouvrirTacheMigration rejette si la réponse est HTTP 422', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => reponse(422, { message: 'Unprocessable Entity' });

  await assert.rejects(
    ouvrirTacheMigration({
      task: { depot: 'MoKarade/JobAI', titre: 'Migration', corps: 'corps', labels: ['niveau:tâche'] },
      ghToken: 'test-token',
    }),
    /HTTP 422/,
  );
});
