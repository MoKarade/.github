import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculer, collecterDepot, cycleRouge, depuisEffectifs, duree, estPremierLundi, executantDe, ligneCachee, lire, lireLigneCachee, mediane, rendre, repartition, resumeConformite, titreRapport } from './rapport-hebdo.mjs';

const H = 3_600_000;
const J = 24 * H;
const MAINTENANT = Date.parse('2026-10-19T10:00:00Z'); // lundi
const il_y_a = (ms) => new Date(MAINTENANT - ms).toISOString();

const depotVide = (nom, extra = {}) => ({ nom, lisible: true, taches: [], ouvertes: [], signalements: [], prs: [], couverture: null, conformite: null, ...extra });
const tache = (numero, creeIl, fermeIl, { etiquettes = ['niveau:tâche'], prFusionIl = null, acceptee = true, auteurPr = 'MoKarade', assignes = [] } = {}) => ({
  numero,
  etiquettes,
  auteurPr,
  assignes,
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
          tache(2, 5 * J, 1 * J, { prFusionIl: 1 * J + 3 * H, etiquettes: ['niveau:tâche', 'jules'], auteurPr: 'google-labs-jules[bot]' }), // 3 h
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
  assert.deepEqual([r.vitesse.parExecutant.fil, r.vitesse.parExecutant.Jules, r.vitesse.parExecutant.Copilot, r.vitesse.parExecutant.inconnu], [2, 1, 0, 0]);
  assert.equal(r.vitesse.acceptation.max, 4 * J);
  assert.equal(r.vitesse.acceptation.mediane, 1 * J);
  assert.equal(r.vitesse.preuve.n, 2);
  assert.equal(r.vitesse.preuve.max, 3 * H);
  assert.equal(r.vitesse.preuve.dansLHeure, 0.5);
  assert.deepEqual(r.illisibles, ['prive']);
});

test('executantDe : Jules, Copilot, fil Claude ; sans signal l\'auteur est inconnu, pas « fil »', () => {
  assert.equal(executantDe({ etiquettes: ['jules'] }), 'Jules');
  assert.equal(executantDe({ auteurPr: 'google-labs-jules[bot]' }), 'Jules');
  assert.equal(executantDe({ auteurPr: 'copilot-swe-agent[bot]' }), 'Copilot');
  assert.equal(executantDe({ auteurPr: 'Copilot' }), 'Copilot');
  assert.equal(executantDe({ assignes: ['Copilot'], auteurPr: 'MoKarade' }), 'Copilot');
  assert.equal(executantDe({ auteurPr: 'MoKarade' }), 'fil');
  assert.equal(executantDe({}), null);
  assert.equal(executantDe({ etiquettes: ['niveau:tâche'] }), null);
});

test('repartition : effectifs et parts entières, aucune part inventée sans tâche', () => {
  const r = repartition([{ auteurPr: 'MoKarade' }, { auteurPr: 'MoKarade' }, { auteurPr: 'Copilot' }, {}]);
  assert.deepEqual([r.total, r.fil, r.Jules, r.Copilot, r.inconnu], [4, 2, 0, 1, 1]);
  assert.deepEqual(r.parts, { fil: 50, Jules: 0, Copilot: 25, inconnu: 25 });
  const vide = repartition([]);
  assert.equal(vide.total, 0);
  assert.deepEqual(vide.parts, { fil: null, Jules: null, Copilot: null, inconnu: null });
});

test('par auteur : Copilot compté à part, semaine ET cumul sur plusieurs semaines, quota Claude « non mesuré »', () => {
  const depuisCumul = MAINTENANT - 20 * J; // première livraison de la mission, il y a trois semaines
  const r = calculer({
    maintenant: MAINTENANT,
    cumulDepuis: depuisCumul,
    depots: [
      depotVide('a', {
        taches: [
          tache(1, 3 * J, 2 * J), // semaine : fil
          tache(2, 3 * J, 2 * J, { auteurPr: 'copilot-swe-agent[bot]' }), // semaine : Copilot
          tache(3, 12 * J, 10 * J, { auteurPr: 'copilot-swe-agent[bot]' }), // semaine -2 : cumul seulement
          tache(4, 16 * J, 15 * J, { etiquettes: ['niveau:tâche', 'jules'], auteurPr: 'google-labs-jules[bot]' }), // cumul seulement
          tache(5, 19 * J, 18 * J, { auteurPr: null }), // cumul : auteur non établi (aucune PR citée)
          tache(6, 30 * J, 25 * J), // avant la première livraison : hors cumul
        ],
      }),
    ],
  });
  const s = r.vitesse.parExecutant;
  assert.deepEqual([s.total, s.fil, s.Copilot, s.Jules, s.inconnu], [2, 1, 1, 0, 0]);
  assert.deepEqual([s.parts.fil, s.parts.Copilot], [50, 50]);
  const c = r.vitesse.cumul;
  assert.deepEqual([c.total, c.fil, c.Copilot, c.Jules, c.inconnu], [5, 1, 2, 1, 1]);
  assert.deepEqual(c.parts, { fil: 20, Jules: 20, Copilot: 40, inconnu: 20 });
  assert.equal(c.depuis, depuisCumul);
  assert.equal(c.limite, false);
  const texte = rendre(r);
  assert.match(texte, /Tâches acceptées : \*\*2\*\* — fil Claude 1 \(50 %\), Jules 0 \(0 %\), Copilot 1 \(50 %\)\./);
  assert.match(texte, /Cumul depuis le 2026-09-29 .*: \*\*5\*\* — fil Claude 1 \(20 %\), Jules 1 \(20 %\), Copilot 2 \(40 %\), auteur non établi 1 \(20 %\)\./);
  assert.match(texte, /Quota Claude consommé : non mesuré/);
  assert.doesNotMatch(texte, /lecture limitée/);
});

test('par auteur : cumul plus vieux que la lecture = lecture limitée, dite ; semaine vide = « aucune », pas de pourcentage', () => {
  const r = calculer({ maintenant: MAINTENANT, cumulDepuis: MAINTENANT - 400 * J, depots: [depotVide('a', { taches: [tache(1, 50 * J, 45 * J), tache(2, 3 * J, 2 * J)] })] });
  assert.equal(r.vitesse.cumul.total, 1, 'la tâche de -45 j dépasse CUMUL_MAX_JOURS');
  assert.equal(r.vitesse.cumul.limite, true);
  assert.match(rendre(r), /lecture limitée aux 42 derniers jours/);
  const vide = calculer({ maintenant: MAINTENANT, cumulDepuis: MAINTENANT - 5 * J, depots: [depotVide('a')] });
  const texte = rendre(vide);
  assert.match(texte, /Tâches acceptées : \*\*0\*\* — aucune\./);
  assert.doesNotMatch(texte, /NaN|null/);
});

const effectifs = (fil, Jules, Copilot, inconnu) => ({ fil, Jules, Copilot, inconnu, total: fil + Jules + Copilot + inconnu });
const baseDe = (finIl, e, depuisIl = 6 * J) => ({ fin: MAINTENANT - finIl, depuis: MAINTENANT - depuisIl, ...e });

test('ligne cachée : écrite puis relue à l\'identique, invisible (commentaire HTML)', () => {
  const cumul = { depuis: MAINTENANT - 6 * J, ...depuisEffectifs({ fil: 10, Jules: 2, Copilot: 1, inconnu: 3 }) };
  const ligne = ligneCachee(cumul, MAINTENANT - 1 * J);
  assert.match(ligne, /^<!-- cumul-par-auteur : \{.*\} -->$/);
  const lu = lireLigneCachee(`## Vitesse\n\n${ligne}`, MAINTENANT);
  assert.equal(lu.etat, 'ok');
  assert.deepEqual(lu.base, { fin: MAINTENANT - 1 * J, depuis: MAINTENANT - 6 * J, total: 16, fil: 10, Jules: 2, Copilot: 1, inconnu: 3 });
});

test('ligne cachée : absente, illisible ou incohérente → jamais utilisée (départ complet)', () => {
  const bon = { fin: '2026-10-18T10:00:00.000Z', depuis: '2026-10-12T10:00:00.000Z', total: 3, fil: 1, Jules: 1, Copilot: 1, inconnu: 0 };
  const avec = (v) => `<!-- cumul-par-auteur : ${typeof v === 'string' ? v : JSON.stringify(v)} -->`;
  assert.deepEqual(lireLigneCachee('rapport ancien format', MAINTENANT), { etat: 'absente' });
  assert.deepEqual(lireLigneCachee(undefined, MAINTENANT), { etat: 'absente' });
  assert.equal(lireLigneCachee(avec(bon), MAINTENANT).etat, 'ok');
  assert.match(lireLigneCachee(avec('{pas du json}'), MAINTENANT).raison, /JSON/);
  assert.match(lireLigneCachee(avec({ ...bon, fin: 'demain' }), MAINTENANT).raison, /date/);
  assert.match(lireLigneCachee(avec({ ...bon, fil: -1 }), MAINTENANT).raison, /effectif/);
  assert.match(lireLigneCachee(avec({ ...bon, fil: 1.5 }), MAINTENANT).raison, /effectif/);
  assert.match(lireLigneCachee(avec({ ...bon, total: 9 }), MAINTENANT).raison, /total/);
  assert.match(lireLigneCachee(avec({ ...bon, depuis: '2026-10-19T00:00:00.000Z' }), MAINTENANT).raison, /début après la fin/);
  assert.match(lireLigneCachee(avec({ ...bon, fin: '2026-10-20T10:00:00.000Z', depuis: '2026-10-12T10:00:00.000Z' }), MAINTENANT).raison, /futur/);
});

test('cumul repris : base + tâches acceptées STRICTEMENT après sa fin, rien avant n\'est recompté', () => {
  const base = baseDe(2 * J, effectifs(10, 1, 0, 2)); // 13 tâches jusqu'à il y a 2 jours
  const r = calculer({
    maintenant: MAINTENANT,
    base,
    depots: [
      depotVide('a', {
        taches: [
          tache(1, 5 * J, 2 * J), // fermée EXACTEMENT à la fin de la base : déjà comptée dans la base
          tache(2, 4 * J, 2 * J - 1), // 1 ms après : nouvelle (fil)
          tache(3, 3 * J, 1 * J, { auteurPr: 'copilot-swe-agent[bot]' }), // nouvelle (Copilot)
          tache(4, 6 * J, 3 * J), // avant la base : déjà comptée
        ],
      }),
    ],
  });
  const c = r.vitesse.cumul;
  assert.deepEqual([c.total, c.fil, c.Jules, c.Copilot, c.inconnu], [15, 11, 1, 1, 2]);
  assert.equal(c.nouvelles, 2);
  assert.equal(c.repris, true);
  assert.equal(c.limite, false);
  assert.equal(c.depuis, base.depuis);
  assert.deepEqual(c.parts, { fil: 73, Jules: 7, Copilot: 7, inconnu: 13 });
});

test('cumul repris : sans nouvelle tâche le cumul ne bouge pas ; base plus vieille que la lecture = trou dit', () => {
  const base = baseDe(1 * J, effectifs(4, 0, 0, 0));
  const r = calculer({ maintenant: MAINTENANT, base, depots: [depotVide('a')] });
  assert.deepEqual([r.vitesse.cumul.total, r.vitesse.cumul.nouvelles], [4, 0]);
  const vieille = calculer({ maintenant: MAINTENANT, base: baseDe(60 * J, effectifs(4, 0, 0, 0), 70 * J), depots: [depotVide('a', { taches: [tache(1, 50 * J, 45 * J), tache(2, 3 * J, 2 * J)] })] });
  assert.equal(vieille.vitesse.cumul.total, 5, 'base + la seule tâche lue dans les 42 jours');
  assert.equal(vieille.vitesse.cumul.limite, true);
  assert.match(rendre(vieille), /lecture limitée aux 42 derniers jours/);
});

test('rendu du cumul : repris (avec le nombre de nouvelles) ou relu en entier avec la raison ; appels écrits', () => {
  const repris = calculer({ maintenant: MAINTENANT, base: baseDe(2 * J, effectifs(3, 0, 0, 0)), depots: [depotVide('a', { taches: [tache(1, 3 * J, 1 * J)] })] });
  const t1 = rendre({ ...repris, lecture: { taches: 14, total: 90 } });
  assert.match(t1, /repris du rapport précédent, plus 1 tâche\(s\) acceptée\(s\) depuis/);
  assert.match(t1, /: \*\*4\*\* — fil Claude 4 \(100 %\)/);
  assert.match(t1, /\*\*14\*\* appels pour relire les tâches acceptées.*90 appels au total/);
  const entier = calculer({ maintenant: MAINTENANT, cumulDepuis: MAINTENANT - 5 * J, depots: [depotVide('a')] });
  assert.match(rendre({ ...entier, cumulSource: 'la ligne cachée du rapport #9 est illisible (JSON invalide)' }), /relu en entier : la ligne cachée du rapport #9 est illisible \(JSON invalide\)/);
  assert.match(rendre(entier), /relu en entier : aucun rapport précédent/);
  assert.doesNotMatch(rendre(entier), /appels pour relire/, 'pas de ligne de lecture sans compteur');
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
    [/issues\?state=all/, () => [[issue(1, { state: 'closed', state_reason: 'completed', closed_at: il_y_a(1 * J), assignees: [{ login: 'Copilot' }] }), issue(2, { pull_request: {} })]]],
    [/issues\?state=open/, () => [[issue(3, { parent_issue_url: 'u' }), issue(4)]]],
    [/issues\/1\/comments/, () => [[{ body: '**Acceptée** — PR #12 fusionnée', created_at: il_y_a(1 * J) }]]],
    [/pulls\/12 --jq/, () => '{"m":"' + il_y_a(1 * J + 20 * 60_000) + '","a":"copilot-swe-agent[bot]"}'],
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
  const compteur = { taches: 0 };
  const d = await collecterDepot(gh, 'x', MAINTENANT, () => ({ vert: 1, rouge: 0, aRelire: 0, sansObjet: 0, lignesRouges: [] }), undefined, compteur);
  assert.equal(compteur.taches, 2, 'une tâche acceptée = un commentaire + une PR relus');
  assert.equal(d.lisible, true);
  assert.deepEqual(d.taches.map((t) => [t.numero, Boolean(t.acceptee), t.acceptee?.prFusionLe != null]), [[1, true, true]]);
  assert.deepEqual([d.taches[0].auteurPr, d.taches[0].assignes], ['copilot-swe-agent[bot]', ['Copilot']]);
  assert.equal(executantDe(d.taches[0]), 'Copilot');
  assert.deepEqual(d.ouvertes.map((o) => [o.numero, o.parent]), [[3, true], [4, false]]);
  assert.equal(d.signalements.length, 1, 'les PR sont écartées des issues');
  assert.deepEqual(d.couverture, { 'couverture.lignes': 80 });
  assert.equal(d.prs[0].runs[0].nom, 'CI');
  assert.equal(d.conformite.vert, 1);
});

test('gestes de Marc ouverts depuis plus de 7 jours : listés avec leur raison, « raison non écrite » si elle manque', () => {
  const r = calculer({
    maintenant: MAINTENANT,
    depots: [
      depotVide('a', {
        ouvertes: [
          ouverte(1, ['niveau:tâche', 'qui:marc'], { creeLe: il_y_a(9 * J), corps: 'Geste : ouvrir la page\nPourquoi lui seul : c\'est son compte' }),
          ouverte(2, ['niveau:tâche', 'qui:marc'], { creeLe: il_y_a(8 * J), corps: 'Geste : ouvrir la page', commentaires: ['Pourquoi lui seul : décision d\'argent'] }),
          ouverte(3, ['niveau:tâche', 'qui:marc'], { creeLe: il_y_a(10 * J), corps: 'Avant : x' }),
          ouverte(4, ['niveau:tâche', 'qui:marc'], { creeLe: il_y_a(2 * J) }),
          ouverte(5, ['niveau:tâche'], { creeLe: il_y_a(30 * J) }),
        ],
      }),
    ],
  });
  assert.deepEqual(r.backlog.gestes.map((g) => g.numero), [1, 2, 3, 4]);
  assert.deepEqual(r.backlog.gestesAnciens.map((g) => [g.numero, g.raison]), [[1, 'c\'est son compte'], [2, 'décision d\'argent'], [3, null]]);
  const texte = rendre(r);
  assert.match(texte, /Gestes de Marc ouverts depuis plus de 7 jours : \*\*3\*\*/);
  assert.match(texte, /a#1 \(.*\) : c'est son compte/);
  assert.match(texte, /a#3 \(.*\) : raison non écrite/);
});
