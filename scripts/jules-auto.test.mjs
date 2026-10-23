import './places-deux.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluerJules, choisirPourJules, confierAJules, section, fichiersPermis, FICHIERS_MAX, FOIS_MAX } from './jules-auto.mjs';

// Un corps d'issue au gabarit `docs/jules-gabarit-issue.md`, fictif.
const corps = (n = 7, repo = 'carai', surcharge = {}) => {
  const s = {
    Avant: '`lib/format.ts` n\'a aucun test.',
    'Après': 'Un test couvre `formatKm`.',
    'Fini quand': '`npm run test -- format` affiche 3 tests verts.',
    'Fichiers permis': '(aucun autre) :\n- `lib/format.test.ts`',
    'À faire': '1. Écrire trois cas.',
    'À ne pas faire': 'Ne pas modifier `lib/format.ts`.',
    'Vérifier': '`npm run test -- format`',
    'À citer dans la PR': `\`Tâche : #${n}\` ; sujet de commit : \`test: ajouter les cas de formatKm\``,
    ...surcharge,
  };
  return Object.entries(s).filter(([, v]) => v !== null).map(([k, v]) => (k === 'Fichiers permis' ? `**${k}** ${v}` : `**${k}** : ${v}`)).join('\n\n');
};
const evalue = (surcharge, extra = {}) => evaluerJules({ repo: 'carai', n: 7, labels: ['faisable-jules'], body: corps(7, 'carai', surcharge), ...extra });

test('section lit « **Titre** : texte » jusqu’à la section suivante, parenthèse tolérée', () => {
  const b = corps();
  assert.equal(section(b, 'Après'), 'Un test couvre `formatKm`.');
  assert.match(section(b, 'Fichiers permis'), /lib\/format\.test\.ts/);
  assert.equal(section(b, 'Source'), null);
});

test('fichiersPermis ne garde que les puces entre accents graves', () => {
  assert.deepEqual(fichiersPermis(corps(7, 'carai', { 'Fichiers permis': '(aucun autre) :\n- `a/un.ts`\n- `b/deux.ts`\ntexte libre' })), ['a/un.ts', 'b/deux.ts']);
});

test('un corps complet au gabarit est confiable', () => {
  const r = evalue({});
  assert.deepEqual(r, { ok: true, raisons: [] });
});

test('chaque section manquante ou vide est dite', () => {
  assert.match(evalue({ 'À ne pas faire': null }).raisons.join(), /sections absentes : À ne pas faire/);
  assert.match(evalue({ Vérifier: '' }).raisons.join(), /sections vides : Vérifier/);
  assert.equal(evaluerJules({ repo: 'carai', n: 7, labels: [], body: 'Faire le truc.' }).ok, false);
});

test('les chemins que Jules ne touche jamais sont refusés avec leur raison', () => {
  const refuse = (chemin) => evalue({ 'Fichiers permis': `:\n- \`${chemin}\`` }).raisons.join();
  assert.match(refuse('.github/CODEOWNERS'), /chemin protégé/);
  assert.match(refuse('.github/scripts/x.sh'), /chemin protégé/);
  assert.match(refuse('.github/workflows/garde-fou.yml'), /workflow protégé/);
  assert.match(refuse('.github/workflows/relecture.yml'), /workflow protégé/);
  assert.match(refuse('.github/workflows/sentry-essai.yml'), /Sentry/);
  assert.match(refuse('scripts/x.mjs'), /chemin protégé/);
  assert.match(refuse('drizzle/0001.sql'), /base de données/);
  assert.match(refuse('lib/auth.ts'), /authentification/);
  assert.match(refuse('lib/token-store.ts'), /secret/);
  assert.match(refuse('BACKLOG.md'), /instructions/);
  assert.match(refuse('AGENTS.md'), /instructions/);
});

test('exclusions levées par Marc le 19/10 : un workflow listé, sans secret, convient', () => {
  assert.equal(evalue({ 'Fichiers permis': ':\n- `.github/workflows/ci.yml`' }).ok, true);
});

test('écran : permis (FinanceAI) avec captures avant/après ET test de thème, refusé sinon ; refusé dans toute app privée', () => {
  const f = { 'Fichiers permis': ':\n- `app/globals.css`\n- `components/Carte.tsx`' };
  const prive = evalue({ ...f, Vérifier: 'captures avant/après ; `npm run test -- tests/theme.test.ts`' });
  assert.match(prive.raisons.join(), /écran sans captures possibles/);
  const finance = (surcharge) => evaluerJules({ repo: 'FinanceAI', n: 7, labels: ['faisable-jules'], body: corps(7, 'FinanceAI', surcharge) });
  assert.equal(finance({ ...f, Vérifier: 'captures avant/après ; `npm run test -- tests/theme.test.ts`' }).ok, true);
  assert.match(finance(f).raisons.join(), /écran : le corps doit demander des captures/);
  assert.match(finance({ ...f, Vérifier: 'captures avant/après' }).raisons.join(), /theme\.test/);
  assert.match(evalue({}, { labels: ['faisable-jules', 'écran'] }).raisons.join(), /écran/);
});

test('dépendances : seulement mineures/patch avec npm audit, refusé sinon', () => {
  const f = { 'Fichiers permis': ':\n- `package.json`\n- `package-lock.json`' };
  assert.match(evalue(f).raisons.join(), /dépendances/);
  assert.equal(evalue({ ...f, Vérifier: '`npm audit --omit=dev` rend 0 ; montée mineure seulement' }).ok, true);
});

test('long .md : le français et les accents doivent être demandés explicitement', () => {
  const f = { 'Fichiers permis': ':\n- `docs/guide.md`' };
  assert.match(evalue(f).raisons.join(), /\.md : le corps doit demander/);
  assert.equal(evalue({ ...f, 'À ne pas faire': 'Écrire en français, garder tous les accents ; ne rien traduire.' }).ok, true);
});

test('plus de cinq fichiers, ou aucun lisible : refusé', () => {
  const six = Array.from({ length: FICHIERS_MAX + 1 }, (_, i) => `- \`lib/f${i}.test.ts\``).join('\n');
  assert.match(evalue({ 'Fichiers permis': `:\n${six}` }).raisons.join(), /plus de 5 fichiers/);
  const cinq = six.split('\n').slice(0, FICHIERS_MAX).join('\n');
  assert.equal(evalue({ 'Fichiers permis': `:\n${cinq}` }).ok, true);
  assert.match(evalue({ 'Fichiers permis': ':\nvoir plus haut' }).raisons.join(), /aucun fichier permis lisible/);
});

test('les dépôts et les étiquettes réservés à Claude sont refusés', () => {
  assert.match(evaluerJules({ repo: 'hub-contract', n: 7, labels: ['faisable-jules'], body: corps(7, 'hub-contract') }).raisons.join(), /dépôt réservé/);
  assert.match(evalue({}, { labels: ['faisable-jules', 'sécurité'] }).raisons.join(), /sécurité/);
  assert.match(evalue({}, { labels: ['faisable-jules', 'qui:marc'] }).raisons.join(), /qui:marc/);
  assert.match(evalue({}, { labels: [] }).raisons.join(), /faisable-jules/);
  assert.match(evaluerJules({ repo: 'DriveAI', n: 7, labels: ['faisable-jules'], body: corps(7, 'DriveAI', { 'Fichiers permis': ':\n- `src/Router.gs`' }) }).raisons.join(), /moteur DriveAI/);
});

test('« OU », crochets du gabarit, mauvais numéro et Fixes sont refusés', () => {
  assert.match(evalue({ 'À faire': '1. Écrire le test OU la doc.' }).raisons.join(), /« OU »/);
  assert.match(evalue({ Avant: '<ce qui est vrai aujourd\'hui>' }).raisons.join(), /crochets/);
  assert.match(evalue({ 'À citer dans la PR': '`Tâche : #8`' }).raisons.join(), /« Tâche : #7 » absent/);
  assert.match(evalue({ 'À citer dans la PR': '`Tâche : #7` Fixes #7' }).raisons.join(), /Fixes/);
  assert.equal(evalue({ 'À citer dans la PR': '`Tâche : MoKarade/carai#7`' }).ok, true, 'la forme avec dépôt est permise');
});

// prochaines.json minimal : des dépôts avec leurs tâches réservées à Jules (`reservees_jules`).
const depot = (repo, reservees, extra = {}) => ({ repo, statut: 'rien', reservees_jules: reservees, occupe_par: [], incidents: [], ...extra });
const prochaines = (...depots) => ({ depots });
const issues = (table) => (repo, n) => {
  if (!table[n]) throw new Error('404');
  return table[n];
};
const ouverte = (n, surcharge = {}, labels = ['faisable-jules']) => ({ state: 'open', labels, body: corps(n, 'carai', surcharge) });

test('choisirPourJules prend la première réservée confiable, et dit pourquoi les autres ne le sont pas', () => {
  const p = prochaines(depot('carai', [{ ref: 'carai#5', n: 5 }, { ref: 'carai#6', n: 6 }, { ref: 'carai#7', n: 7 }]));
  const r = choisirPourJules(p, issues({ 5: { state: 'open', labels: ['faisable-jules'], body: 'sans gabarit' }, 6: { ...ouverte(6), state: 'closed' }, 7: ouverte(7) }));
  assert.deepEqual(r.choix.map((c) => c.ref), ['carai#7']);
  assert.deepEqual(r.pasPretes.map((x) => x.ref), ['carai#5', 'carai#6']);
  assert.equal(r.depotsConcernes, 1);
});

test('choisirPourJules attend seulement un incident : un travail en cours, une PR ouverte ou une autre tâche Jules ne le retiennent plus', () => {
  const lire = (repo, n) => ({ state: 'open', labels: ['faisable-jules'], body: corps(n, repo) });
  const r = (extra) => choisirPourJules(prochaines(depot('carai', [{ ref: 'carai#7', n: 7 }], extra)), lire);
  assert.deepEqual(r({ occupe_par: [{ ref: 'carai#2', motif: 'en-cours' }] }).choix.map((c) => c.ref), ['carai#7']);
  assert.deepEqual(r({ occupe_par: [{ ref: 'carai#2', motif: 'pr-ouverte' }] }).choix.map((c) => c.ref), ['carai#7']);
  assert.deepEqual(r({ occupe_par: [{ ref: 'carai#2', motif: 'jules', fichiers: ['a/x.ts'] }] }).choix.map((c) => c.ref), ['carai#7']);
  // depuis le 23/10/2026 le relevé range les tâches Jules dans `jules_en_cours`, hors de `occupe_par` : le filet les lit pour le plafond et les fichiers
  assert.deepEqual(r({ jules_en_cours: [{ ref: 'carai#2', motif: 'jules', fichiers: ['a/x.ts'] }] }).choix.map((c) => c.ref), ['carai#7']);
  assert.deepEqual(r({ jules_en_cours: [{ ref: 'carai#2', motif: 'jules', fichiers: ['lib/'] }] }).choix, [], 'fichiers communs');
  assert.deepEqual(r({ incidents: [{ n: 9 }] }).choix, []);
});

test('choisirPourJules plafonne à trois Jules en même temps, et ne reconfie pas une tâche confiée deux fois', () => {
  const lire = (repo, n) => ouverte(n);
  const quatre = ['a', 'b', 'c', 'd'].map((x, i) => depot(x, [{ ref: `${x}#${i + 1}`, n: i + 1 }]));
  const tous = choisirPourJules(prochaines(...quatre), (repo, n) => ({ ...ouverte(n), body: corps(n, repo) }));
  assert.equal(tous.choix.length, 3);
  const dejaUn = choisirPourJules(prochaines(depot('z', [], { occupe_par: [{ ref: 'z#1', motif: 'jules' }] }), ...quatre), (repo, n) => ({ ...ouverte(n), body: corps(n, repo) }));
  assert.equal(dejaUn.choix.length, 2);
  assert.equal(dejaUn.enCours, 1);
  const dejaUnNouveau = choisirPourJules(prochaines(depot('z', [], { jules_en_cours: [{ ref: 'z#1', motif: 'jules' }] }), ...quatre), (repo, n) => ({ ...ouverte(n), body: corps(n, repo) }));
  assert.equal(dejaUnNouveau.enCours, 1, 'le plafond de trois lit jules_en_cours');
  assert.equal(dejaUnNouveau.choix.length, 2);
  void lire;
  const deux = choisirPourJules(prochaines(depot('carai', [{ ref: 'carai#7', n: 7 }])), () => { throw new Error('ne doit pas être lu'); }, { confies: { 'carai#7': { fois: FOIS_MAX } } });
  assert.deepEqual(deux.choix, []);
  assert.match(deux.pasPretes[0].raisons[0], /déjà confiée 2 fois/);
});

test('choisirPourJules ne lève pas sur une issue illisible', () => {
  const r = choisirPourJules(prochaines(depot('carai', [{ ref: 'carai#9', n: 9 }])), issues({}));
  assert.match(r.pasPretes[0].raisons[0], /illisible/);
});

// gh factice : un dépôt avec ses issues, ses PR ouvertes et ce qu'on y écrit.
const ghFactice = ({ issue = { state: 'open', labels: [] }, ouvertes = {}, prs = [], fichiersPr = {} } = {}) => {
  const appels = [];
  const gh = (m, chemin, corps) => {
    appels.push([m, chemin, corps]);
    if (m === 'GET' && /\/pulls\?/.test(chemin)) return prs;
    const fp = /\/pulls\/(\d+)\/files/.exec(chemin);
    if (m === 'GET' && fp) { if (!(fp[1] in fichiersPr)) throw new Error('HTTP 502'); return fichiersPr[fp[1]].map((f) => (typeof f === 'string' ? { filename: f } : f)); }
    if (m === 'GET' && /issues\?labels=/.test(chemin)) return ouvertes[decodeURIComponent(/labels=([^&]+)/.exec(chemin)[1])] ?? [];
    if (m === 'GET') return issue;
    return {};
  };
  return { gh, appels };
};

test('confierAJules pose l’étiquette jules et un commentaire, après avoir vérifié le dépôt en direct', () => {
  const { gh, appels } = ghFactice();
  const r = confierAJules({ repo: 'CarAI', n: 7 }, gh);
  assert.equal(r.statut, 'confiee');
  const ecritures = appels.filter(([m]) => m === 'POST');
  assert.equal(ecritures[0][1], 'repos/MoKarade/CarAI/issues/7/labels');
  assert.deepEqual(ecritures[0][2], { 'labels[]': 'jules' });
  assert.match(ecritures[1][2].body, /faisable-jules/);
});

test('confierAJules ne fait rien si le dépôt est gelé ou l’issue écartée, et rien à blanc ; un travail en cours ne l’arrête plus', () => {
  // 23/10/2026 : Jules part même dans un dépôt occupé par un fil (seuls les fichiers déjà pris comptent)
  const occupe = ghFactice({ ouvertes: { 'en-cours': [{ number: 3 }] } });
  assert.equal(confierAJules({ repo: 'CarAI', n: 7 }, occupe.gh).statut, 'confiee');
  const gele = ghFactice();
  assert.match(confierAJules({ repo: 'MemoryAI', n: 7 }, gele.gh).raison, /dépôt gelé/);
  assert.equal(gele.appels.some(([m]) => m === 'POST'), false);
  const pr = ghFactice({ ouvertes: { 'en-cours': [{ number: 3, pull_request: {} }] } });
  assert.equal(confierAJules({ repo: 'CarAI', n: 7 }, pr.gh).statut, 'confiee', 'une PR étiquetée n’est pas une issue de travail');
  const marc = ghFactice({ issue: { state: 'open', labels: [{ name: 'qui:marc' }] } });
  assert.match(confierAJules({ repo: 'CarAI', n: 7 }, marc.gh).raison, /qui:marc/);
  const blanc = ghFactice();
  assert.equal(confierAJules({ repo: 'CarAI', n: 7 }, blanc.gh, { aBlanc: true }).raison, 'à blanc');
  assert.equal(blanc.appels.some(([m]) => m === 'POST'), false);
});

test('confierAJules attend une PR ouverte, sauf celles des robots et la boîte du Réacteur', () => {
  const humaine = ghFactice({ prs: [{ number: 12, user: { login: 'MoKarade', type: 'User' } }] });
  assert.match(confierAJules({ repo: 'CarAI', n: 7 }, humaine.gh).raison, /PR #12 ouverte/);
  const robot = ghFactice({ prs: [{ number: 13, user: { login: 'dependabot[bot]', type: 'Bot' } }] });
  assert.equal(confierAJules({ repo: 'CarAI', n: 7 }, robot.gh).statut, 'confiee');
  const boite = ghFactice({ prs: [{ number: 58, user: { login: 'MoKarade', type: 'User' } }] });
  assert.equal(confierAJules({ repo: 'app-template', n: 7 }, boite.gh).statut, 'confiee');
  assert.match(confierAJules({ repo: 'CarAI', n: 7 }, ghFactice({ prs: [{ number: 58, user: { login: 'MoKarade', type: 'User' } }] }).gh).raison, /PR #58/, 'la boîte n’est exclue que dans app-template');
});

// ---- Deux places par dépôt (décision de Marc, 21/10/2026) --------------------------------------------------------------------------------

test('choisirPourJules part dans un dépôt occupé, sauf fichiers déjà pris', () => {
  const lire = (repo, n) => ({ state: 'open', labels: ['faisable-jules'], body: corps(n, repo) }); // fichiers : lib/format.test.ts
  const occupe = (fichiers, motif = 'en-cours') => ({ occupe_par: [{ ref: 'carai#2', motif, fichiers }] });
  const r = (extra) => choisirPourJules(prochaines(depot('carai', [{ ref: 'carai#7', n: 7 }], extra)), lire);
  assert.deepEqual(r(occupe(['app/page.tsx'])).choix.map((c) => c.ref), ['carai#7']);
  assert.deepEqual(r(occupe(['app/page.tsx'], 'pr-ouverte')).choix.map((c) => c.ref), ['carai#7']);
  const commun = r(occupe(['lib/']));
  assert.deepEqual(commun.choix, []);
  assert.match(commun.pasPretes[0].raisons[0], /fichiers déjà pris : fichier-commun:lib\/ ~ lib\/format\.test\.ts avec carai#2/);
  assert.deepEqual(r(occupe(null)).choix.map((c) => c.ref), ['carai#7'], 'fichiers du travail inconnus : la vérification en direct lit les PR');
  assert.deepEqual(r(occupe([])).choix.map((c) => c.ref), ['carai#7']);
});

test('choisirPourJules : un incident ou un dépôt gelé gardent le dépôt, deux travaux à fichiers disjoints non', () => {
  const lire = (repo, n) => ({ state: 'open', labels: ['faisable-jules'], body: corps(n, repo) });
  const deux = [{ ref: 'carai#2', motif: 'en-cours', fichiers: ['a/x.ts'] }, { ref: 'carai#3', motif: 'en-cours', fichiers: ['b/y.ts'] }];
  assert.deepEqual(choisirPourJules(prochaines(depot('carai', [{ ref: 'carai#7', n: 7 }], { occupe_par: deux })), lire).choix.map((c) => c.ref), ['carai#7']);
  assert.deepEqual(choisirPourJules(prochaines(depot('carai', [{ ref: 'carai#7', n: 7 }], { occupe_par: [deux[0]], incidents: [{ n: 9 }] })), () => { throw new Error('ne doit pas être lu'); }).choix, []);
  const gele = choisirPourJules(prochaines(depot('MemoryAI', [{ ref: 'memoryai#7', n: 7 }])), () => { throw new Error('ne doit pas être lu'); });
  assert.deepEqual(gele.choix, []);
  assert.deepEqual(gele.pasPretes, [{ ref: 'memoryai#7', raisons: ['dépôt gelé'] }]);
});

test('choisirPourJules : la 2e place compte dans le plafond des trois Jules', () => {
  const lire = (repo, n) => ({ state: 'open', labels: ['faisable-jules'], body: corps(n, repo) });
  const jules = (x) => depot(x, [{ ref: `${x}#9`, n: 9 }], { occupe_par: [{ ref: `${x}#1`, motif: 'en-cours', fichiers: ['z/z.ts'] }] });
  const r = choisirPourJules(prochaines(jules('a'), jules('b'), jules('c'), jules('d')), lire);
  assert.equal(r.choix.length, 3);
});

test('confierAJules part dans un dépôt occupé si les fichiers de l’autre travail sont disjoints, rien s’ils sont communs', () => {
  const travail = (corpsIssue, extra = {}) => ({ number: 3, body: corpsIssue, ...extra });
  const issue = { state: 'open', labels: [], body: corps(7, 'carai') }; // lib/format.test.ts
  const disjoint = ghFactice({ issue, ouvertes: { 'en-cours': [travail('**Fichiers touchés** :\n- `app/page.tsx`')] } });
  assert.equal(confierAJules({ repo: 'CarAI', n: 7 }, disjoint.gh).statut, 'confiee');
  assert.equal(disjoint.appels.some(([m]) => m === 'POST'), true);
  const commun = ghFactice({ issue, ouvertes: { 'en-cours': [travail('**Fichiers permis** :\n- `lib/format.test.ts`')] } });
  assert.match(confierAJules({ repo: 'CarAI', n: 7 }, commun.gh).raison, /fichiers déjà pris \(issue #3 en cours : fichier-commun:lib\/format\.test\.ts\)/);
  const inconnu = ghFactice({ issue, ouvertes: { jules: [travail('sans gabarit')] } });
  assert.equal(confierAJules({ repo: 'CarAI', n: 7 }, inconnu.gh).statut, 'confiee', 'une tâche sans fichiers déclarés ne dit rien : seule sa PR comptera');
  assert.equal(inconnu.appels.some(([m]) => m === 'POST'), true);
});

test('confierAJules : deux travaux ne l’arrêtent pas ; une tâche et sa PR sont lues ensemble ; une PR seule est lue par ses fichiers réels', () => {
  const issue = { state: 'open', labels: [], body: corps(7, 'carai') };
  const a = { number: 3, body: '**Fichiers touchés** :\n- `app/a.ts`' };
  const b = { number: 4, body: '**Fichiers touchés** :\n- `app/b.ts`' };
  const deux = ghFactice({ issue, ouvertes: { 'en-cours': [a], jules: [b] } });
  assert.equal(confierAJules({ repo: 'CarAI', n: 7 }, deux.gh).statut, 'confiee');
  const prDeA = { number: 20, user: { login: 'MoKarade', type: 'User' }, body: 'Tâche : #3' };
  const une = ghFactice({ issue, ouvertes: { 'en-cours': [a] }, prs: [prDeA], fichiersPr: { 20: ['app/a.ts'] } });
  assert.equal(confierAJules({ repo: 'CarAI', n: 7 }, une.gh).statut, 'confiee');
  const prSeule = { number: 21, user: { login: 'MoKarade', type: 'User' }, body: 'sans tâche' };
  const avecPr = ghFactice({ issue, ouvertes: { 'en-cours': [a] }, prs: [prDeA, prSeule], fichiersPr: { 20: ['app/a.ts'], 21: ['lib/format.test.ts'] } });
  assert.match(confierAJules({ repo: 'CarAI', n: 7 }, avecPr.gh).raison, /PR #21 ouverte : fichier-commun/);
});

test('confierAJules : les fichiers RÉELS de la PR ouverte de l’autre travail comptent, déclarés ou non', () => {
  const issue = { state: 'open', labels: [], body: corps(7, 'carai') }; // lib/format.test.ts
  const prDeA = { number: 20, user: { login: 'MoKarade', type: 'User' }, body: 'Tâche : #3' };
  const a = { number: 3, body: '**Fichiers touchés** :\n- `app/a.ts`' };
  const deborde = ghFactice({ issue, ouvertes: { 'en-cours': [a] }, prs: [prDeA], fichiersPr: { 20: ['app/a.ts', { filename: 'lib/neuf.ts', previous_filename: 'lib/format.test.ts' }] } });
  assert.match(confierAJules({ repo: 'CarAI', n: 7 }, deborde.gh).raison, /fichiers déjà pris \(PR #20 ouverte : fichier-commun:lib\/format\.test\.ts\)/, 'un renommage compte pour l’ancien chemin');
  const sage = ghFactice({ issue, ouvertes: { 'en-cours': [a] }, prs: [prDeA], fichiersPr: { 20: ['app/a.ts', 'app/a.test.ts'] } });
  assert.equal(confierAJules({ repo: 'CarAI', n: 7 }, sage.gh).statut, 'confiee');
  const sansDeclaration = ghFactice({ issue, ouvertes: { 'en-cours': [{ number: 3, body: 'sans gabarit' }] }, prs: [prDeA], fichiersPr: { 20: ['app/a.ts'] } });
  assert.equal(confierAJules({ repo: 'CarAI', n: 7 }, sansDeclaration.gh).statut, 'confiee', 'la PR dit ce que la tâche ne dit pas');
  const illisible = ghFactice({ issue, ouvertes: { 'en-cours': [{ number: 3, body: 'sans gabarit' }] }, prs: [prDeA] });
  assert.match(confierAJules({ repo: 'CarAI', n: 7 }, illisible.gh).raison, /fichiers-inconnus/, 'lecture impossible = inconnu = un seul');
  const tronquee = ghFactice({ issue, ouvertes: { 'en-cours': [{ number: 3, body: 'sans gabarit' }] }, prs: [prDeA], fichiersPr: { 20: Array.from({ length: 100 }, (_, i) => `f${i}.ts`) } });
  assert.match(confierAJules({ repo: 'CarAI', n: 7 }, tronquee.gh).raison, /fichiers-inconnus/, '100 fichiers : liste tronquée');
});

test('confierAJules : une PR seule (sans tâche) dont les fichiers sont lisibles laisse passer si disjoints, la garde sinon', () => {
  const issue = { state: 'open', labels: [], body: corps(7, 'carai') };
  const prSeule = { number: 21, user: { login: 'MoKarade', type: 'User' }, body: 'sans tâche' };
  const disjointe = ghFactice({ issue, prs: [prSeule], fichiersPr: { 21: ['app/z.ts'] } });
  assert.equal(confierAJules({ repo: 'CarAI', n: 7 }, disjointe.gh).statut, 'confiee');
  const commune = ghFactice({ issue, prs: [prSeule], fichiersPr: { 21: ['lib/format.test.ts'] } });
  assert.match(confierAJules({ repo: 'CarAI', n: 7 }, commune.gh).raison, /fichiers déjà pris \(PR #21 ouverte : fichier-commun:lib\/format\.test\.ts\)/);
  const inconnue = ghFactice({ issue, prs: [prSeule] });
  assert.match(confierAJules({ repo: 'CarAI', n: 7 }, inconnue.gh).raison, /PR #21 ouverte : fichiers-inconnus/);
});
