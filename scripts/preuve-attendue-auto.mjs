#!/usr/bin/env node
// Preuve différée lue par une machine (docs/archive/cycle-de-vie-tache-2026-10-29.md §10 ter et §10 quater, tâche MoKarade/.github#700, mission #698).
//
// Demande de Marc, 28/10/2026 (« fais le A ») : 48 tâches sur 65 qui ont attendu plus d'un jour sa preuve étaient en `preuve-attendue`
// avec une heure prévue, et `controle-preuve.mjs` sait lire la production mais « ne pose jamais Acceptée » : un fil devait revenir.
// Ici, le Réacteur (scripts/reveil-reacteur.mjs) appelle ce module sur des événements qui passent DÉJÀ par lui (PR fusionnée, tâche fermée,
// filet quotidien) : AUCUN minuteur de plus. Une tâche ouverte en `preuve-attendue` est acceptée seule SEULEMENT si TOUT est vrai :
//   - son étiquette `niveau:tâche` est là, aucune étiquette d'attente (`qui:marc`, `bloqué`, `preuve-manquante`, `essai`) ne l'accompagne ;
//   - sa dernière ligne `**Preuve attendue** : AAAA-MM-JJ HH:MM (heure du Québec) — …` (corps, puis commentaires de son propriétaire,
//     le plus récent gagne : une tâche reprogrammée l'écrit en commentaire) donne une heure PASSÉE ; « événement, pas une heure » = rien ;
//   - elle porte au moins une ligne `**Contrôle**` lisible (corps ou commentaires de son propriétaire) et TOUTES sont de type `http` ou
//     `actions` : un contrôle `navigateur`, ou une ligne illisible, la laisse à un fil ;
//   - une PR fusionnée du dépôt la cite et aucune PR ouverte ne la cite ;
//   - chaque contrôle réussit à l'instant du passage (`executer` de controle-preuve.mjs : hubperso.com, https, aucune adresse libre) ;
//   - si la PR change du code servi, un déploiement de production réussi existe sur le commit fusionné ;
//   - le commentaire passe `evaluer` (le garde-fou de preuve, scripts/preuve.mjs) AVANT d'être posé : jamais de réouverture ensuite.
// Au moindre doute rien ne s'écrit et un fil prouve comme avant. Un contrôle en échec ne ferme rien et n'écrit rien : la tâche reste ouverte.
//
// Le commentaire est écrit par `github-actions[bot]` avec le marqueur de l'acceptation automatique (le garde-fou de preuve le reconnaît) ;
// il copie ce que les contrôles ont VRAIMENT lu. Fonctions pures d'un côté (`lireEcheance`, `evaluerCandidate`, `corpsAcceptee`),
// I/O de l'autre (`accepterPreuvesAttendues`, avec `api` et `executer` injectés : les tests n'ont besoin ni de réseau ni de jeton).
import { evaluer, MARQUEUR_AUTO, servi, traiter as traiterPreuve, verifierDeploiement } from './preuve.mjs';
import { executer as executerControle, lireControles } from './controle-preuve.mjs';
import { extraireTachesCompletes } from './tache-liee.mjs';

export const LABEL_TACHE = 'niveau:tâche';
export const LABEL_ATTENDUE = 'preuve-attendue';
// Une tâche qui attend autre chose qu'une heure ne s'accepte pas seule.
export const LABELS_ATTENTE = ['qui:marc', 'bloqué', 'preuve-manquante', 'essai'];
export const FUSEAU = 'America/Toronto';
export const PAR_PASSAGE_MAX = 5; // acceptations par passage
export const LUES_FILET = 30; // tâches lues par le filet quotidien
export const LUES_EVENEMENT = 10; // tâches lues par un événement (les plus anciennes d'abord : ce sont les plus susceptibles d'être dues)
const TYPES_PERMIS = new Set(['http', 'actions']);
// « **Preuve attendue** : 2026-10-31 12:00 (heure du Québec) — … » ; l'heure sans fuseau dit n'est pas lue (ambiguë).
const LIGNE_ECHEANCE = /^[\s>*_-]*\*{0,2}\s*Preuve attendue\s*\*{0,2}\s*:\s*(.+?)\s*$/gim;
const FORME_ECHEANCE = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2})\s*[:h]\s*(\d{2})\s*\(\s*heure\s+du\s+qu[ée]bec\s*\)/i;

const noms = (issue) => (issue?.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
const court = (sha) => String(sha ?? '').slice(0, 7);

// Décalage (ms) du Québec par rapport à l'UTC à l'instant `ms` : −4 h l'été, −5 h l'hiver.
function decalage(ms) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: FUSEAU, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, Number(x.value)]),
  );
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** Une date « AAAA-MM-JJ HH:MM » à l'heure du Québec, convertie en UTC (heure d'été et d'hiver comprises). */
export function quebecVersUtc(a, m, j, h, min) {
  const naif = Date.UTC(a, m - 1, j, h, min);
  let t = naif;
  for (let i = 0; i < 2; i += 1) t = naif - decalage(t);
  return new Date(t);
}

/**
 * L'échéance de la preuve : la DERNIÈRE ligne « Preuve attendue » parmi les textes donnés (corps d'abord, puis commentaires dans l'ordre).
 * Rend { date } (UTC), { date: null, raison } (ligne présente mais pas une heure du Québec), ou { date: null, raison: 'aucune' }.
 */
export function lireEcheance(textes) {
  let derniere = null;
  for (const texte of textes) for (const m of String(texte ?? '').matchAll(LIGNE_ECHEANCE)) derniere = m[1];
  if (derniere === null) return { date: null, raison: 'aucune ligne « Preuve attendue »' };
  const m = FORME_ECHEANCE.exec(derniere);
  if (!m) return { date: null, raison: 'la dernière ligne « Preuve attendue » n’est pas une heure du Québec' };
  const [a, mo, j, h, min] = [1, 2, 3, 4, 5].map((i) => Number(m[i]));
  if (mo < 1 || mo > 12 || j < 1 || j > 31 || h > 23 || min > 59) return { date: null, raison: 'heure illisible dans la ligne « Preuve attendue »' };
  return { date: quebecVersUtc(a, mo, j, h, min) };
}

/**
 * La tâche peut-elle être contrôlée maintenant ? `textes` : le corps puis les commentaires de son propriétaire.
 * Rend { ok, motifs, controles } ; `controles` : les lignes lues, toutes http ou actions quand `ok`.
 */
export function evaluerCandidate({ issue, textes, maintenant = new Date() }) {
  const motifs = [];
  const etiquettes = noms(issue);
  if (!issue || issue.state !== 'open') motifs.push('la tâche est fermée ou introuvable');
  if (!etiquettes.includes(LABEL_TACHE)) motifs.push(`pas de ${LABEL_TACHE}`);
  if (!etiquettes.includes(LABEL_ATTENDUE)) motifs.push(`pas de ${LABEL_ATTENDUE}`);
  const attente = etiquettes.filter((n) => LABELS_ATTENTE.includes(n));
  if (attente.length) motifs.push(`la tâche attend quelque chose (${attente.join(', ')})`);
  const echeance = lireEcheance(textes);
  if (!echeance.date) motifs.push(echeance.raison);
  else if (echeance.date.getTime() > maintenant.getTime()) motifs.push(`l’échéance (${echeance.date.toISOString()}) n’est pas passée`);
  const controles = textes.flatMap(lireControles);
  if (controles.length === 0) motifs.push('aucune ligne **Contrôle**');
  const mauvais = controles.find((c) => c.erreur);
  if (mauvais) motifs.push(`ligne **Contrôle** illisible (${mauvais.erreur})`);
  const interdit = controles.find((c) => !c.erreur && !TYPES_PERMIS.has(c.type));
  if (interdit) motifs.push(`un contrôle de type « ${interdit.type} » se prouve par un fil`);
  return { ok: motifs.length === 0, motifs, controles, echeance: echeance.date };
}

/** Le commentaire de preuve : commence par « **Acceptée** », copie ce que les contrôles ont lu, porte le marqueur. */
export function corpsAcceptee({ pr, deploiement, servie, sansDeploiement, resultats, echeance, maintenant }) {
  const depl = servie && deploiement?.ok ? `déploiement READY (${deploiement.detail})` : `sans déploiement : ${sansDeploiement}`;
  const lu = resultats.map((r) => r.observe).join(' ; ');
  return [
    `**Acceptée** — PR #${pr.number} fusionnée (${court(pr.merge_commit_sha)}), ${depl}, preuve : contrôle automatique à la date prévue (${echeance.toISOString()}), ` +
      `lu le ${maintenant.toISOString()} : ${lu}. Acceptation automatique : la tâche portait la ligne « Preuve attendue » et ses lignes « Contrôle » (http ou actions), la production n’a pas été lue par une personne.`,
    '',
    MARQUEUR_AUTO,
  ].join('\n');
}

const pages = async (api, chemin) => {
  const tout = [];
  for (let p = 1; p <= 3; p += 1) {
    const page = (await api('GET', `${chemin}${chemin.includes('?') ? '&' : '?'}per_page=100&page=${p}`)) ?? [];
    tout.push(...page);
    if (page.length < 100) break;
  }
  return tout;
};

/** La PR fusionnée du dépôt qui cite la tâche (la plus récemment fusionnée), lue par la chronologie de l'issue. null si aucune. */
async function prFusionneeDe({ api, depot, numero }) {
  const evenements = await pages(api, `/repos/${depot}/issues/${numero}/timeline`);
  const candidates = new Set(
    evenements
      .filter((e) => e.event === 'cross-referenced' && e.source?.issue?.pull_request && e.source.issue.repository?.full_name === depot)
      .map((e) => e.source.issue.number),
  );
  const fusionnees = [];
  for (const n of [...candidates].slice(0, 6)) {
    const pr = await api('GET', `/repos/${depot}/pulls/${n}`);
    if (pr?.merged && extraireTachesCompletes(pr.body, depot).some((t) => t.depot === depot && t.numero === numero)) fusionnees.push(pr);
  }
  return fusionnees.sort((a, b) => (a.merged_at < b.merged_at ? 1 : -1))[0] ?? null;
}

/**
 * Accepte les tâches du dépôt dont la preuve différée est due et se lit par une machine. Rend { acceptees: [numéros], ignorees: [{ tache, motifs }] }.
 * `config` : { deploiement: 'vercel' | 'aucun', workflows: [] } comme le garde-fou de preuve ; `lues` : combien de tâches lire au plus ;
 * `jeton` : pour les contrôles de type `actions` (API GitHub). Jamais d'exception pour une tâche : elle est ignorée avec ses motifs.
 */
export async function accepterPreuvesAttendues({ api, depot, maintenant = new Date(), config = {}, executer = executerControle, jeton = '', lues = LUES_EVENEMENT, max = PAR_PASSAGE_MAX }) {
  const sortie = { acceptees: [], ignorees: [] };
  const liste = ((await api('GET', `/repos/${depot}/issues?labels=${LABEL_ATTENDUE}&state=open&sort=updated&direction=asc&per_page=30`)) ?? []).filter((i) => !i.pull_request);
  for (const issue of liste.slice(0, lues)) {
    if (sortie.acceptees.length >= max) break;
    const numero = issue.number;
    const ignorer = (...motifs) => sortie.ignorees.push({ tache: numero, motifs });
    try {
      // Question la moins chère d'abord : une tâche sans commentaire ni ligne « Contrôle » dans son corps n'a rien à lire.
      if (!/Contr[ôo]le\s*\*{0,2}\s*:/i.test(String(issue.body ?? '')) && !(issue.comments > 0)) { ignorer('aucune ligne **Contrôle**'); continue; }
      const commentaires = issue.comments > 0 ? await pages(api, `/repos/${depot}/issues/${numero}/comments`) : [];
      const duProprietaire = commentaires.filter((c) => c.author_association === 'OWNER');
      const textes = [issue.body, ...duProprietaire.map((c) => c.body)];
      const verdict = evaluerCandidate({ issue, textes, maintenant });
      if (!verdict.ok) { ignorer(...verdict.motifs); continue; }
      if (commentaires.some((c) => c.user?.login === 'github-actions[bot]' && String(c.body ?? '').includes(MARQUEUR_AUTO))) { ignorer('une acceptation automatique est déjà posée'); continue; }

      const pr = await prFusionneeDe({ api, depot, numero });
      if (!pr) { ignorer('aucune PR fusionnée du dépôt ne cite la tâche'); continue; }
      const ouvertes = ((await api('GET', `/repos/${depot}/pulls?state=open&per_page=30`)) ?? []).filter((p) => p.number !== pr.number);
      const encore = ouvertes.filter((p) => extraireTachesCompletes(p.body, depot).some((t) => t.depot === depot && t.numero === numero));
      if (encore.length) { ignorer(`une PR ouverte cite la tâche (${encore.map((p) => `#${p.number}`).join(', ')})`); continue; }

      const resultats = [];
      for (const c of verdict.controles) resultats.push({ ligne: c.ligne, ...(await executer(c, { jeton })) });
      const rouges = resultats.filter((r) => !r.ok);
      if (rouges.length) { ignorer(`un contrôle n’a pas lu ce qui était attendu (${rouges.map((r) => r.observe).join(' ; ')}) : un fil prouvera`); continue; }

      const fichiers = (await pages(api, `/repos/${depot}/pulls/${pr.number}/files`)).map((f) => f.filename);
      const servie = config.deploiement !== 'aucun' && servi(fichiers);
      const apiPreuve = async (chemin, { method = 'GET', body } = {}) => (await api(method, chemin, body)) ?? [];
      let deploiement = { requis: false, ok: null, detail: '' };
      if (servie) {
        deploiement = { requis: true, ...(await verifierDeploiement({ api: apiPreuve, depot, sha: pr.merge_commit_sha, fusionLe: pr.merged_at, workflows: config.workflows ?? [] })) };
        if (!deploiement.ok) { ignorer(`la PR change du code servi et aucun déploiement de production réussi n’est trouvé (${deploiement.detail})`); continue; }
      }

      const corps = corpsAcceptee({
        pr,
        deploiement,
        servie,
        sansDeploiement: config.deploiement === 'aucun' ? 'ce dépôt ne se déploie pas' : 'aucun fichier servi (docs, tests, CI, qualité)',
        resultats,
        echeance: verdict.echeance,
        maintenant,
      });
      // Le garde-fou de preuve juge le commentaire AVANT qu'il soit posé : s'il le refusait, la tâche serait rouverte, pour rien.
      const prouve = evaluer({
        raison: 'completed',
        commentaires: [{ body: corps, user: { login: 'github-actions[bot]', type: 'Bot' }, created_at: maintenant.toISOString() }],
        pr: { merged: true, merged_at: pr.merged_at, merge_commit_sha: pr.merge_commit_sha, head_sha: pr.head?.sha },
        fichiers,
        deploiement,
      });
      if (!prouve.ok) { ignorer(...prouve.motifs); continue; }

      await api('POST', `/repos/${depot}/issues/${numero}/comments`, { body: corps });
      await api('PATCH', `/repos/${depot}/issues/${numero}`, { state: 'closed', state_reason: 'completed' });
      // La fermeture faite par le jeton du job ne relance aucun workflow : on rejoue ici le garde-fou de preuve, qui retire `preuve-attendue` et `en-cours`.
      const r = await traiterPreuve({ api: apiPreuve, depot, numero, config });
      if (r.statut !== 'acceptee') { ignorer(`le garde-fou de preuve a refusé après coup (${r.motifs.join(' ; ')})`); continue; }
      sortie.acceptees.push(numero);
    } catch (e) {
      ignorer(`erreur : ${e.message}`);
    }
  }
  return sortie;
}
