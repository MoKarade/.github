import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cheminsCites, deriverTest, composerBloc, completerDepot, MARQUEUR, PAR_JOUR_MAX } from './jules-gabarit.mjs';
import { evaluerJules } from './jules-auto.mjs';
import { tourJulesSuivi } from './filet-pc.mjs';

const CORPS = (extra = '') => `**Avant** : \`/tendances\` s'ouvre sur « Le véhicule » ; \`app/tendances/page.tsx\` (blocs \`colonnes-pc\`) place la carte en haut.

**Après** : la consommation passe en premier, la carte descend sous les courbes.

**Fini quand** : un test de rendu verrouille l'ordre et est vert sur le commit fusionné.

**Source** : réponses de Marc ; \`app/tendances/page.tsx:L40\`, \`BACKLOG.md:L381\`, \`docs/adr/0001.md\`.

**Attend** : rien (le frein de quota retient seulement le départ).
${extra}`;

const tache = (n, { body = CORPS(), labels = ['niveau:tâche', 'prio:2'], title = 'Mettre la consommation en haut de Tendances.', updated = '2026-10-19T10:00:00Z' } = {}) =>
  ({ number: n, title, body, labels: labels.map((name) => ({ name })), updated_at: updated });

/** Un dépôt simulé : `fichiers` existent, `dossiers` aussi ; lectures seules sauf PATCH/POST qu'il note. */
function github({ issues = [], prs = [], fichiers = ['app/tendances/page.tsx', 'docs/adr/0001.md'], dossiers = ['tests'], etats = {}, natives = {} } = {}) {
  const appels = [];
  const gh = (methode, chemin, corps) => {
    appels.push({ methode, chemin, corps });
    if (methode === 'GET' && /labels=faisable-jules/.test(chemin)) return issues.filter((i) => i.labels.some((l) => l.name === 'faisable-jules'));
    if (methode === 'GET' && /\/issues\?(labels=jules|state=closed)/.test(chemin)) return [];
    if (methode === 'GET' && /\/issues\?state=open/.test(chemin)) return issues;
    if (methode === 'GET' && /\/pulls\?state=open/.test(chemin)) return prs;
    const c = /\/contents\/(.+)$/.exec(chemin);
    if (methode === 'GET' && c) {
      const p = decodeURIComponent(c[1]);
      if (fichiers.includes(p)) return { type: 'file', path: p };
      if (dossiers.includes(p)) return [{ name: 'x' }];
      throw Object.assign(new Error('Command failed'), { stderr: 'gh: Not Found (HTTP 404)' });
    }
    const nat = /\/issues\/(\d+)\/dependencies\/blocked_by$/.exec(chemin);
    if (methode === 'GET' && nat) { const r = natives[nat[1]]; if (r === 'ERR') throw new Error('500'); return r ?? []; }
    const un = /repos\/MoKarade\/([\w.-]+)\/issues\/(\d+)$/.exec(chemin);
    if (methode === 'GET' && un) return { state: etats[`${un[1]}#${un[2]}`] ?? 'closed' };
    return {};
  };
  return { gh, appels };
}
const ecritures = (appels) => appels.filter((a) => a.methode !== 'GET');
const lancer = (g, o = {}) => completerDepot({ depot: 'MoKarade/FinanceAI', gh: g.gh, etat: {}, maintenant: new Date('2026-10-19T20:00:00Z'), ...o });

test('cheminsCites : les chemins à barre oblique, sans :Lnn ; ni noms de fonctions, ni URL, ni jetons sans barre', () => {
  const c = cheminsCites(CORPS());
  assert.deepEqual(c.forts, ['app/tendances/page.tsx']);
  assert.deepEqual(c.source, []); // page.tsx déjà fort, docs/adr/0001.md est un .md cité en Source seulement, BACKLOG.md n'a pas de barre
  assert.deepEqual(c.motifs, []);
});

test('cheminsCites : un motif à étoile est signalé, un .md de Avant/Après compte comme fort', () => {
  const c = cheminsCites('**Avant** : `app/**/*.tsx` et `docs/guide.md`.\n\n**Après** : x.\n\n**Fini quand** : y.\n\n**Source** : `lib/a.ts`.');
  assert.deepEqual(c.motifs, ['app/**/*.tsx']);
  assert.deepEqual(c.forts, ['docs/guide.md']);
  assert.deepEqual(c.source, ['lib/a.ts']);
});

test('deriverTest : tests/<nom>.test.ts, dossier pour page/route/index, préfixe de l\'app, extension suivie', () => {
  assert.equal(deriverTest('app/tendances/page.tsx'), 'tests/tendances.test.ts');
  assert.equal(deriverTest('lib/format.ts'), 'tests/format.test.ts');
  assert.equal(deriverTest('app/api/cron/route.ts'), 'tests/cron.test.ts');
  assert.equal(deriverTest('app/[id]/page.tsx'), 'tests/id.test.ts');
  assert.equal(deriverTest('web/lib/prix.ts', 'web/'), 'web/tests/prix.test.ts');
  assert.equal(deriverTest('lib/outil.mjs'), 'tests/outil.test.mjs');
  assert.equal(deriverTest('styles/a.css'), null);
});

test('composerBloc : un écran porte captures et theme.test ; un .md porte français et accents ; Hubperso cite HORS-BACKLOG', () => {
  const bloc = composerBloc({ n: 30, titre: 'Mettre la carte plus bas', depot: 'Hubperso', fichiers: ['app/a/page.tsx', 'docs/x.md', 'tests/a.test.ts'], nouveaux: ['tests/a.test.ts'], manquantes: ['Fichiers permis', 'À faire', 'À ne pas faire', 'Vérifier', 'À citer dans la PR'] });
  assert.match(bloc, /^<!-- gabarit-auto -->/);
  assert.match(bloc, /`tests\/a\.test\.ts` \(nouveau\)/);
  assert.match(bloc, /captures avant\/après/);
  assert.match(bloc, /tests\/theme\.test\.ts/);
  assert.match(bloc, /français, avec tous les accents/);
  assert.match(bloc, /`Tâche : #30`/);
  assert.match(bloc, /HORS-BACKLOG:/);
  assert.match(bloc, /titre `feat: mettre la carte plus bas`/);
  assert.doesNotMatch(bloc, /<[a-zA-ZÀ-ÿ][^>\n]*\s[^>\n]*>/);
});

test('composerBloc : « À ne pas faire » interdit de repousser un ancien arbre par-dessus main (incident FinanceAI#1269)', () => {
  const bloc = composerBloc({ n: 31, titre: 'Corriger un libellé', depot: 'FinanceAI', fichiers: ['lib/a.ts', 'tests/a.test.ts'], nouveaux: [], manquantes: ['À ne pas faire'] });
  assert.match(bloc, /pars de main à jour/);
  assert.match(bloc, /fusionne-le en gardant sa version des fichiers hors liste/);
  assert.match(bloc, /ne repousse jamais un ancien arbre/);
  assert.match(bloc, /`git diff origin\/main --stat` ne montre que les fichiers permis/);
});

test('une tâche écrite pour Claude est complétée : bloc ajouté APRÈS le texte existant, rien d\'autre modifié, commentaire posé', () => {
  const t = tache(30);
  const g = github({ issues: [t] });
  const etat = {};
  const r = lancer(g, { etat });
  assert.deepEqual(r.completees, ['FinanceAI#30']);
  const w = ecritures(g.appels);
  assert.equal(w.length, 2);
  assert.equal(w[0].methode, 'PATCH');
  assert.equal(w[0].chemin, 'repos/MoKarade/FinanceAI/issues/30');
  const corps = w[0].corps.body;
  assert.ok(corps.startsWith(t.body.replace(/\s+$/, '')), 'le texte existant est intact et en tête');
  assert.match(corps, /<!-- gabarit-auto -->\n\*\*Fichiers permis\*\*/);
  assert.match(corps, /- `app\/tendances\/page\.tsx`\n- `tests\/tendances\.test\.ts` \(nouveau\)/);
  assert.doesNotMatch(corps, /docs\/adr\/0001\.md\`\n/); // un .md de Source n'est pas à modifier
  // le corps composé est celui que le filet confierait à Jules
  assert.deepEqual(evaluerJules({ repo: 'FinanceAI', n: 30, labels: ['niveau:tâche', 'faisable-jules'], body: corps }), { ok: true, raisons: [] });
  assert.match(w[1].corps.body, /gabarit-auto/);
  assert.equal(etat._completion.faites.length, 1);
});

test('à blanc : rien n\'est écrit et le plafond du jour n\'est pas entamé', () => {
  const g = github({ issues: [tache(30)] });
  const etat = {};
  const r = lancer(g, { etat, aBlanc: true });
  assert.deepEqual(r.completees, ['FinanceAI#30']);
  assert.equal(ecritures(g.appels).length, 0);
  assert.equal(etat._completion.faites.length, 0);
});

test('au plus une tâche par dépôt et par tour, la plus prioritaire d\'abord', () => {
  const g = github({ issues: [tache(40, { labels: ['niveau:tâche', 'prio:2'] }), tache(41, { labels: ['niveau:tâche', 'prio:1'] })] });
  assert.deepEqual(lancer(g).completees, ['FinanceAI#41']);
});

test('refus : chemin cité introuvable, motif à étoile, chemin protégé, MCP, base de données, toile : rien n\'est écrit, le refus est dit une fois', () => {
  const cas = [
    ['chemin cité introuvable', CORPS().replace('app/tendances/page.tsx', 'app/absent/page.tsx').replace('app/tendances/page.tsx', 'app/absent/page.tsx'), /introuvable/],
    ['motif', CORPS().replace('`colonnes-pc`', '`app/**/*.tsx`'), /motif de fichiers/],
    ['protégé', CORPS().replace('`colonnes-pc`', '`scripts/hooks/pre.sh`'), /chemin protégé scripts\//],
    ['mcp', CORPS().replace('place la carte', 'expose un outil MCP et place la carte'), /MCP/],
    ['base', CORPS().replace('place la carte', 'ajoute une migration et place la carte'), /migration/],
    ['toile', CORPS().replace('place la carte', 'dessine sur la toile et place la carte'), /toile/],
  ];
  for (const [nom, body, motif] of cas) {
    const g = github({ issues: [tache(30, { body })], fichiers: ['app/tendances/page.tsx', 'scripts/hooks/pre.sh'] });
    const etat = {};
    const r = lancer(g, { etat });
    assert.deepEqual(r.completees, [], nom);
    assert.equal(r.refusees.length, 1, nom);
    assert.match(r.refusees[0].raison, motif, nom);
    assert.equal(ecritures(g.appels).length, 0, nom);
    // même corps, même `updated_at` : le refus est mémorisé, il n'est ni relu ni redit
    const g2 = github({ issues: [tache(30, { body })], fichiers: ['app/tendances/page.tsx'] });
    assert.deepEqual(lancer(g2, { etat }).refusees, [], `${nom} : redit`);
    assert.equal(g2.appels.filter((a) => /contents/.test(a.chemin)).length, 0, `${nom} : relu`);
  }
});

test('un refus mémorisé est relu quand la tâche est modifiée (updated_at change)', () => {
  const etat = { _completion: { faites: [], refus: { 'FinanceAI#30': { vu: '2026-10-19T09:00:00Z', raison: 'x' } } } };
  const g = github({ issues: [tache(30)] });
  assert.deepEqual(lancer(g, { etat }).completees, ['FinanceAI#30']);
});

test('refus : seulement des tests cités (les fichiers de la tâche ne se déduisent pas) ; moins de 5 fichiers permis au plus', () => {
  const soloTest = CORPS().replace(/`app\/tendances\/page\.tsx`/g, '`tests/guards/socle.test.ts`').replace(', `colonnes-pc`', '');
  const g = github({ issues: [tache(30, { body: soloTest })], fichiers: ['tests/guards/socle.test.ts'] });
  assert.match(lancer(g).refusees[0].raison, /seulement des tests/);
  const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((x) => `lib/${x}.ts`);
  const beaucoup = CORPS().replace('`app/tendances/page.tsx` (blocs', `${six.map((f) => `\`${f}\``).join(', ')} (blocs`);
  const g2 = github({ issues: [tache(30, { body: beaucoup })], fichiers: six });
  assert.match(lancer(g2).refusees[0].raison, /plus de 5 fichiers/);
});

test('refus : dossier de tests introuvable', () => {
  const g = github({ issues: [tache(30)], dossiers: [] });
  assert.match(lancer(g).refusees[0].raison, /dossier tests introuvable/);
});

test('une dépendance ouverte (écrite ou native) ou illisible : pas de complétion, pas de mémoire du refus', () => {
  const ecrite = CORPS().replace('**Attend** : rien (le frein de quota retient seulement le départ).', '**Attend** : #12 — raison');
  for (const g of [
    github({ issues: [tache(30, { body: ecrite })], etats: { 'FinanceAI#12': 'open' } }),
    github({ issues: [tache(30)], natives: { 30: [{ state: 'open' }] } }),
    github({ issues: [tache(30)], natives: { 30: 'ERR' } }),
  ]) {
    const etat = {};
    const r = lancer(g, { etat });
    assert.deepEqual(r.completees, []);
    assert.deepEqual(r.refusees, []);
    assert.equal(ecritures(g.appels).length, 0);
    assert.deepEqual(etat._completion.refus, {});
  }
});

test('ne touche pas : déjà complétée (marqueur), déjà réservée, en-cours/jules/qui:marc/bloqué, PR ouverte qui la cite, corps déjà complet', () => {
  const complet = CORPS(`${MARQUEUR}\n**Fichiers permis**...`);
  const g = github({
    issues: [
      tache(1, { body: complet }),
      tache(2, { labels: ['niveau:tâche', 'faisable-jules'] }),
      tache(4, { labels: ['niveau:tâche', 'en-cours'] }),
      tache(5, { labels: ['niveau:tâche', 'qui:marc'] }),
      tache(6, { labels: ['niveau:tâche', 'bloqué'] }),
      tache(7),
    ],
    prs: [{ number: 90, title: 'feat: x', body: 'Tâche : #7', head: { ref: 'jules/x' } }],
  });
  assert.deepEqual(lancer(g).completees, []);
  assert.equal(ecritures(g.appels).length, 0);
});

test('plafond : 20 complétions par 24 h sur tous les dépôts ; les plus anciennes sortent de la fenêtre', () => {
  const maintenant = new Date('2026-10-19T20:00:00Z');
  const heure = (h) => new Date(maintenant.getTime() - h * 3_600_000).toISOString();
  const pleine = { _completion: { faites: Array.from({ length: PAR_JOUR_MAX }, () => heure(3)), refus: {} } };
  const g = github({ issues: [tache(30)] });
  assert.deepEqual(completerDepot({ depot: 'MoKarade/FinanceAI', gh: g.gh, etat: pleine, maintenant }).completees, []);
  assert.equal(g.appels.length, 0);
  const vieille = { _completion: { faites: Array.from({ length: PAR_JOUR_MAX }, () => heure(25)), refus: {} } };
  assert.deepEqual(completerDepot({ depot: 'MoKarade/FinanceAI', gh: github({ issues: [tache(30)] }).gh, etat: vieille, maintenant }).completees, ['FinanceAI#30']);
  assert.equal(vieille._completion.faites.length, 1);
});

test('au plus 5 tâches examinées par dépôt et par tour : les lectures restent bornées', () => {
  const issues = Array.from({ length: 9 }, (_, i) => tache(50 + i, { body: CORPS().replace('app/tendances/page.tsx', 'app/absent/page.tsx') }));
  const g = github({ issues });
  assert.equal(lancer(g).refusees.length, 5);
});

test('le tour du PC : complète puis marque dans le même passage, et le dit sur la ligne ; les refus nouveaux aussi', () => {
  const dossier = mkdtempSync(join(tmpdir(), 'gabarit-'));
  const fichierEtat = join(dossier, 'etat.json');
  const issuesInitiales = [tache(30), tache(31, { labels: ['niveau:tâche', 'prio:1'], body: CORPS().replace('place la carte', 'ajoute une migration et place la carte') })];
  const etatDepot = { issues: issuesInitiales.map((i) => ({ ...i })) };
  const g = github({ issues: etatDepot.issues });
  const gh = (m, c, b) => {
    if (m === 'PATCH') { const i = etatDepot.issues.find((x) => `repos/MoKarade/FinanceAI/issues/${x.number}` === c); i.body = b.body; return {}; }
    return g.gh(m, c, b);
  };
  const ligne = tourJulesSuivi({ fichierEtat, executer: true, aBlanc: false, maintenant: new Date('2026-10-19T20:00:00Z'), gh, depots: ['MoKarade/FinanceAI'] });
  assert.match(ligne, /1 complétée\(s\) au gabarit \(FinanceAI#30\)/);
  assert.match(ligne, /refus : FinanceAI#31 « migration »/);
  assert.match(ligne, /1 marquée\(s\) faisable-jules \(FinanceAI#30\)/);
  assert.doesNotMatch(ligne, /ÉCHEC/);
  const sauve = JSON.parse(readFileSync(fichierEtat, 'utf8'));
  assert.equal(sauve._completion.faites.length, 1);
  assert.ok(sauve._completion.refus['FinanceAI#31']);
});

test('écran dans une app privée : refus « écran sans captures possibles », rien n\'est écrit ; FinanceAI reste éligible', () => {
  const g = github({ issues: [tache(30)] });
  const r = completerDepot({ depot: 'MoKarade/CarAI', gh: g.gh, etat: {}, maintenant: new Date('2026-10-19T20:00:00Z') });
  assert.deepEqual(r.completees, []);
  assert.match(r.refusees[0].raison, /écran sans captures possibles/);
  assert.equal(ecritures(g.appels).length, 0);
});

test('prio:3 est complétée au gabarit (réponse de Marc du 21/10/2026), Hubperso#247 jamais', () => {
  const g = github({ issues: [tache(3, { labels: ['niveau:tâche', 'prio:3'] })] });
  assert.deepEqual(lancer(g).completees, ['FinanceAI#3']);
  const h = github({ issues: [tache(247, { labels: ['niveau:tâche', 'prio:3'] })] });
  const r = completerDepot({ depot: 'MoKarade/Hubperso', gh: h.gh, etat: {}, maintenant: new Date('2026-10-19T20:00:00Z') });
  assert.deepEqual(r.completees, []);
  assert.deepEqual(r.refusees, []);
  assert.equal(ecritures(h.appels).length, 0);
});

const CORPS_VITE = `**Avant** : trois alertes Dependabot sont ouvertes sur \`main\`, toutes via \`launch-editor\` embarqué par \`vite\` 8.3.0 à 8.3.2.

**Après** : \`vite\` est mis à jour vers une version corrigée (mise à jour mineure ou correctif, jamais \`npm audit fix --force\`).

**Fini quand** : \`npm audit --omit=dev\` rend 0 sur le commit fusionné et les trois alertes sont lues fermées.

**Source** : demande du Coordinateur du 21/10/2026.

**Attend** : aucune
`;

test('montée de dépendance : « Fini quand » qui cite npm audit tient lieu de test, les fichiers sont package.json et son lockfile, Jules l\'accepte', () => {
  const t = tache(28, { body: CORPS_VITE, title: 'Mettre à jour vite pour fermer les trois alertes « launch-editor »', labels: ['niveau:tâche', 'prio:1'] });
  const g = github({ issues: [t], fichiers: ['package.json', 'package-lock.json'], dossiers: [] });
  const r = lancer(g);
  assert.deepEqual(r.completees, ['FinanceAI#28']);
  const corps = ecritures(g.appels)[0].corps.body;
  assert.match(corps, /\*\*Fichiers permis\*\* \(aucun autre\) :\n- `package\.json`\n- `package-lock\.json`/);
  assert.doesNotMatch(corps, /\(nouveau\)/); // aucun test inventé
  assert.match(corps, /mise à jour mineure ou un correctif \(patch\) seulement, jamais `npm audit fix --force`/);
  assert.match(corps, /`npm audit --omit=dev` : il doit rendre 0 vulnérabilité/);
  assert.deepEqual(evaluerJules({ repo: 'FinanceAI', n: 28, labels: ['niveau:tâche', 'faisable-jules'], body: corps }), { ok: true, raisons: [] });
});

test('montée de dépendance : sans package.json à la racine, ou sans npm audit ni test dans « Fini quand », ou sans mot de mise à jour : refus dit', () => {
  const t = tache(28, { body: CORPS_VITE, title: 'Mettre à jour vite', labels: ['niveau:tâche', 'prio:1'] });
  const sans = github({ issues: [t], fichiers: [], dossiers: [] });
  assert.match(lancer(sans).refusees[0].raison, /package\.json introuvable/);
  assert.equal(ecritures(sans.appels).length, 0);

  const aucun = github({ issues: [tache(29, { body: CORPS_VITE.replace('`npm audit --omit=dev` rend 0', 'les alertes sont closes'), title: 'Mettre à jour vite' })], fichiers: ['package.json'], dossiers: [] });
  assert.match(lancer(aucun).refusees[0].raison, /aucun chemin de fichier existant cité/);

  const autre = github({ issues: [tache(30, { body: CORPS_VITE.replace('mis à jour vers', 'remplacé par').replace('mise à jour mineure ou correctif', 'correctif'), title: 'Changer vite' })], fichiers: ['package.json'], dossiers: [] });
  assert.match(lancer(autre).refusees[0].raison, /aucun chemin de fichier existant cité/);
});

test('montée de dépendance : le préfixe de l\'app (web/ chez BatchChef) est respecté', () => {
  const g = github({ issues: [tache(28, { body: CORPS_VITE, title: 'Mettre à jour vite' })], fichiers: ['web/package.json', 'web/package-lock.json'], dossiers: [] });
  const r = completerDepot({ depot: 'MoKarade/batchchef-', gh: g.gh, etat: {}, maintenant: new Date('2026-10-19T20:00:00Z') });
  assert.deepEqual(r.completees, ['batchchef-#28']);
  assert.match(ecritures(g.appels)[0].corps.body, /- `web\/package\.json`\n- `web\/package-lock\.json`/);
  assert.match(ecritures(g.appels)[0].corps.body, /`cd web && npm audit --omit=dev`/);
});

test('sans ligne « Attend » : refus dit, rien n\'est écrit (CarAI#50, 21/10/2026 : réservée mais écartée de la file)', () => {
  const g = github({ issues: [tache(31, { body: CORPS().replace(/\*\*Attend\*\* : [^\n]*\n/, '') })] });
  const r = lancer(g);
  assert.deepEqual(r.completees, []);
  assert.match(r.refusees[0].raison, /ligne « \*\*Attend\*\* » absente/);
  assert.equal(ecritures(g.appels).length, 0);
});

const SANS_TEST = () => CORPS().replace('un test de rendu verrouille l\'ordre et est vert', 'la page est belle');

test('sans test dans « Fini quand » (décision de Marc du 21/10/2026) : Jules écrit d\'abord le test, un seul fichier de test nouveau entre dans « Fichiers permis »', () => {
  const g = github({ issues: [tache(30, { body: SANS_TEST() })] });
  const r = lancer(g);
  assert.deepEqual(r.completees, ['FinanceAI#30']);
  const corps = ecritures(g.appels)[0].corps.body;
  assert.match(corps, /- `app\/tendances\/page\.tsx`\n- `tests\/tendances\.test\.ts` \(nouveau\)/);
  assert.match(corps, /Écris D'ABORD le test `tests\/tendances\.test\.ts` qui prouve le « Fini quand »/);
  assert.doesNotMatch(corps, /Écris ou complète/);
  assert.deepEqual(evaluerJules({ repo: 'FinanceAI', n: 30, labels: ['niveau:tâche', 'faisable-jules'], body: corps }), { ok: true, raisons: [] });
  // avec un test cité, l'étape ordinaire reste
  const avecTest = github({ issues: [tache(31)] });
  lancer(avecTest);
  assert.match(ecritures(avecTest.appels)[0].corps.body, /Écris ou complète `tests\/tendances\.test\.ts`/);
});

test('sans test dans « Fini quand » : refus gardés quand le test ne se dérive pas (aucun fichier de code, test déjà cité, Fichiers permis déjà écrit)', () => {
  const seulementMd = SANS_TEST().replaceAll('app/tendances/page.tsx', 'docs/guide.md');
  const g1 = github({ issues: [tache(30, { body: seulementMd })], fichiers: ['docs/guide.md'] });
  assert.match(lancer(g1).refusees[0].raison, /aucun fichier de code n'est cité/);
  const dejaTest = SANS_TEST().replace('**Source**', '**Source** : `tests/tendances.test.ts` ;');
  const g2 = github({ issues: [tache(30, { body: dejaTest })], fichiers: ['app/tendances/page.tsx', 'tests/tendances.test.ts'] });
  assert.match(lancer(g2).refusees[0].raison, /fichier de test est cité/);
  const permis = SANS_TEST().replace('**Attend**', '**Fichiers permis** (aucun autre) :\n- `app/tendances/page.tsx`\n\n**Attend**');
  const g3 = github({ issues: [tache(30, { body: permis })] });
  assert.match(lancer(g3).refusees[0].raison, /« Fichiers permis » est déjà écrit/);
  for (const g of [g1, g2, g3]) assert.equal(ecritures(g.appels).length, 0);
});
