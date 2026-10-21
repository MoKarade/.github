import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aLaLigne, composerBloc, estimer, completerDepot, testsCandidats, MARQUEUR, PAR_TOUR_MAX, CITES_MAX } from './fichiers-touches.mjs';
import { fichiersDeclares } from './capacite.mjs';
import { tourFichiersTouches } from './filet-pc.mjs';

const CORPS = (extra = '') => `**Avant** : \`app/tendances/page.tsx\` place la carte en haut.

**Après** : la consommation passe en premier.

**Fini quand** : un test verrouille l'ordre.

**Source** : \`docs/adr/0001.md\`, \`BACKLOG.md:L381\`, \`/tendances\`.

**Attend** : rien.
${extra}`;

const tache = (n, { body = CORPS(), labels = ['niveau:tâche', 'prio:2'], updated = '2026-10-21T10:00:00Z' } = {}) =>
  ({ number: n, title: `Tâche ${n}`, body, labels: labels.map((name) => ({ name })), updated_at: updated });

/** Un dépôt simulé : `fichiers` existent ; garde les PATCH ; `apres` rend le corps relu avant l'écriture. */
function github({ issues = [], prs = [], fichiers = ['app/tendances/page.tsx', 'docs/adr/0001.md', 'tests/tendances.test.ts'], relu = {} } = {}) {
  const appels = [];
  const gh = (methode, chemin, corps) => {
    appels.push({ methode, chemin, corps });
    if (methode === 'GET' && /\/issues\?state=open/.test(chemin)) return issues;
    if (methode === 'GET' && /\/pulls\?state=open/.test(chemin)) return prs;
    const c = /\/contents\/(.+)$/.exec(chemin);
    if (methode === 'GET' && c) {
      const p = decodeURIComponent(c[1]);
      if (fichiers.includes(p)) return { type: 'file', path: p };
      throw Object.assign(new Error('Command failed'), { stderr: 'gh: Not Found (HTTP 404)' });
    }
    const n = /\/issues\/(\d+)$/.exec(chemin);
    if (methode === 'GET' && n) return relu[n[1]] ?? issues.find((i) => i.number === Number(n[1]));
    if (methode === 'PATCH') return {};
    throw new Error(`appel inattendu ${methode} ${chemin}`);
  };
  return { gh, appels, ecrits: () => appels.filter((a) => a.methode === 'PATCH') };
}

test('estimer : les chemins cités qui existent, plus leur test voisin ; un chemin inexistant, une URL et un nom de fonction sont ignorés', () => {
  const { gh } = github({ fichiers: ['app/tendances/page.tsx', 'docs/adr/0001.md', 'app/tendances/page.test.tsx'] });
  const e = estimer({ depot: 'MoKarade/CarAI', corps: CORPS(), gh });
  assert.deepEqual(e.fichiers, ['app/tendances/page.tsx', 'docs/adr/0001.md', 'app/tendances/page.test.tsx']);
});

test('estimer : le test voisin sous tests/ quand il n\'est pas à côté ; aucun test existant = rien d\'ajouté', () => {
  assert.deepEqual(estimer({ depot: 'MoKarade/CarAI', corps: CORPS(), gh: github().gh }).fichiers, ['app/tendances/page.tsx', 'docs/adr/0001.md', 'tests/tendances.test.ts']);
  assert.deepEqual(estimer({ depot: 'MoKarade/CarAI', corps: CORPS(), gh: github({ fichiers: ['app/tendances/page.tsx'] }).gh }).fichiers, ['app/tendances/page.tsx']);
});

test('estimer : aucun chemin existant, motif ou trop de chemins cités = non déterminés, avec la raison', () => {
  const rien = estimer({ depot: 'MoKarade/CarAI', corps: CORPS(), gh: github({ fichiers: [] }).gh });
  assert.deepEqual(rien.fichiers, []);
  assert.match(rien.raison, /aucun chemin de fichier existant/);
  const motif = estimer({ depot: 'MoKarade/CarAI', corps: '**Avant** : `lib/*.ts`', gh: github().gh });
  assert.match(motif.raison, /motif de fichiers/);
  const beaucoup = Array.from({ length: CITES_MAX + 1 }, (_, i) => `\`lib/f${i}.ts\``).join(' ');
  assert.match(estimer({ depot: 'MoKarade/CarAI', corps: beaucoup, gh: github().gh }).raison, /plus de 10 chemins/);
});

test('estimer : une erreur autre que « introuvable » remonte, rien n\'est deviné', () => {
  const gh = () => { throw Object.assign(new Error('Command failed'), { stderr: 'gh: HTTP 502' }); };
  assert.throws(() => estimer({ depot: 'MoKarade/CarAI', corps: CORPS(), gh }), /Command failed/);
});

test('testsCandidats : à côté et sous tests/ (préfixe web/ ou app/) ; un test lui-même n\'en a pas', () => {
  assert.deepEqual(testsCandidats('scripts/x.mjs'), ['scripts/x.test.mjs', 'tests/x.test.mjs']);
  assert.deepEqual(testsCandidats('web/lib/format.ts'), ['web/lib/format.test.ts', 'tests/format.test.ts', 'web/tests/format.test.ts']);
  assert.deepEqual(testsCandidats('app/tendances/page.tsx'), ['app/tendances/page.test.tsx', 'app/tendances/page.test.ts', 'tests/tendances.test.tsx', 'tests/tendances.test.ts', 'app/tests/tendances.test.tsx', 'app/tests/tendances.test.ts']);
  assert.deepEqual(testsCandidats('scripts/x.test.mjs'), []);
  assert.deepEqual(testsCandidats('docs/a.md'), []);
});

test('composerBloc : la liste estimée se relit par capacite.mjs ; « non déterminés » ne déclare rien', () => {
  const bloc = composerBloc({ fichiers: ['a/b.ts', 'tests/b.test.ts'] });
  assert.ok(bloc.startsWith(MARQUEUR));
  assert.match(bloc, /estimation automatique/);
  assert.deepEqual(fichiersDeclares(bloc), ['a/b.ts', 'tests/b.test.ts']);
  const inconnu = composerBloc({ fichiers: [], raison: 'aucun chemin' });
  assert.match(inconnu, /non déterminés \(aucun chemin\)/);
  assert.equal(fichiersDeclares(inconnu), null);
});

test('« Fichiers permis » exact l\'emporte sur l\'estimation, quel que soit l\'ordre', () => {
  const estimation = composerBloc({ fichiers: ['lib/large.ts', 'lib/autre.ts'] });
  const permis = '**Fichiers permis** (aucun autre) :\n- `lib/exact.ts`\n';
  assert.deepEqual(fichiersDeclares(`${CORPS()}\n${estimation}\n${permis}`), ['lib/exact.ts']);
  assert.deepEqual(fichiersDeclares(`${CORPS()}\n${permis}\n${estimation}`), ['lib/exact.ts']);
});

test('completerDepot : écrit à la fin du corps, sans toucher au texte existant, et relit le corps juste avant', () => {
  const t = tache(10);
  const { gh, ecrits } = github({ issues: [t] });
  const r = completerDepot({ depot: 'MoKarade/CarAI', gh });
  assert.deepEqual(r.ecrites.map((x) => x.ref), ['CarAI#10']);
  const [patch] = ecrits();
  assert.ok(patch.corps.body.startsWith(t.body.replace(/\s+$/, '')));
  assert.ok(patch.corps.body.includes(`${MARQUEUR}\n**Fichiers touchés**`));
  assert.ok(aLaLigne(patch.corps.body));
});

test('completerDepot : ne touche ni une tâche qui a déjà la ligne, ni en-cours/jules/preuve-attendue/qui:marc, ni une tâche citée par une PR ouverte', () => {
  const issues = [
    tache(1, { body: `${CORPS()}\n**Fichiers permis** (aucun autre) :\n- \`a.ts\`\n` }),
    tache(2, { body: `${CORPS()}\n${composerBloc({ fichiers: [] })}` }),
    tache(3, { labels: ['niveau:tâche', 'en-cours'] }),
    tache(4, { labels: ['niveau:tâche', 'jules'] }),
    tache(5, { labels: ['niveau:tâche', 'preuve-attendue'] }),
    tache(6, { labels: ['niveau:tâche', 'qui:marc'] }),
    tache(7),
    { ...tache(8), labels: [{ name: 'niveau:mission' }] },
    { ...tache(9), pull_request: {} },
  ];
  const { gh, ecrits } = github({ issues, prs: [{ number: 50, body: 'Tâche : #7', title: 'feat: x' }] });
  const r = completerDepot({ depot: 'MoKarade/CarAI', gh });
  assert.deepEqual(r.ecrites, []);
  assert.deepEqual(ecrits(), []);
});

test('completerDepot : par priorité puis numéro, dans la limite du budget partagé entre dépôts', () => {
  const issues = [tache(30, { labels: ['niveau:tâche', 'prio:3'] }), tache(20), tache(10)];
  const { gh } = github({ issues });
  const budget = { restant: 2 };
  const r = completerDepot({ depot: 'MoKarade/CarAI', gh, budget });
  assert.deepEqual(r.ecrites.map((x) => x.ref), ['CarAI#10', 'CarAI#20']);
  assert.equal(budget.restant, 0);
  assert.deepEqual(completerDepot({ depot: 'MoKarade/CarAI', gh, budget }).ecrites, []);
});

test('completerDepot : un fil qui a édité la tâche entre la liste et l\'écriture n\'est pas écrasé', () => {
  const t = tache(10);
  const { gh, ecrits } = github({ issues: [t], relu: { 10: { ...t, updated_at: '2026-10-21T10:00:05Z', body: `${t.body}\nmodifié` } } });
  assert.deepEqual(completerDepot({ depot: 'MoKarade/CarAI', gh }).ecrites, []);
  assert.deepEqual(ecrits(), []);
});

test('completerDepot : à blanc, rien n\'est écrit mais la tâche est comptée', () => {
  const { gh, ecrits } = github({ issues: [tache(10)] });
  const r = completerDepot({ depot: 'MoKarade/CarAI', gh, aBlanc: true });
  assert.equal(r.ecrites.length, 1);
  assert.deepEqual(ecrits(), []);
});

test('tourFichiersTouches : une ligne qui dit combien de tâches sont estimées ou non déterminées ; non appliqué sans --executer ; un dépôt illisible est dit', () => {
  const issues = [tache(10), tache(11, { body: '**Avant** : rien de cité.' })];
  const { gh, ecrits } = github({ issues });
  const l = tourFichiersTouches({ executer: true, gh, depots: ['MoKarade/CarAI'] });
  assert.match(l, /^fichiers-touches : 2 écrite\(s\) \(1 estimée\(s\), 1 non déterminée\(s\) : CarAI#10, CarAI#11\)$/);
  assert.equal(ecrits().length, 2);
  const seche = github({ issues });
  assert.match(tourFichiersTouches({ gh: seche.gh, depots: ['MoKarade/CarAI'] }), /\(non appliqué\)/);
  assert.equal(seche.ecrits().length, 0);
  const casse = () => { throw new Error('HTTP 502'); };
  assert.match(tourFichiersTouches({ executer: true, gh: casse, depots: ['MoKarade/CarAI'] }), /ÉCHEC CarAI \(HTTP 502\)/);
  assert.equal(PAR_TOUR_MAX, 8);
});
