#!/usr/bin/env node
// Acceptation automatique d'une tâche dont la preuve est entièrement lisible par une machine (docs/cycle-de-vie-tache.md §10 ter).
//
// Décision de Marc, 21/10/2026 (fil « Fusion rapide », option B) : l'attente la plus longue n'est pas la fusion (Mergify :
// une minute après la CI verte, en médiane) mais le temps entre la fusion et le « **Acceptée** » posé par un fil
// (médiane 11 min, un tiers des tâches au-delà d'une heure).
//
// Quand une PR est fusionnée, le Réacteur (scripts/reveil-reacteur.mjs) appelle ce module AVANT de réveiller le Coordinateur.
// Il pose le commentaire « **Acceptée** » et ferme la tâche SEULEMENT si TOUT est vrai :
//   - la tâche porte la ligne `**Acceptation automatique** : oui — <pourquoi>` (celui qui écrit la tâche affirme que son « Fini quand »
//     est un contrôle CI ou un déploiement, jamais une lecture de la production : une machine ne lit que ce que GitHub sait) ;
//   - la PR est fusionnée et cite CETTE seule tâche, ouverte, de son dépôt ; aucune autre PR ouverte ne la cite ;
//   - la tâche n'attend rien (`preuve-attendue`, `qui:marc`, `bloqué`, `essai`, `preuve-manquante`) ;
//   - aucun fichier d'écran n'est touché (jsx, tsx, css, html, images, `public/`) : un écran se prouve en le regardant, par un fil ;
//   - aucun contrôle de la tête de la PR n'est rouge ;
//   - si la PR change du code servi, un déploiement de production réussi existe sur le commit fusionné (attente bornée) ;
//   - le commentaire passe `evaluer` (le garde-fou de preuve, scripts/preuve.mjs) AVANT d'être posé : jamais de réouverture ensuite.
// Sinon rien ne change : le Coordinateur est réveillé comme avant (« preuve à poser sur D#n ») et un fil prouve.
//
// Le commentaire est écrit par `github-actions[bot]` et porte un marqueur ; le garde-fou de preuve n'accepte un robot QUE dans ce cas
// (`automatique` dans preuve.mjs). Il dit exactement ce qui a été vérifié, rien de plus.
//
// Fonctions pures d'un côté (`ecran`, `evaluerEligibilite`, `corpsAcceptee`), I/O de l'autre (`accepterApresFusion`, avec `api` injecté :
// les tests n'ont besoin ni de réseau ni de jeton). Jamais une exception qui ferait rougir le job : l'appelant la rattrape.
import { evaluer, MARQUEUR_AUTO, servi, traiter as traiterPreuve, verifierDeploiement } from './preuve.mjs';
import { defautDeLaTache, extraireTachesCompletes } from './tache-liee.mjs';

export { MARQUEUR_AUTO };
// « **Acceptation automatique** : oui — raison » (même grammaire que `**Attend**` et `**Fichiers touchés**`).
export const LIGNE_AUTO = /^[\s>*_-]*\*{0,2}\s*Acceptation automatique\s*\*{0,2}\s*:\s*oui\b/im;
// Une tâche qui attend quelque chose de précis ne s'accepte pas toute seule.
export const LABELS_ATTENTE = ['preuve-attendue', 'qui:marc', 'bloqué', 'essai', 'preuve-manquante'];
// Écran : composants et styles, images, HTML, dossier public. Un contrôleur d'API (`route.ts`) n'en est pas un.
export const ECRAN = /\.(?:[jt]sx|css|scss|sass|less|html?|svg|png|jpe?g|gif|webp|ico|vue|svelte)$|(?:^|\/)public\//i;
const ROUGES = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure']);
// Attente du déploiement : le premier est lancé ~40 s après la fusion (mesuré le 21/10/2026, médiane de 197 PR). 4 essais, 45 s entre.
export const ESSAIS_DEPLOIEMENT = 4;
export const PAUSE_DEPLOIEMENT_MS = 45_000;

export const ecran = (fichiers) => fichiers.some((f) => ECRAN.test(f));

const noms = (issue) => (issue?.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
export const veutAuto = (issue) => LIGNE_AUTO.test(String(issue?.body ?? ''));

/**
 * La tâche peut-elle s'accepter seule ? Rend { ok, motifs }.
 * `autresPr` : les PR ouvertes du dépôt (autres que celle qui vient de fusionner) ; `controles` : check-runs de la tête de la PR.
 */
export function evaluerEligibilite({ issue, numeroTache, pr, fichiers, controles, autresPr = [], depot }) {
  const motifs = [];
  const defaut = defautDeLaTache(issue);
  if (defaut) motifs.push(`la tâche ${defaut}`);
  else {
    if (!veutAuto(issue)) motifs.push('la tâche ne porte pas la ligne « **Acceptation automatique** : oui — … »');
    const attente = noms(issue).filter((n) => LABELS_ATTENTE.includes(n));
    if (attente.length) motifs.push(`la tâche attend quelque chose (${attente.join(', ')})`);
  }
  if (!pr?.merged) motifs.push('la PR n’est pas fusionnée');
  if (ecran(fichiers)) motifs.push('la PR touche un écran : un fil le prouve en le regardant');
  if (fichiers.length === 0) motifs.push('aucun fichier lu sur la PR');
  const rouges = controles.filter((c) => ROUGES.has(c.conclusion));
  if (rouges.length) motifs.push(`un contrôle est rouge sur la tête de la PR (${rouges.map((c) => c.name).slice(0, 3).join(', ')})`);
  const encore = autresPr.filter((p) => extraireTachesCompletes(p.body, depot).some((t) => t.depot === depot && t.numero === numeroTache));
  if (encore.length) motifs.push(`une autre PR ouverte cite la tâche (${encore.map((p) => `#${p.number}`).join(', ')})`);
  return { ok: motifs.length === 0, motifs };
}

/**
 * Un même contrôle peut avoir plusieurs exécutions sur la même tête (relance, annulation par la concurrence d'un workflow) :
 * seule la dernière exécution terminée de chaque nom compte (21/10/2026 : un « Garde-fou » annulé, remplacé par un autre réussi,
 * suffisait à refuser l'acceptation de MoKarade/.github#402).
 */
export function derniersParNom(controles) {
  const dernier = new Map();
  controles.forEach((c, i) => {
    const vu = dernier.get(c.name);
    const rang = (x, j) => [Number(x.id ?? 0), j];
    const [id, j] = rang(c, i);
    if (!vu || id > vu.id || (id === vu.id && j > vu.j)) dernier.set(c.name, { c, id, j });
  });
  return [...dernier.values()].map((v) => v.c);
}

const court = (sha) => String(sha ?? '').slice(0, 7);

/** Le commentaire de preuve : commence par « **Acceptée** », dit ce qui a été vérifié, porte le marqueur. */
export function corpsAcceptee({ pr, controles, fichiers, deploiement, servie, sansDeploiement }) {
  const verifies = controles.filter((c) => c.conclusion === 'success').length;
  const depl = servie && deploiement?.ok ? `déploiement READY (${deploiement.detail})` : `sans déploiement : ${sansDeploiement}`;
  return [
    `**Acceptée** — PR #${pr.number} fusionnée (${court(pr.merge_commit_sha)}), ${depl}, preuve : contrôles réussis sur la tête ${court(pr.head?.sha)} de la PR (${verifies}), aucun rouge ; ` +
      `${fichiers.length} fichiers touchés, aucun écran ; acceptation automatique demandée par la ligne « Acceptation automatique » de la tâche, ` +
      'la production n’a pas été lue par une personne.',
    '',
    MARQUEUR_AUTO,
  ].join('\n');
}

const pages = async (api, chemin) => {
  const tout = [];
  for (let p = 1; p <= 5; p += 1) {
    const page = (await api('GET', `${chemin}${chemin.includes('?') ? '&' : '?'}per_page=100&page=${p}`)) ?? [];
    tout.push(...page);
    if (page.length < 100) break;
  }
  return tout;
};

/**
 * Accepte la tâche citée par la PR fusionnée `numeroPr` si tout est vrai (voir l'en-tête). Rend { statut, motifs } :
 * `acceptee` | `ignoree` (les motifs disent pourquoi ; rien n'a changé).
 * `config` : { deploiement: 'vercel' | 'aucun', workflows: [] }, comme le garde-fou de preuve.
 */
export async function accepterApresFusion({ api, depot, numeroPr, config = {}, maintenant = () => new Date(), dormir = (ms) => new Promise((r) => setTimeout(r, ms)), essais = ESSAIS_DEPLOIEMENT, pause = PAUSE_DEPLOIEMENT_MS }) {
  const ignoree = (...motifs) => ({ statut: 'ignoree', motifs });
  const pr = await api('GET', `/repos/${depot}/pulls/${numeroPr}`);
  if (!pr?.merged) return ignoree('la PR n’est pas fusionnée');
  const taches = extraireTachesCompletes(pr.body, depot);
  if (taches.length !== 1 || taches[0].depot !== depot) return ignoree('la PR ne cite pas exactement une tâche de ce dépôt');
  const numero = taches[0].numero;
  const issue = await api('GET', `/repos/${depot}/issues/${numero}`);
  // Question la moins chère d'abord : la plupart des tâches ne demandent pas l'acceptation automatique, rien d'autre n'est lu.
  if (!issue || !veutAuto(issue)) return ignoree('la tâche ne demande pas l’acceptation automatique');

  const fichiers = (await pages(api, `/repos/${depot}/pulls/${numeroPr}/files`)).map((f) => f.filename);
  const controles = derniersParNom(((await api('GET', `/repos/${depot}/commits/${pr.head?.sha}/check-runs?per_page=100`))?.check_runs ?? []).filter((c) => c.status === 'completed'));
  const ouvertes = ((await api('GET', `/repos/${depot}/pulls?state=open&per_page=30`)) ?? []).filter((p) => p.number !== numeroPr);
  const verdict = evaluerEligibilite({ issue, numeroTache: numero, pr, fichiers, controles, autresPr: ouvertes, depot });
  if (!verdict.ok) return ignoree(...verdict.motifs);

  // L'adaptateur donne au garde-fou de preuve (api(chemin, { method, body })) la même API que le Réacteur (api(méthode, chemin, corps)).
  const apiPreuve = async (chemin, { method = 'GET', body } = {}) => (await api(method, chemin, body)) ?? [];
  const servie = config.deploiement !== 'aucun' && servi(fichiers);
  let deploiement = { requis: false, ok: null, detail: '' };
  if (servie) {
    for (let i = 0; i < essais; i += 1) {
      deploiement = { requis: true, ...(await verifierDeploiement({ api: apiPreuve, depot, sha: pr.merge_commit_sha, fusionLe: pr.merged_at, workflows: config.workflows ?? [] })) };
      if (deploiement.ok) break;
      if (i < essais - 1) await dormir(pause);
    }
    if (!deploiement.ok) return ignoree(`la PR change du code servi et aucun déploiement de production réussi n’est trouvé (${deploiement.detail}) : un fil prouvera`);
  }

  const corps = corpsAcceptee({
    pr,
    controles,
    fichiers,
    deploiement,
    servie,
    sansDeploiement: config.deploiement === 'aucun' ? 'ce dépôt ne se déploie pas' : 'aucun fichier servi (docs, tests, CI, qualité)',
  });
  // Le garde-fou de preuve juge le commentaire AVANT qu'il soit posé : s'il le refusait, la tâche serait rouverte, pour rien.
  const prouve = evaluer({
    raison: 'completed',
    commentaires: [{ body: corps, user: { login: 'github-actions[bot]', type: 'Bot' }, created_at: maintenant().toISOString() }],
    pr: { merged: true, merged_at: pr.merged_at, merge_commit_sha: pr.merge_commit_sha, head_sha: pr.head?.sha },
    fichiers,
    deploiement,
  });
  if (!prouve.ok) return ignoree(...prouve.motifs);

  await api('POST', `/repos/${depot}/issues/${numero}/comments`, { body: corps });
  await api('PATCH', `/repos/${depot}/issues/${numero}`, { state: 'closed', state_reason: 'completed' });
  // La fermeture faite par le jeton du job ne relance aucun workflow : on rejoue ici le garde-fou de preuve, qui retire `en-cours` et les étiquettes d'attente.
  const r = await traiterPreuve({ api: apiPreuve, depot, numero, config });
  if (r.statut !== 'acceptee') return ignoree(`le garde-fou de preuve a refusé après coup (${r.motifs.join(' ; ')})`);
  // Le signal pour Marc, sur la PR : fusionnée, en ligne (ou rien à déployer) et tâche fermée. Un échec ici ne défait rien.
  await api('POST', `/repos/${depot}/issues/${numeroPr}/comments`, {
    body: `Fusionnée et acceptée automatiquement : tâche #${numero} fermée avec sa preuve (${deploiement.ok ? `déploiement READY, ${deploiement.detail}` : 'rien à déployer'}).`,
  }).catch((erreur) => console.warn(`Réacteur : commentaire « Fusionnée et acceptée » non posté sur la PR #${numeroPr} (la tâche est bien acceptée). ${erreur.message}`));
  return { statut: 'acceptee', motifs: [], tache: numero };
}
