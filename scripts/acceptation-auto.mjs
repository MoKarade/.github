#!/usr/bin/env node
// Acceptation automatique d'une tâche dont la preuve est entièrement lisible par une machine (docs/cycle-de-vie-tache.md §10 ter).
//
// Décision de Marc, 21/10/2026 (fil « Fusion rapide », option B) : l'attente la plus longue n'est pas la fusion (Mergify :
// une minute après la CI verte, en médiane) mais le temps entre la fusion et le « **Acceptée** » posé par un fil
// (médiane 11 min, un tiers des tâches au-delà d'une heure).
//
// Quand une PR est fusionnée, le Réacteur (scripts/reveil-reacteur.mjs) appelle ce module AVANT de décider la suite (routine « Prendre une tâche » pour la suivante).
// Il pose le commentaire « **Acceptée** » et ferme la tâche SEULEMENT si TOUT est vrai :
//   - la tâche porte la ligne `**Acceptation automatique** : oui — <pourquoi>` (celui qui écrit la tâche affirme que son « Fini quand »
//     est un contrôle CI ou un déploiement, jamais une lecture de la production : une machine ne lit que ce que GitHub sait) ;
//     OU la tâche ne porte AUCUNE ligne « Acceptation automatique » (ni oui ni non) ni sonde, et la règle prudente du filet
//     (`evaluerMarquage`, acceptation-marquage.mjs) la juge éligible À LA FUSION : la ligne n'a plus besoin d'être posée avant,
//     ce qui perdait la course contre les fils (61 % des tâches sont prises en moins de 10 min, relevé du 28/10/2026). Une ligne « non » se respecte ;
//   - la PR est fusionnée et cite CETTE seule tâche, ouverte, de son dépôt ; aucune autre PR ouverte ne la cite ;
//   - la tâche n'attend rien (`preuve-attendue`, `qui:marc`, `bloqué`, `essai`, `preuve-manquante`) ;
//   - aucun fichier d'écran n'est touché (jsx, tsx, css, html, images, `public/`) : un écran se prouve en le regardant, par un fil ;
//   - aucun contrôle de la tête de la PR n'est rouge ;
//   - si la PR change du code servi, un déploiement de production réussi existe sur le commit fusionné (attente bornée) ;
//   - le commentaire passe `evaluer` (le garde-fou de preuve, scripts/preuve.mjs) AVANT d'être posé : jamais de réouverture ensuite.
// Depuis la refonte (décision 1 du 26/10/2026, « ok pour recos ») la tâche peut aussi porter la ligne
// `**Fini quand exécutable** : GET https://<nom>.hubperso.com/chemin → 200, contient « texte »` : après le déploiement, la sonde ci-dessous
// lit CETTE URL et le commentaire copie ce qui a été lu. Hôte `*.hubperso.com` seulement, https, sans port ni identifiant, aucune
// redirection suivie : le texte d'une tâche est une donnée, jamais une adresse libre pour le robot (qui peut être le PC de Marc).
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

// « **Fini quand exécutable** : GET https://nom.hubperso.com/chemin → 200, contient « texte » » (même grammaire que `**Attend**`).
export const LIGNE_SONDE = /^[\s>*_-]*\*{0,2}\s*Fini quand exécutable\s*\*{0,2}\s*:\s*(.+?)\s*$/im;
const FORME_SONDE = /^GET\s+(https:\/\/\S+)\s*(?:→|->)\s*(\d{3})(?:\s*,\s*contient\s*[«"“]\s*(.+?)\s*[»"”])?$/;
const HOTE_SONDE = /^(?:[a-z0-9-]+\.)*hubperso\.com$/;
export const ESSAIS_SONDE = 3;
export const PAUSE_SONDE_MS = 20_000;
export const DELAI_SONDE_MS = 10_000;
export const OCTETS_SONDE = 65_536;

/**
 * Lit la ligne « Fini quand exécutable » d'une tâche. Rend { sonde: null } (pas de ligne), { sonde: { url, statut, contient } }
 * ou { erreur } (ligne présente mais refusée : la tâche ne s'accepte pas seule, un fil prouvera).
 */
export function lireSonde(issue) {
  const ligne = LIGNE_SONDE.exec(String(issue?.body ?? ''));
  if (!ligne) return { sonde: null };
  const m = FORME_SONDE.exec(ligne[1]);
  if (!m) return { erreur: 'la ligne « Fini quand exécutable » doit être « GET https://… → 200, contient « texte » »' };
  let url;
  try {
    url = new URL(m[1]);
  } catch {
    return { erreur: 'l’adresse de la ligne « Fini quand exécutable » n’est pas valide' };
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !HOTE_SONDE.test(url.hostname) || m[1].length > 300) {
    return { erreur: 'la sonde ne lit que du https sur hubperso.com ou un de ses sous-domaines, sans port ni identifiant (300 caractères au plus)' };
  }
  const statut = Number(m[2]);
  if (statut < 200 || statut > 599) return { erreur: 'le statut attendu de la sonde est hors de 200 à 599' };
  return { sonde: { url: url.href, statut, contient: m[3] || '' } };
}

async function lireCorps(reponse, max = OCTETS_SONDE) {
  if (!reponse.body?.getReader) return String(await reponse.text()).slice(0, max);
  const lecteur = reponse.body.getReader();
  const decodeur = new TextDecoder();
  let texte = '';
  let octets = 0;
  while (octets < max) {
    const { done, value } = await lecteur.read();
    if (done) break;
    octets += value.length;
    texte += decodeur.decode(value, { stream: true });
  }
  await lecteur.cancel().catch(() => {});
  return texte.slice(0, max);
}

/**
 * Lit la production : `essais` tentatives espacées de `pause` (le temps que le réseau de diffusion serve la nouvelle version).
 * Rend { ok, detail } ; `detail` dit ce qui a été lu, il est copié dans le commentaire de preuve. Jamais d'exception.
 */
export async function lireProduction({ sonde, fetchImpl = fetch, essais = ESSAIS_SONDE, pause = PAUSE_SONDE_MS, dormir = (ms) => new Promise((r) => setTimeout(r, ms)), maintenant = () => new Date() }) {
  let dernier = 'aucune tentative';
  for (let i = 0; i < essais; i += 1) {
    try {
      const reponse = await fetchImpl(sonde.url, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'user-agent': 'MoKarade-preuve/1', 'cache-control': 'no-cache' },
        signal: AbortSignal.timeout(DELAI_SONDE_MS),
      });
      const corps = sonde.contient ? await lireCorps(reponse) : '';
      const lu = `GET ${sonde.url} → ${reponse.status}`;
      if (reponse.status !== sonde.statut) dernier = `${lu}, attendu ${sonde.statut}`;
      else if (sonde.contient && !corps.includes(sonde.contient)) dernier = `${lu}, mais le texte « ${sonde.contient} » est absent des ${OCTETS_SONDE / 1024} premiers Ko`;
      else return { ok: true, detail: `${lu}${sonde.contient ? `, contient « ${sonde.contient} » : oui` : ''}, lu le ${maintenant().toISOString()}` };
    } catch (erreur) {
      dernier = `GET ${sonde.url} : ${erreur.name === 'TimeoutError' ? `pas de réponse en ${DELAI_SONDE_MS / 1000} s` : erreur.message}`;
    }
    if (i < essais - 1) await dormir(pause);
  }
  return { ok: false, detail: dernier };
}

/**
 * La tâche peut-elle s'accepter seule ? Rend { ok, motifs }.
 * `autresPr` : les PR ouvertes du dépôt (autres que celle qui vient de fusionner) ; `controles` : check-runs de la tête de la PR.
 */
export function evaluerEligibilite({ issue, numeroTache, pr, fichiers, controles, autresPr = [], depot, implicite = false, pageLue = null }) {
  const motifs = [];
  const defaut = defautDeLaTache(issue);
  if (defaut) motifs.push(`la tâche ${defaut}`);
  else {
    const { sonde, erreur } = lireSonde(issue);
    if (erreur) motifs.push(erreur);
    else if (!veutAuto(issue) && !sonde && !implicite && !pageLue) motifs.push('la tâche ne porte pas la ligne « **Acceptation automatique** : oui — … » ni « **Fini quand exécutable** : GET … »');
    const attente = noms(issue).filter((n) => LABELS_ATTENTE.includes(n));
    if (attente.length) motifs.push(`la tâche attend quelque chose (${attente.join(', ')})`);
  }
  if (!pr?.merged) motifs.push('la PR n’est pas fusionnée');
  // Classe B (scripts/fini-quand.mjs, preuve-page.yml) : l'écran a été LU par un navigateur sans tête, sur l'app lancée avec les données fictives des tests.
  if (ecran(fichiers) && !pageLue?.ok) motifs.push('la PR touche un écran : un fil le prouve en le regardant');
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
export function corpsAcceptee({ pr, controles, fichiers, deploiement, servie, sansDeploiement, sonde = null, implicite = false, pageLue = null }) {
  const verifies = controles.filter((c) => c.conclusion === 'success').length;
  const depl = servie && deploiement?.ok ? `déploiement READY (${deploiement.detail})` : `sans déploiement : ${sansDeploiement}`;
  return [
    `**Acceptée** — PR #${pr.number} fusionnée (${court(pr.merge_commit_sha)}), ${depl}, preuve : contrôles réussis sur la tête ${court(pr.head?.sha)} de la PR (${verifies}), aucun rouge ; ` +
      (pageLue?.ok ? `${fichiers.length} fichiers touchés, écran lu par un navigateur sans tête sur le commit fusionné, en mode fictif (données des tests, jamais la production) : ${pageLue.detail} ; ` : `${fichiers.length} fichiers touchés, aucun écran ; `) +
      (pageLue?.ok
        ? 'acceptation automatique de classe B, demandée par la ligne « Fini quand » (classe B) et ses lignes « Lecture de page » dans la tâche, la production n’a pas été lue par une personne.'
        : sonde
          ? `acceptation automatique demandée par la ligne « Fini quand exécutable » de la tâche, production lue par la sonde : ${sonde.detail}.`
          : implicite
            ? 'acceptation automatique par la règle prudente appliquée à la fusion (le « Fini quand » de la tâche se lit par un test ou la CI, aucune ligne « Acceptation automatique » n’y figurait), la production n’a pas été lue par une personne.'
            : 'acceptation automatique demandée par la ligne « Acceptation automatique » de la tâche, la production n’a pas été lue par une personne.'),
    '',
    MARQUEUR_AUTO,
  ].join('\n');
}

/**
 * La règle prudente du filet s'applique-t-elle À LA FUSION à cette tâche ? Seulement si personne n'a décidé : aucune ligne
 * « Acceptation automatique » (oui OU non), aucune sonde, pas Jules (il a sa propre acceptation). Import dynamique : acceptation-marquage.mjs
 * importe ce module (ECRAN, LABELS_ATTENTE), un import statique ferait un cycle.
 */
export async function regleImplicite(issue) {
  if (noms(issue).includes('jules')) return false;
  const { aUneLigne, evaluerMarquage } = await import('./acceptation-marquage.mjs');
  if (aUneLigne(issue?.body)) return false;
  return evaluerMarquage({ titre: issue?.title ?? '', corps: issue?.body ?? '' }).ok;
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
export async function accepterApresFusion({ api, depot, numeroPr, config = {}, maintenant = () => new Date(), dormir = (ms) => new Promise((r) => setTimeout(r, ms)), essais = ESSAIS_DEPLOIEMENT, pause = PAUSE_DEPLOIEMENT_MS, sonde: reglagesSonde = {}, pageLue = null }) {
  const ignoree = (...motifs) => ({ statut: 'ignoree', motifs });
  const pr = await api('GET', `/repos/${depot}/pulls/${numeroPr}`);
  if (!pr?.merged) return ignoree('la PR n’est pas fusionnée');
  const taches = extraireTachesCompletes(pr.body, depot);
  if (taches.length !== 1 || taches[0].depot !== depot) return ignoree('la PR ne cite pas exactement une tâche de ce dépôt');
  const numero = taches[0].numero;
  const issue = await api('GET', `/repos/${depot}/issues/${numero}`);
  // Question la moins chère d'abord : la plupart des tâches ne demandent pas l'acceptation automatique, rien d'autre n'est lu.
  if (!issue) return ignoree('la tâche ne demande pas l’acceptation automatique');
  const decidee = veutAuto(issue) || LIGNE_SONDE.test(String(issue.body ?? '')) || Boolean(pageLue?.ok);
  const implicite = !decidee && (await regleImplicite(issue));
  if (!decidee && !implicite) return ignoree('la tâche ne demande pas l’acceptation automatique');

  const fichiers = (await pages(api, `/repos/${depot}/pulls/${numeroPr}/files`)).map((f) => f.filename);
  const controles = derniersParNom(((await api('GET', `/repos/${depot}/commits/${pr.head?.sha}/check-runs?per_page=100`))?.check_runs ?? []).filter((c) => c.status === 'completed'));
  const ouvertes = ((await api('GET', `/repos/${depot}/pulls?state=open&per_page=30`)) ?? []).filter((p) => p.number !== numeroPr);
  const verdict = evaluerEligibilite({ issue, numeroTache: numero, pr, fichiers, controles, autresPr: ouvertes, depot, implicite, pageLue });
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

  // « Fini quand exécutable » : la production est lue APRÈS le déploiement prêt ; une réponse différente ne ferme rien, un fil prouve.
  let lue = null;
  const { sonde } = lireSonde(issue);
  if (sonde) {
    lue = await lireProduction({ sonde, maintenant, dormir, ...reglagesSonde });
    if (!lue.ok) return ignoree(`la sonde de la tâche n’a pas lu ce qui était attendu (${lue.detail}) : un fil prouvera`);
  }

  const corps = corpsAcceptee({
    sonde: lue,
    implicite,
    pageLue,
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
