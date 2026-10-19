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

test('choisirPourJules attend qu’un dépôt soit libre : travail en cours, PR ouverte ou incident', () => {
  const lire = () => { throw new Error('ne doit pas être lu'); };
  const r = (extra) => choisirPourJules(prochaines(depot('carai', [{ ref: 'carai#7', n: 7 }], extra)), lire);
  assert.deepEqual(r({ occupe_par: [{ ref: 'carai#2', motif: 'en-cours' }] }).choix, []);
  assert.deepEqual(r({ occupe_par: [{ ref: 'carai#2', motif: 'pr-ouverte' }] }).choix, []);
  assert.deepEqual(r({ occupe_par: [{ ref: 'carai#2', motif: 'jules' }] }).choix, []);
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
const ghFactice = ({ issue = { state: 'open', labels: [] }, ouvertes = {}, prs = [] } = {}) => {
  const appels = [];
  const gh = (m, chemin, corps) => {
    appels.push([m, chemin, corps]);
    if (m === 'GET' && /\/pulls\?/.test(chemin)) return prs;
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

test('confierAJules ne fait rien si le dépôt est occupé ou l’issue écartée, et rien à blanc', () => {
  const occupe = ghFactice({ ouvertes: { 'en-cours': [{ number: 3 }] } });
  assert.match(confierAJules({ repo: 'CarAI', n: 7 }, occupe.gh).raison, /dépôt occupé/);
  assert.equal(occupe.appels.some(([m]) => m === 'POST'), false);
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
