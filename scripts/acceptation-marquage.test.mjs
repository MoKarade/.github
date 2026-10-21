import test from 'node:test';
import assert from 'node:assert/strict';
import { aUneLigne, completerDepot, composerLigne, estMarquee, evaluerMarquage, sansLigne, MARQUEUR } from './acceptation-marquage.mjs';
import { LIGNE_AUTO } from './acceptation-auto.mjs';

const corps = ({ fini = '`node --test scripts/a.test.mjs` est vert, la CI est verte.', apres = 'La fonction rend la liste triée.', fichiers = ['scripts/a.mjs', 'scripts/a.test.mjs'], extra = '' } = {}) =>
  `**Avant** : elle rend la liste dans le désordre.\n\n**Après** : ${apres}\n\n**Fini quand** : ${fini}\n\n**Source** : demande.\n\n**Fichiers touchés** :\n${fichiers.map((f) => `- \`${f}\``).join('\n')}\n\n**Attend** : aucune\n${extra}`;

test('éligible : un test et la CI, des fichiers connus sans écran', () => {
  assert.deepEqual(evaluerMarquage({ titre: 'Trier la liste', corps: corps() }), { ok: true, raison: '' });
});

test('chaque exclusion rend « pas éligible » avec sa raison', () => {
  const non = (o, motif) => {
    const r = evaluerMarquage({ titre: 't', corps: corps(o) });
    assert.equal(r.ok, false, JSON.stringify(o));
    assert.match(r.raison, motif);
  };
  non({ fini: 'la réponse HTTP 200 sur /api/x' }, /HTTP|contrôle de machine/);
  non({ fini: 'les tests passent et https://x.hubperso.com répond' }, /HTTP ou URL/);
  non({ fini: 'les tests passent et l\'écran montre la carte' }, /écran/);
  non({ fini: 'la CI est verte et la donnée est en base' }, /donnée/);
  non({ fini: 'la CI est verte et la production répond' }, /production/);
  non({ fini: 'la CI est verte, preuve ensuite sur le PC' }, /preuve ensuite|PC/);
  non({ fini: 'les tests passent, preuve : 24 h plus tard' }, /preuve ensuite|durée/);
  non({ fini: 'les tests passent après 24 h' }, /durée/);
  non({ fini: 'les tests passent et la page affiche la courbe' }, /écran|page/);
  non({ fini: 'c\'est joli' }, /aucun contrôle de machine/);
  non({ apres: 'La carte s\'affiche sur l\'écran d\'accueil.' }, /Après/);
  non({ fichiers: ['components/Carte.tsx', 'tests/carte.test.ts'] }, /écran touché/);
  non({ fichiers: ['public/logo.png'] }, /écran touché/);
  non({ fichiers: Array.from({ length: 11 }, (_, i) => `scripts/f${i}.mjs`) }, /plus de 10/);
  assert.match(evaluerMarquage({ titre: 't', corps: '**Après** : x\n**Fini quand** : tests verts\n' }).raison, /fichiers touchés inconnus/);
  assert.match(evaluerMarquage({ titre: 't', corps: '**Après** : x\n**Fichiers touchés** : non déterminés (raison)\n**Fini quand** : tests verts\n' }).raison, /inconnus/);
  assert.match(evaluerMarquage({ titre: 't', corps: '**Après** : x\n' }).raison, /pas de « Fini quand »/);
  assert.match(evaluerMarquage({ titre: 'Afficher la carte', corps: corps() }).raison, /titre/);
});

test('la ligne composée passe LIGNE_AUTO et se retire proprement', () => {
  const avec = `${corps().replace(/\s+$/, '')}\n\n${composerLigne()}`;
  assert.match(avec, LIGNE_AUTO);
  assert.ok(estMarquee(avec));
  assert.equal(sansLigne(avec), corps().replace(/\s+$/, ''));
  assert.ok(!aUneLigne(avec), 'la ligne de ce script ne compte pas comme une décision de quelqu\'un');
  assert.ok(aUneLigne('**Acceptation automatique** : non — écran'));
  assert.ok(aUneLigne('- **Acceptation automatique** : oui — CI'));
});

// ── I/O simulé ──
function ghSimule(issues, { edite = {} } = {}) {
  const appels = [];
  const gh = (methode, chemin, charge) => {
    appels.push(`${methode} ${chemin}`);
    if (methode === 'GET' && chemin.includes('/issues?')) return issues;
    const m = /issues\/(\d+)$/.exec(chemin);
    if (methode === 'GET' && m) { const i = issues.find((x) => x.number === Number(m[1])); return { ...i, ...(edite[i.number] ?? {}) }; }
    if (methode === 'PATCH' && m) { issues.find((x) => x.number === Number(m[1])).body = charge.body; return {}; }
    throw new Error(`appel inattendu ${methode} ${chemin}`);
  };
  return { gh, appels };
}
const tache = (n, o = {}) => ({ number: n, title: `Tâche ${n}`, body: corps(), labels: [{ name: 'niveau:tâche' }, { name: 'prio:2' }], updated_at: `t${n}`, ...o });

test('completerDepot : écrit la ligne à la fin, sans toucher au texte, et respecte le budget', () => {
  const issues = [tache(1), tache(2), tache(3)];
  const avant = issues.map((i) => i.body);
  const { gh } = ghSimule(issues);
  const budget = { restant: 2 };
  const r = completerDepot({ depot: 'MoKarade/CarAI', gh, budget });
  assert.deepEqual(r.ecrites, ['CarAI#1', 'CarAI#2']);
  assert.equal(budget.restant, 0);
  assert.ok(issues[0].body.startsWith(avant[0].replace(/\s+$/, '')));
  assert.match(issues[0].body, LIGNE_AUTO);
  assert.equal(issues[2].body, avant[2]);
});

test('completerDepot : rien pour une ligne existante, une étiquette d\'attente, Jules, une PR, un corps inéligible', () => {
  const issues = [
    tache(1, { body: `${corps()}\n**Acceptation automatique** : non — écran\n` }),
    tache(2, { labels: [{ name: 'niveau:tâche' }, { name: 'preuve-attendue' }] }),
    tache(3, { labels: [{ name: 'niveau:tâche' }, { name: 'qui:marc' }] }),
    tache(4, { labels: [{ name: 'niveau:tâche' }, { name: 'jules' }] }),
    tache(5, { pull_request: {} }),
    tache(6, { body: corps({ fini: 'la production répond' }) }),
    tache(7, { labels: [{ name: 'niveau:mission' }] }),
  ];
  const { gh, appels } = ghSimule(issues);
  assert.deepEqual(completerDepot({ depot: 'MoKarade/CarAI', gh }), { ecrites: [], retirees: [] });
  assert.ok(!appels.some((a) => a.startsWith('PATCH')));
});

test('completerDepot : une tâche en cours reste permise', () => {
  const issues = [tache(1, { labels: [{ name: 'niveau:tâche' }, { name: 'en-cours' }] })];
  const { gh } = ghSimule(issues);
  assert.deepEqual(completerDepot({ depot: 'MoKarade/CarAI', gh }).ecrites, ['CarAI#1']);
});

test('completerDepot : un corps édité entre-temps n\'est pas écrasé', () => {
  const issues = [tache(1)];
  const avant = issues[0].body;
  const { gh, appels } = ghSimule(issues, { edite: { 1: { updated_at: 'plus-tard' } } });
  const budget = { restant: 3 };
  assert.deepEqual(completerDepot({ depot: 'MoKarade/CarAI', gh, budget }).ecrites, []);
  assert.equal(issues[0].body, avant);
  assert.equal(budget.restant, 3);
  assert.ok(!appels.some((a) => a.startsWith('PATCH')));
});

test('completerDepot : la ligne posée ici est retirée quand le corps ne la justifie plus, jamais pour une étiquette', () => {
  const posee = (c) => `${c.replace(/\s+$/, '')}\n\n${composerLigne()}`;
  const issues = [
    tache(1, { body: posee(corps({ fini: 'la production répond' })) }),
    tache(2, { body: posee(corps()), labels: [{ name: 'niveau:tâche' }, { name: 'preuve-attendue' }] }),
  ];
  const { gh } = ghSimule(issues);
  const r = completerDepot({ depot: 'MoKarade/CarAI', gh });
  assert.deepEqual(r.retirees, ['CarAI#1']);
  assert.doesNotMatch(issues[0].body, new RegExp(MARQUEUR));
  assert.ok(estMarquee(issues[1].body));
  assert.deepEqual(r.ecrites, []);
});

test('completerDepot : à blanc ne lit ni n\'écrit rien d\'autre que la liste', () => {
  const issues = [tache(1)];
  const { gh, appels } = ghSimule(issues);
  const r = completerDepot({ depot: 'MoKarade/CarAI', gh, aBlanc: true });
  assert.deepEqual(r.ecrites, ['CarAI#1']);
  assert.deepEqual(appels, ['GET repos/MoKarade/CarAI/issues?state=open&per_page=100']);
});
