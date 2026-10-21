import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dependancesEcrites, marquerFaisables, retirerPerimees, RESERVE_MAX } from './jules-marquage.mjs';
import { tourJulesSuivi } from './filet-pc.mjs';

const corps = (n, { attend = '**Attend** : aucune', sections = {} } = {}) => {
  const s = {
    Avant: '`lib/format.ts` n\'a aucun test.',
    'Après': 'Un test couvre `formatKm`.',
    'Fini quand': '`npm run test -- format` affiche 3 tests verts.',
    'Fichiers permis': '(aucun autre) :\n- `lib/format.test.ts`',
    'À faire': '1. Écrire trois cas.',
    'À ne pas faire': 'Ne pas modifier `lib/format.ts`.',
    'Vérifier': '`npm run test -- format`',
    'À citer dans la PR': `\`Tâche : #${n}\` ; sujet de commit : \`test: formatKm\``,
    ...sections,
  };
  const texte = Object.entries(s).filter(([, v]) => v !== null).map(([k, v]) => (k === 'Fichiers permis' ? `**${k}** ${v}` : `**${k}** : ${v}`)).join('\n\n');
  return `${texte}\n${attend}\n`;
};
const tache = (n, etiquettes = [], b = corps(n)) => ({ number: n, labels: ['niveau:tâche', ...etiquettes].map((name) => ({ name })), body: b });

function github({ issues = [], prs = [], etats = {}, natives = {} }) {
  const appels = [];
  const gh = (methode, chemin, corpsAppel) => {
    appels.push({ methode, chemin, corps: corpsAppel });
    if (methode === 'GET' && /labels=faisable-jules/.test(chemin)) return issues.filter((i) => i.labels.some((l) => l.name === 'faisable-jules'));
    if (methode === 'GET' && /\/issues\?labels=jules/.test(chemin)) return [];
    if (methode === 'GET' && /\/issues\?state=closed/.test(chemin)) return [];
    if (methode === 'GET' && /\/issues\?state=open/.test(chemin)) return issues;
    if (methode === 'GET' && /\/pulls\?state=open/.test(chemin)) return prs;
    const nat = /\/issues\/(\d+)\/dependencies\/blocked_by$/.exec(chemin);
    if (methode === 'GET' && nat) { const r = natives[nat[1]]; if (r === 'ERR') throw new Error('500'); return r ?? []; }
    const un = /\/repos\/?|repos\/MoKarade\/([\w.-]+)\/issues\/(\d+)$/.exec(chemin);
    if (methode === 'GET' && un && un[2]) { const e = etats[`${un[1]}#${un[2]}`]; if (e === 'ERR') throw new Error('404'); return { state: e ?? 'closed' }; }
    return {};
  };
  return { gh, appels };
}
const ecritures = (appels) => appels.filter((a) => a.methode !== 'GET');

test('dependancesEcrites : #n, depot/x#n, « aucune » et « rien (PR #n fusionnée) » ne comptent pas', () => {
  assert.deepEqual(dependancesEcrites('**Attend** : #12, MoKarade/hubperso#3 — raison', 'JobAI'), [{ depot: 'JobAI', n: 12 }, { depot: 'hubperso', n: 3 }]);
  assert.deepEqual(dependancesEcrites('**Attend** : aucune', 'JobAI'), []);
  assert.deepEqual(dependancesEcrites('**Attend** : rien (PR #290 fusionnée)', 'JobAI'), []);
  assert.deepEqual(dependancesEcrites('pas de ligne', 'JobAI'), []);
});

test('une tâche au gabarit complet, libre de dépendances, reçoit faisable-jules et un commentaire', () => {
  const g = github({ issues: [tache(195)] });
  const r = marquerFaisables({ depot: 'MoKarade/JobAI', gh: g.gh });
  assert.deepEqual(r.marquees, ['JobAI#195']);
  const w = ecritures(g.appels);
  assert.equal(w.length, 2);
  assert.deepEqual(w[0], { methode: 'POST', chemin: 'repos/MoKarade/JobAI/issues/195/labels', corps: { 'labels[]': 'faisable-jules' } });
  assert.match(w[1].corps.body, /Réservée à Jules automatiquement/);
});

test('refus : pas au gabarit, étiquette qui écarte, déjà marquée, PR ouverte qui la cite', () => {
  const issues = [
    tache(1, [], '**Avant** : x\n'),
    tache(2, ['qui:marc']),
    tache(3, ['bloqué']),
    tache(5, ['preuve-attendue']),
    tache(6, ['sécurité']),
    tache(8),
  ];
  const g = github({ issues, prs: [{ number: 50, title: 'test', body: 'Tâche : #8' }] });
  const r = marquerFaisables({ depot: 'MoKarade/JobAI', gh: g.gh });
  assert.deepEqual(r.marquees, []);
  assert.equal(r.refusees, 6);
  assert.equal(ecritures(g.appels).length, 0);
});

test('dépendance ouverte (écrite ou native), ou illisible : refusée, jamais devinée', () => {
  for (const [issues, etats, natives] of [
    [[tache(10, [], corps(10, { attend: '**Attend** : #99 — reste à livrer' }))], { 'JobAI#99': 'open' }, {}],
    [[tache(11)], {}, { 11: [{ state: 'open' }] }],
    [[tache(12, [], corps(12, { attend: '**Attend** : #98 — x' }))], { 'JobAI#98': 'ERR' }, {}],
    [[tache(13)], {}, { 13: 'ERR' }],
  ]) {
    const g = github({ issues, etats, natives });
    assert.deepEqual(marquerFaisables({ depot: 'MoKarade/JobAI', gh: g.gh }).marquees, [], JSON.stringify(issues[0].number));
    assert.equal(ecritures(g.appels).length, 0);
  }
  const ferme = github({ issues: [tache(14, [], corps(14, { attend: '**Attend** : #97 — x' }))], etats: { 'JobAI#97': 'closed' }, natives: { 14: [{ state: 'closed' }] } });
  assert.deepEqual(marquerFaisables({ depot: 'MoKarade/JobAI', gh: ferme.gh }).marquees, ['JobAI#14']);
});

test(`la réserve est bornée à ${RESERVE_MAX} par dépôt, marquées comprises`, () => {
  const g = github({ issues: [tache(20), tache(21), tache(22), tache(23)] });
  assert.deepEqual(marquerFaisables({ depot: 'MoKarade/JobAI', gh: g.gh }).marquees, ['JobAI#20', 'JobAI#21']);
  const pleine = github({ issues: [tache(30, ['faisable-jules']), tache(31, ['faisable-jules']), tache(32)] });
  const r = marquerFaisables({ depot: 'MoKarade/JobAI', gh: pleine.gh });
  assert.deepEqual(r.marquees, []);
  assert.equal(r.reserve, 2);
  assert.ok(!pleine.appels.some((a) => /pulls/.test(a.chemin)), 'réserve pleine : aucun autre appel');
});

test('dépôt réservé à Claude (hub-contract) et chemin interdit : refusés par evaluerJules', () => {
  const g = github({ issues: [tache(40)] });
  assert.deepEqual(marquerFaisables({ depot: 'MoKarade/hub-contract', gh: g.gh }).marquees, []);
  const g2 = github({ issues: [tache(41, [], corps(41, { sections: { 'Fichiers permis': '(aucun autre) :\n- `.github/workflows/mergify-garde.yml`' } }))] });
  assert.deepEqual(marquerFaisables({ depot: 'MoKarade/JobAI', gh: g2.gh }).marquees, []);
});

test('à blanc : dit ce qu’il marquerait, n’écrit rien', () => {
  const g = github({ issues: [tache(50)] });
  assert.deepEqual(marquerFaisables({ depot: 'MoKarade/JobAI', gh: g.gh, aBlanc: true }).marquees, ['JobAI#50']);
  assert.equal(ecritures(g.appels).length, 0);
});

test('tourJulesSuivi : la ligne dit les tâches marquées ; sans --executer rien n’est écrit', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'mq-')), 'e.json');
  const g = github({ issues: [tache(60)] });
  const ligne = tourJulesSuivi({ fichierEtat: f, executer: true, gh: g.gh, maintenant: new Date('2026-10-19T20:00:00Z'), depots: ['MoKarade/JobAI'] });
  assert.match(ligne, /1 marquée\(s\) faisable-jules \(JobAI#60\)/);
  assert.equal(ecritures(g.appels).length, 2);
  const g2 = github({ issues: [tache(61)] });
  const l2 = tourJulesSuivi({ fichierEtat: f, gh: g2.gh, maintenant: new Date('2026-10-19T20:00:00Z'), depots: ['MoKarade/JobAI'] });
  assert.match(l2, /1 marquée\(s\).*\(non appliqué\)/);
  assert.equal(ecritures(g2.appels).length, 0);
});

test('une tâche qui ajoute un outil MCP reste hors du full auto (corps ou titre), aucun marquage', () => {
  const corpsMcp = corps(70, { sections: { 'À faire': '1. Ajouter `server.registerTool("reanalyser_profil")`.' } });
  const g = github({ issues: [tache(70, [], corpsMcp), { ...tache(71), title: 'Ajouter un outil MCP de relance' }, tache(72, [], corps(72, { sections: { Avant: 'Le serveur MCP n\'a pas de test.' } }))] });
  const r = marquerFaisables({ depot: 'MoKarade/JobAI', gh: g.gh });
  assert.deepEqual(r.marquees, []);
  assert.equal(r.refusees, 3);
  assert.equal(ecritures(g.appels).length, 0);
});

test('retirerPerimees : une étiquette faisable-jules sur un corps que evaluerJules refuse se retire, avec un commentaire qui dit pourquoi', () => {
  const incomplet = tache(198, ['faisable-jules'], '**Avant** : x.\n\n**Après** : y.\n');
  const mcp = tache(199, ['faisable-jules'], corps(199).replace('Un test couvre', 'Un outil MCP de test couvre'));
  const bonne = tache(195, ['faisable-jules']);
  const g = github({ issues: [incomplet, mcp, bonne] });
  const r = retirerPerimees({ depot: 'MoKarade/JobAI', gh: g.gh });
  assert.deepEqual(r, ['JobAI#198', 'JobAI#199']);
  const w = ecritures(g.appels);
  assert.deepEqual(w.filter((a) => a.methode === 'DELETE').map((a) => a.chemin), [
    'repos/MoKarade/JobAI/issues/198/labels/faisable-jules',
    'repos/MoKarade/JobAI/issues/199/labels/faisable-jules',
  ]);
  assert.match(w.find((a) => a.chemin.includes('198/comments')).corps.body, /sections absentes/);
  assert.match(w.find((a) => a.chemin.includes('199/comments')).corps.body, /MCP/);
});

test('retirerPerimees : une tâche déjà confiée (jules, en-cours) ou à dépendance ouverte garde son étiquette ; à blanc rien ne s\'écrit', () => {
  const g = github({ issues: [tache(1, ['faisable-jules', 'jules'], '**Avant** : x.'), tache(2, ['faisable-jules', 'en-cours'], '**Avant** : x.'), tache(3, ['faisable-jules'], corps(3, { attend: '**Attend** : #12 — raison' }))], etats: { 'JobAI#12': 'open' } });
  assert.deepEqual(retirerPerimees({ depot: 'MoKarade/JobAI', gh: g.gh }), []);
  assert.equal(ecritures(g.appels).length, 0);
  const g2 = github({ issues: [tache(198, ['faisable-jules'], '**Avant** : x.')] });
  assert.deepEqual(retirerPerimees({ depot: 'MoKarade/JobAI', gh: g2.gh, aBlanc: true }), ['JobAI#198']);
  assert.equal(ecritures(g2.appels).length, 0);
});

test('prio:3 n’écarte plus le marquage (réponse de Marc du 21/10/2026), sauf Hubperso#247 nommée', () => {
  const g = github({ issues: [tache(195, ['prio:3'])] });
  assert.deepEqual(marquerFaisables({ depot: 'MoKarade/JobAI', gh: g.gh }).marquees, ['JobAI#195']);
  const h = github({ issues: [tache(247, ['prio:3']), tache(248, ['prio:3'])] });
  const r = marquerFaisables({ depot: 'MoKarade/Hubperso', gh: h.gh });
  assert.deepEqual(r.marquees, ['Hubperso#248']);
  assert.equal(r.refusees, 0, 'la tâche exclue par décision n’est pas évaluée, donc pas comptée comme refus');
  assert.equal(ecritures(h.appels).some((a) => /issues\/247\//.test(a.chemin)), false);
  // une tâche #247 d’un autre dépôt n’est pas concernée
  assert.deepEqual(marquerFaisables({ depot: 'MoKarade/JobAI', gh: github({ issues: [tache(247)] }).gh }).marquees, ['JobAI#247']);
});

test('retirerPerimees retire faisable-jules de Hubperso#247 (exclue par décision), pas des autres', () => {
  const g = github({ issues: [tache(247, ['faisable-jules', 'prio:3']), tache(248, ['faisable-jules', 'prio:3'])] });
  const r = retirerPerimees({ depot: 'MoKarade/Hubperso', gh: g.gh });
  assert.deepEqual(r, ['Hubperso#247']);
});
