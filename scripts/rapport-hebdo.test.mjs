import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculer, collecterDepot, cycleRouge, duree, estPremierLundi, lire, mediane, rendre, resumeConformite, titreRapport } from './rapport-hebdo.mjs';

const H = 3_600_000;
const J = 24 * H;
const MAINTENANT = Date.parse('2026-10-19T10:00:00Z'); // lundi
const il_y_a = (ms) => new Date(MAINTENANT - ms).toISOString();

const depotVide = (nom, extra = {}) => ({ nom, lisible: true, taches: [], ouvertes: [], signalements: [], prs: [], couverture: null, conformite: null, ...extra });
const tache = (numero, creeIl, fermeIl, { etiquettes = ['niveau:tâche'], prFusionIl = null, acceptee = true } = {}) => ({
  numero,
  etiquettes,
  creeLe: il_y_a(creeIl),
  fermeLe: il_y_a(fermeIl),
  acceptee: acceptee ? { le: il_y_a(fermeIl), prFusionLe: prFusionIl == null ? null : il_y_a(prFusionIl) } : null,
});
const ouverte = (numero, etiquettes, extra = {}) => ({ numero, titre: `t${numero}`, etiquettes, creeLe: il_y_a(2 * J), majLe: il_y_a(1 * J), parent: true, corps: '', ...extra });

test('mediane et duree', () => {
  assert.equal(mediane([]), null);
  assert.equal(mediane([3, 1, 2]), 2);
  assert.equal(mediane([1, 2, 3, 4]), 2.5);
  assert.equal(duree(null), '—');
  assert.equal(duree(5 * 60_000), '5 min');
  assert.equal(duree(2 * H + 5 * 60_000), '2 h 05');
  assert.equal(duree(3 * J + 4 * H), '3 j 4 h');
});

test('vitesse : acceptées de la semaine seulement, délais, part prouvée dans l\'heure, par dépôt et exécutant', () => {
  const r = calculer({
    maintenant: MAINTENANT,
    depots: [
      depotVide('a', {
        taches: [
          tache(1, 3 * J, 2 * J, { prFusionIl: 2 * J + 30 * 60_000 }), // acceptée 1 j après création, prouvée en 30 min
          tache(2, 5 * J, 1 * J, { prFusionIl: 1 * J + 3 * H, etiquettes: ['niveau:tâche', 'jules'] }), // 3 h
          tache(3, 40 * J, 20 * J), // hors fenêtre
          tache(4, 2 * J, 1 * J, { acceptee: false }), // fermée sans preuve
        ],
      }),
      depotVide('b', { taches: [tache(5, 2 * J, 1 * J)] }),
      { nom: 'prive', lisible: false },
    ],
  });
  assert.equal(r.vitesse.acceptees, 3);
  assert.deepEqual(r.vitesse.parDepot, { a: 2, b: 1 });
  assert.deepEqual(r.vitesse.parExecutant, { fil: 2, Jules: 1 });
  assert.equal(r.vitesse.acceptation.max, 4 * J);
  assert.equal(r.vitesse.acceptation.mediane, 1 * J);
  assert.equal(r.vitesse.preuve.n, 2);
  assert.equal(r.vitesse.preuve.max, 3 * H);
  assert.equal(r.vitesse.preuve.dansLHeure, 0.5);
  assert.deepEqual(r.illisibles, ['prive']);
});

test('cycleRouge : échec puis succès du même workflow, ou échec jamais résolu', () => {
  const run = (nom, conclusion, minutes) => ({ nom, conclusion, creeLe: il_y_a(10 * H - minutes * 60_000), finLe: il_y_a(10 * H - (minutes + 2) * 60_000) });
  const c = cycleRouge([run('CI', 'failure', 0), run('CI', 'success', 30), run('Sécurité', 'success', 0)]);
  assert.equal(c.rouge, true);
  assert.equal(c.retours.length, 1);
  assert.ok(c.retours[0] >= 30 * 60_000);
  assert.equal(c.nonResolue, false);
  assert.deepEqual(cycleRouge([run('CI', 'success', 0)]), { rouge: false, retours: [], nonResolue: false });
  // Un succès d'un AUTRE workflow ne referme pas le rouge de celui-ci.
  const autre = cycleRouge([run('CI', 'failure', 0), run('Sécurité', 'success', 20)]);
  assert.equal(autre.rouge, true);
  assert.equal(autre.nonResolue, true);
  // Un succès AVANT l'échec ne compte pas.
  assert.equal(cycleRouge([run('CI', 'success', 0), run('CI', 'failure', 20)]).nonResolue, true);
});

test('qualité : PR rouges de la semaine, incidents et pannes comptés dans la fenêtre', () => {
  const run = (conclusion, h) => ({ nom: 'CI', conclusion, creeLe: il_y_a(h * H), finLe: il_y_a((h - 1) * H) });
  const r = calculer({
    maintenant: MAINTENANT,
    depots: [
      depotVide('a', {
        prs: [
          { numero: 1, majLe: il_y_a(2 * J), fusionLe: il_y_a(2 * J), corps: '', runs: [run('failure', 50), run('success', 48)] },
          { numero: 2, majLe: il_y_a(1 * J), fusionLe: null, corps: '', runs: [run('failure', 20)] },
          { numero: 3, majLe: il_y_a(1 * J), fusionLe: null, corps: '', runs: [run('success', 20)] },
          { numero: 4, majLe: il_y_a(20 * J), fusionLe: il_y_a(20 * J), corps: '', runs: [run('failure', 500)] }, // hors fenêtre
        ],
        signalements: [
          { numero: 9, etiquettes: ['incident'], creeLe: il_y_a(1 * J) },
          { numero: 10, etiquettes: ['panne'], creeLe: il_y_a(2 * J) },
          { numero: 11, etiquettes: ['panne'], creeLe: il_y_a(9 * J) }, // trop vieux
        ],
      }),
    ],
  });
  assert.equal(r.qualite.prRouges, 2);
  assert.equal(r.qualite.nonResolues, 1);
  assert.equal(r.qualite.retourAuVert.n, 1);
  assert.equal(r.qualite.incidents, 1);
  assert.equal(r.qualite.pannes, 1);
});

test('backlog : bloquées > 7 j, gestes de Marc avec âge, orphelines, fusionnées non prouvées, preuves programmées', () => {
  const r = calculer({
    maintenant: MAINTENANT,
    depots: [
      depotVide('a', {
        ouvertes: [
          ouverte(1, ['niveau:tâche', 'bloqué'], { majLe: il_y_a(8 * J) }),
          ouverte(2, ['niveau:tâche', 'bloqué'], { majLe: il_y_a(3 * J) }),
          ouverte(3, ['niveau:tâche', 'qui:marc'], { creeLe: il_y_a(4 * J) }),
          ouverte(4, ['niveau:tâche'], { parent: false }),
          ouverte(5, ['niveau:mission'], { parent: false }),
          ouverte(6, ['niveau:tâche'], { corps: 'x\n**Preuve attendue** : 2026-10-20 06:15 (heure du Québec) — cron\n' }),
          ouverte(7, ['niveau:tâche']),
        ],
        prs: [
          { numero: 70, majLe: il_y_a(1 * J), fusionLe: il_y_a(3 * H), corps: 'Tâche : #7\n', runs: [] },
          { numero: 71, majLe: il_y_a(1 * J), fusionLe: il_y_a(3 * H), corps: 'Tâche : #99\n', runs: [] }, // issue déjà fermée
          { numero: 72, majLe: il_y_a(1 * J), fusionLe: null, corps: 'Tâche : #7\n', runs: [] }, // pas fusionnée
        ],
      }),
    ],
  });
  assert.deepEqual(r.backlog.bloquees.map((o) => o.numero), [1]);
  assert.deepEqual(r.backlog.gestes.map((g) => [g.numero, g.age]), [[3, 4 * J]]);
  assert.deepEqual(r.backlog.orphelines.map((o) => o.numero), [4]);
  assert.deepEqual(r.backlog.nonProuvees.map((n) => [n.tache, n.pr]), [[7, 70]]);
  assert.deepEqual(r.backlog.preuves, [{ depot: 'a', numero: 6, quand: '2026-10-20 06:15 (heure du Québec) — cron' }]);
});

test('rendu : sections, "non mesuré" dit, jamais un zéro inventé pour un dépôt illisible', () => {
  const r = calculer({ maintenant: MAINTENANT, depots: [depotVide('a'), { nom: 'CarAI', lisible: false }] });
  const texte = rendre(r);
  for (const titre of ['## Vitesse', '## Qualité', '## Santé du backlog']) assert.match(texte, new RegExp(titre));
  assert.match(texte, /Dépôts illisibles.*CarAI/);
  assert.match(texte, /Tests instables : non mesuré/);
  assert.match(texte, /Retours en arrière Vercel : non mesuré/);
  assert.match(texte, /\| a \| non mesuré \| non mesuré \|/);
  assert.doesNotMatch(texte, /CarAI \|/);
  assert.doesNotMatch(texte, /Revue de la grille/);
});

test('premier lundi du mois : la revue de la grille s\'ajoute, avec les lignes rouges par dépôt', () => {
  assert.equal(estPremierLundi(Date.parse('2026-11-02T11:00:00Z')), true);
  assert.equal(estPremierLundi(Date.parse('2026-10-19T10:00:00Z')), false);
  assert.equal(estPremierLundi(Date.parse('2026-10-05T10:00:00Z')), true);
  const conf = resumeConformite([{ n: 1, etat: 'rouge' }, { n: 2, etat: 'vert' }, { n: 3, etat: 'non-verifiable' }, { n: 4, etat: 'sans-objet' }]);
  assert.deepEqual(conf, { vert: 1, rouge: 1, aRelire: 1, sansObjet: 1, lignesRouges: [1] });
  const r = calculer({ maintenant: MAINTENANT, depots: [depotVide('a', { conformite: conf }), depotVide('b', { conformite: conf })] });
  const texte = rendre(r, { premierLundi: true });
  assert.match(texte, /## Revue de la grille/);
  assert.match(texte, /Ligne 1 : 2 dépôt\(s\) — a, b/);
  assert.match(texte, /\| a \| non mesuré \| 1 vert · 1 rouge · 1 à relire · 1 sans objet \|/);
  assert.equal(resumeConformite(null), null);
});

test('titre : jour de début de la période, heure du Québec', () => {
  assert.equal(titreRapport(Date.parse('2026-10-12T10:00:00Z')), 'Rapport de la semaine du 2026-10-12');
});

test('lire : aplatit les pages, avec ou sans clé', async () => {
  const gh = async (args) => {
    assert.deepEqual(args.slice(0, 3), ['api', '--paginate', '--slurp']);
    return args.at(-1).includes('runs') ? JSON.stringify([{ workflow_runs: [1] }, { workflow_runs: [2, 3] }]) : JSON.stringify([[1, 2], [3]]);
  };
  assert.deepEqual(await lire(gh, 'repos/x/issues'), [1, 2, 3]);
  assert.deepEqual(await lire(gh, 'repos/x/actions/runs', 'workflow_runs'), [1, 2, 3]);
});

test('collecterDepot : dépôt privé illisible ; dépôt lisible normalisé (issues sans PR, acceptation, parent)', async () => {
  const prive = async () => {
    throw Object.assign(new Error('gh api a échoué : gh: Not Found (HTTP 404)'), { stderr: 'gh: Not Found (HTTP 404)' });
  };
  assert.deepEqual(await collecterDepot(prive, 'CarAI', MAINTENANT, () => null), { nom: 'CarAI', lisible: false });
  const enPanne = async () => {
    throw Object.assign(new Error('gh api a échoué : HTTP 502'), { stderr: 'HTTP 502' });
  };
  await assert.rejects(() => collecterDepot(enPanne, 'x', MAINTENANT, () => null), /502/);

  const issue = (n, extra = {}) => ({ number: n, title: `t${n}`, labels: [{ name: 'niveau:tâche' }], created_at: il_y_a(3 * J), updated_at: il_y_a(1 * J), closed_at: null, body: '', state: 'open', ...extra });
  const reponses = [
    [/--jq \.full_name$/, () => 'MoKarade/x'],
    [/issues\?state=all/, () => [[issue(1, { state: 'closed', state_reason: 'completed', closed_at: il_y_a(1 * J) }), issue(2, { pull_request: {} })]]],
    [/issues\?state=open/, () => [[issue(3, { parent_issue_url: 'u' }), issue(4)]]],
    [/issues\/1\/comments/, () => [[{ body: '**Acceptée** — PR #12 fusionnée', created_at: il_y_a(1 * J) }]]],
    [/pulls\/12 --jq/, () => '{"m":"' + il_y_a(1 * J + 20 * 60_000) + '"}'],
    [/pulls\?state=all/, () => [[{ number: 12, updated_at: il_y_a(1 * J), merged_at: il_y_a(1 * J), body: 'Tâche : #1', head: { ref: 'claude/x' } }]]],
    [/actions\/runs/, () => [{ workflow_runs: [{ name: 'CI', conclusion: 'success', created_at: il_y_a(1 * J), updated_at: il_y_a(1 * J) }] }]],
    [/contents\/qualite\/seuils\.json/, () => Buffer.from(JSON.stringify({ portes: { 'couverture.lignes': { min: 80 }, 'code_mort': { max: 3 } } })).toString('base64')],
  ];
  const gh = async (args) => {
    const cle = args.join(' ');
    const [, f] = reponses.find(([re]) => re.test(cle)) ?? [];
    assert.ok(f, `appel inattendu : ${cle}`);
    const v = f();
    return typeof v === 'string' ? v : JSON.stringify(v);
  };
  const d = await collecterDepot(gh, 'x', MAINTENANT, () => ({ vert: 1, rouge: 0, aRelire: 0, sansObjet: 0, lignesRouges: [] }));
  assert.equal(d.lisible, true);
  assert.deepEqual(d.taches.map((t) => [t.numero, Boolean(t.acceptee), t.acceptee?.prFusionLe != null]), [[1, true, true]]);
  assert.deepEqual(d.ouvertes.map((o) => [o.numero, o.parent]), [[3, true], [4, false]]);
  assert.equal(d.signalements.length, 1, 'les PR sont écartées des issues');
  assert.deepEqual(d.couverture, { 'couverture.lignes': 80 });
  assert.equal(d.prs[0].runs[0].nom, 'CI');
  assert.equal(d.conformite.vert, 1);
});
