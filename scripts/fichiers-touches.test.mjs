import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aLaLigne, composerBloc, estimer, completerDepot, testsCandidats, arbreDe, sansBloc, estNonDeterminee, MARQUEUR, PAR_TOUR_MAX, CITES_MAX, HOMONYMES_MAX } from './fichiers-touches.mjs';
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
function github({ issues = [], prs = [], fichiers = ['app/tendances/page.tsx', 'docs/adr/0001.md', 'tests/tendances.test.ts'], relu = {}, arbre = false, tronque = false } = {}) {
  const appels = [];
  const gh = (methode, chemin, corps) => {
    appels.push({ methode, chemin, corps });
    if (methode === 'GET' && /\/issues\?state=open/.test(chemin)) return issues;
    if (methode === 'GET' && /\/pulls\?state=open/.test(chemin)) return prs;
    if (methode === 'GET' && /\/git\/trees\/HEAD\?recursive=1$/.test(chemin)) {
      if (!arbre) throw Object.assign(new Error('Command failed'), { stderr: 'gh: HTTP 502' });
      return { truncated: tronque, tree: fichiers.map((path) => ({ path, type: 'blob' })) };
    }
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

test('estimer : les chemins cités dans Avant / Après / Fini quand qui existent, plus leur test voisin ; Source (de quoi lire), un chemin inexistant, une URL et un nom de fonction sont ignorés', () => {
  const { gh } = github({ fichiers: ['app/tendances/page.tsx', 'docs/adr/0001.md', 'app/tendances/page.test.tsx'] });
  const e = estimer({ depot: 'MoKarade/CarAI', corps: CORPS(), gh });
  assert.deepEqual(e.fichiers, ['app/tendances/page.tsx', 'app/tendances/page.test.tsx'], '`docs/adr/0001.md` n\'est cité que dans Source');
});

test('estimer : un corps sans Avant / Après / Fini quand est lu en entier ; BACKLOG.md, HANDOVER.md, CLAUDE.md, README.md ne comptent jamais', () => {
  const corps = 'Corriger `lib/a.ts` (voir BACKLOG.md, HANDOVER.md, `CLAUDE.md` et README.md).';
  const { gh } = github({ fichiers: ['lib/a.ts', 'BACKLOG.md', 'HANDOVER.md', 'CLAUDE.md', 'README.md'] });
  assert.deepEqual(estimer({ depot: 'MoKarade/CarAI', corps, gh }).fichiers, ['lib/a.ts']);
  const seulementSuivi = estimer({ depot: 'MoKarade/CarAI', corps: '**Avant** : voir `BACKLOG.md:L381`.', gh });
  assert.deepEqual(seulementSuivi.fichiers, [], 'un fichier de suivi seul ne dit rien : non déterminés plutôt qu\'une fausse certitude');
});

test('estimer : le test voisin sous tests/ quand il n\'est pas à côté ; aucun test existant = rien d\'ajouté', () => {
  assert.deepEqual(estimer({ depot: 'MoKarade/CarAI', corps: CORPS(), gh: github().gh }).fichiers, ['app/tendances/page.tsx', 'tests/tendances.test.ts']);
  assert.deepEqual(estimer({ depot: 'MoKarade/CarAI', corps: CORPS(), gh: github({ fichiers: ['app/tendances/page.tsx'] }).gh }).fichiers, ['app/tendances/page.tsx']);
});

test('estimer : aucun chemin existant, motif ou trop de chemins cités = non déterminés, avec la raison', () => {
  const rien = estimer({ depot: 'MoKarade/CarAI', corps: CORPS(), gh: github({ fichiers: [] }).gh });
  assert.deepEqual(rien.fichiers, []);
  assert.match(rien.raison, /aucun chemin de fichier existant/);
  const motif = estimer({ depot: 'MoKarade/CarAI', corps: '**Avant** : `lib/*.ts`', gh: github().gh });
  assert.match(motif.raison, /motif de fichiers/);
  const noms = Array.from({ length: CITES_MAX + 1 }, (_, i) => `lib/f${i}.ts`);
  const beaucoup = noms.map((n) => `\`${n}\``).join(' ');
  assert.match(estimer({ depot: 'MoKarade/CarAI', corps: beaucoup, gh: github({ fichiers: noms }).gh }).raison, /plus de 10 fichiers cités/);
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
    tache(2, { body: `**Avant** : rien de cité.\n${composerBloc({ fichiers: [] })}` }),
    tache(3, { labels: ['niveau:tâche', 'en-cours'] }),
    tache(4, { labels: ['niveau:tâche', 'jules'] }),
    tache(5, { labels: ['niveau:tâche', 'preuve-attendue'] }),
    tache(6, { labels: ['niveau:tâche', 'qui:marc'] }),
    tache(10, { labels: ['niveau:tâche', 'preuve-manquante'] }),
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

// --- Estimation améliorée : arbre du dépôt, noms de fichier seuls, recalcul des « non déterminés » ---
const ARBRE = new Set(['scripts/prochaine-tache.mjs', 'scripts/capacite.mjs', 'outils/gantt-pc/fetch.py', 'docs/cycle-de-vie-tache.md', 'src/a/index.ts', 'src/b/index.ts', 'src/c/index.ts', 'src/d/index.ts', 'README.md']);

test('estimer avec l\'arbre : un chemin en clair, un nom de fichier seul et le test voisin sont trouvés sans lecture par chemin', () => {
  const arbre = new Set([...ARBRE, 'scripts/capacite.test.mjs']);
  const gh = () => { throw new Error('aucune lecture par chemin attendue'); };
  const e = estimer({ depot: 'MoKarade/.github', titre: 'Corriger fetch.py', corps: '**Avant** : voir scripts/capacite.mjs et `docs/cycle-de-vie-tache.md`.', gh, arbre });
  assert.deepEqual(e.fichiers, ['outils/gantt-pc/fetch.py', 'scripts/capacite.mjs', 'docs/cycle-de-vie-tache.md', 'scripts/capacite.test.mjs'], 'titre d\'abord, puis le corps, puis les tests voisins');
});

test('estimer : un nom de fichier seul ambigu (plus de 3 homonymes), une URL, un chemin absolu et un nom inexistant sont ignorés', () => {
  const corps = 'Voir `index.ts`, https://github.com/MoKarade/.github/blob/main/scripts/capacite.mjs, /scripts/capacite.mjs, fantome.py et ok.mjs.';
  const e = estimer({ depot: 'MoKarade/.github', corps, gh: () => { throw new Error('non'); }, arbre: ARBRE });
  assert.deepEqual(e.fichiers, []);
  assert.equal(HOMONYMES_MAX, 3);
  assert.deepEqual(estimer({ depot: 'MoKarade/.github', corps: 'Voir `index.ts`.', gh: () => { throw new Error('non'); }, arbre: new Set(['a/index.ts', 'b/index.ts']) }).fichiers, ['a/index.ts', 'b/index.ts'], 'jusqu\'à trois homonymes : tous comptent');
});

test('estimer : sans arbre, un nom seul ne se résout qu\'à la racine ; un motif refuse toujours', () => {
  const { gh } = github({ fichiers: ['fetch.py', 'lib/a.ts'] });
  assert.deepEqual(estimer({ depot: 'MoKarade/CarAI', corps: 'Corriger fetch.py et lib/a.ts', gh }).fichiers, ['fetch.py', 'lib/a.ts']);
  assert.match(estimer({ depot: 'MoKarade/CarAI', corps: 'Tout `lib/*.ts`', gh, arbre: ARBRE }).raison, /motif/);
});

test('arbreDe : l\'ensemble des fichiers, null si l\'arbre est tronqué ou illisible', () => {
  assert.deepEqual([...arbreDe(github({ arbre: true, fichiers: ['a.ts', 'b/c.ts'] }).gh, 'MoKarade/CarAI')], ['a.ts', 'b/c.ts']);
  assert.equal(arbreDe(github({ arbre: true, tronque: true }).gh, 'MoKarade/CarAI'), null);
  assert.equal(arbreDe(github().gh, 'MoKarade/CarAI'), null);
});

test('completerDepot : un « non déterminés » devient une estimation quand la tâche cite enfin un fichier existant, sans budget', () => {
  const ancien = `**Avant** : rien de cité.\n\n${composerBloc({ fichiers: [] })}`;
  const t = tache(10, { body: `${ancien.replace('rien de cité', 'voir `app/tendances/page.tsx`')}` });
  assert.ok(estNonDeterminee(t.body));
  const { gh, ecrits } = github({ issues: [t], arbre: true });
  const budget = { restant: 0 };
  const r = completerDepot({ depot: 'MoKarade/CarAI', gh, budget });
  assert.deepEqual(r.recalculees.map((x) => x.ref), ['CarAI#10']);
  assert.deepEqual(r.ecrites, []);
  const corps = ecrits()[0].corps.body;
  assert.equal((corps.match(/<!-- fichiers-auto -->/g) ?? []).length, 1, 'l\'ancien bloc est remplacé, pas doublé');
  assert.ok(corps.startsWith('**Avant** : voir `app/tendances/page.tsx`.'));
  assert.deepEqual(fichiersDeclares(corps), ['app/tendances/page.tsx', 'tests/tendances.test.ts']);
  assert.equal(budget.restant, 0);
});

test('completerDepot : un « non déterminés » qui ne cite toujours rien n\'est pas réécrit ; une ligne écrite par un fil non plus', () => {
  const sans = tache(10, { body: `**Avant** : rien.\n\n${composerBloc({ fichiers: [] })}` });
  const fil = tache(11, { body: `${CORPS()}\n\n${composerBloc({ fichiers: [] })}\n**Fichiers touchés** :\n- \`lib/x.ts\`\n` });
  assert.equal(estNonDeterminee(fil.body), false, 'deux lignes : celle du fil gagne, rien à recalculer');
  const { gh, ecrits } = github({ issues: [sans, fil], arbre: true });
  const r = completerDepot({ depot: 'MoKarade/CarAI', gh });
  assert.deepEqual([r.ecrites, r.recalculees], [[], []]);
  assert.deepEqual(ecrits(), []);
  assert.equal(sansBloc(`a\n\n${composerBloc({ fichiers: [] })}`), 'a');
});

test('completerDepot : avec l\'arbre, une seule lecture de l\'arbre pour toutes les tâches du dépôt', () => {
  const { gh, appels } = github({ issues: [tache(10), tache(11), tache(12)], arbre: true });
  assert.equal(completerDepot({ depot: 'MoKarade/CarAI', gh }).ecrites.length, 3);
  assert.equal(appels.filter((a) => /git\/trees/.test(a.chemin)).length, 1);
  assert.equal(appels.some((a) => /\/contents\//.test(a.chemin)), false, 'aucune lecture par chemin');
});

test('tourFichiersTouches : les « non déterminés » devenues estimées sont comptées sur la ligne', () => {
  const t = tache(10, { body: `**Avant** : voir \`app/tendances/page.tsx\`.\n\n${composerBloc({ fichiers: [] })}` });
  const { gh } = github({ issues: [t], arbre: true });
  assert.match(tourFichiersTouches({ executer: true, gh, depots: ['MoKarade/CarAI'] }), /^fichiers-touches : 0 écrite\(s\), 1 non déterminée\(s\) devenue\(s\) estimée\(s\) \(CarAI#10\)$/);
});

test('une phrase qui parle de la ligne ou du marqueur n\'est pas la ligne : la tâche est complétée quand même', () => {
  const prose = '**Avant** : voir `app/tendances/page.tsx`. Le filet ajoute un bloc `<!-- fichiers-auto -->` avec la ligne « **Fichiers touchés** ».';
  assert.equal(aLaLigne(prose), false);
  assert.equal(aLaLigne(`${prose}\n\n${composerBloc({ fichiers: ['a.ts'] })}`), true);
  assert.equal(aLaLigne('x\n**Fichiers touchés** : non déterminés (raison).\n'), true);
  assert.equal(sansBloc(`${prose}\n\n${composerBloc({ fichiers: ['a.ts'] })}`), prose, 'seul le vrai bloc, à la fin, est retiré');
  const t = tache(10, { body: prose });
  const { gh, ecrits } = github({ issues: [t], arbre: true });
  assert.equal(completerDepot({ depot: 'MoKarade/CarAI', gh }).ecrites.length, 1);
  assert.equal(ecrits().length, 1);
});
