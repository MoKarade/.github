#!/usr/bin/env node
// Jules prend seul les tâches faisables (demande de Marc du 19/10/2026 : « full auto, mécaniquement, pour qu'il avance autant que possible
// malgré le quota bas de Claude »). Jules ne consomme pas le quota Claude : le Réacteur (`reveil-reacteur.mjs`, à l'événement, depuis la tâche #704) lui confie la
// première tâche RÉSERVÉE (étiquette `faisable-jules`, posée par qui écrit ou range la tâche : le filet ne devine pas) d'un dépôt LIBRE
// dont le CORPS est une consigne complète au gabarit `docs/jules-gabarit-issue.md`. Aucune IA, aucun jugement : une tâche est confiable
// ou elle ne l'est pas, et la raison s'écrit. Règles : plan du fil Jules, `commun/plans/2026-10-19_jules-automatique.md`.
//
// Jules part même dans un dépôt déjà occupé par un fil (décision de Marc, 23/10/2026 : « il prend quand même » ; ses tâches ne tiennent plus de
// place, `places-depot.mjs`). Il évite seulement : un incident, un dépôt gelé (`DEPOTS_GELES`), et les fichiers déjà touchés par une PR ouverte
// ou déclarés par une autre tâche en cours (« Fichiers permis » de la tâche contre les fichiers RÉELS de chaque PR ouverte, lus EN DIRECT au moment
// de confier ; une PR dont les fichiers sont illisibles ou tronqués ne laisse rien passer : dans le doute, il attend). Plafond : trois tâches Jules
// en même temps sur les dix dépôts (le quota de Jules est de 15 simultanées).
// Confier = poser l'étiquette `jules` (le signal que Jules lit) + un commentaire d'une ligne. Le « ménage » du cycle de vie (§7) retire
// l'étiquette après 24 h sans PR ; une tâche déjà confiée deux fois ne l'est plus (elle reste réservée : le silence de 24 h réveille alors le
// Coordinateur, qui corrige le corps).
//
// Fonctions pures (`evaluerJules`, `choisirPourJules`), I/O injecté (`lireIssue`, `gh`) : les tests n'ont besoin ni de réseau ni de fichier.

import { fichiersDeclares, fichiersDuTravail, raisonIncompatible } from './capacite.mjs';
import { extraireTaches } from './tache-liee.mjs';

const ORG = 'MoKarade';

export const SECTIONS_REQUISES = ['Avant', 'Après', 'Fini quand', 'Fichiers permis', 'À faire', 'À ne pas faire', 'Vérifier', 'À citer dans la PR'];
export const FICHIERS_MAX = 5;
/**
 * Les deux fichiers de suivi que « La doc suit le code » fait mettre à jour dans la MÊME PR (tâche MoKarade/.github#850, Hubperso#753). Racine du dépôt seulement.
 * Permis à Jules, hors du plafond de FICHIERS_MAX, et jamais cause de `hold` ; `capacite.mjs` les ignore déjà pour les places.
 */
export const DOCS_DE_SUITE = ['HANDOVER.md', 'CHANGELOG.md'];
export const estDocDeSuite = (chemin) => DOCS_DE_SUITE.includes(String(chemin));
export const CANDIDATES_MAX = 8;
export const FOIS_MAX = 2;
export const SIMULTANEES_MAX = 3;
const BOITE = { depot: 'app-template', pr: 58 };
// Début du commentaire posé en confiant (le filet du PC l'écrivait déjà ainsi) : sert à compter les confiages d'une tâche, SANS fichier d'état.
export const MARQUE_CONFIEE = 'Confiée à Jules automatiquement';
// Dépôts où Jules ne prend rien tant qu'on ne les dégèle pas (Marc, 23/10/2026 : MemoryAI est gelé). Retirer le dépôt de la liste = le dégeler.
export const DEPOTS_GELES = new Set(['memoryai']);

// Ce que Jules ne touche jamais (AGENTS.md, gabarit « Tâches à garder pour Claude »). Marc a levé cinq exclusions le 19/10/2026 (taille,
// petits écrans, workflows de `.github/`, longs .md, dépendances mineures) : elles passent par les conditions de `evaluerJules`, qui
// exigent la preuve dans le corps. Restent exclus : secrets, jetons, Sentry, authentification, base de données, migrations.
export const CHEMINS_INTERDITS = [
  [/^\.github\/(?!workflows\/[\w.-]+\.ya?ml$)/, 'chemin protégé .github/ (seuls les workflows listés sont permis)'],
  [/^\.github\/workflows\/.*(garde-?fou|relecture|codeowners|mergify|reacteur|reveil)/i, 'workflow protégé (garde-fou, relecture, Mergify, Réacteur)'],
  [/^scripts\//, 'chemin protégé scripts/'],
  [/^surveillance\//, 'chemin protégé surveillance/'],
  [/^qualite\//, 'chemin protégé qualite/'],
  [/^\.claude\//, 'chemin protégé .claude/'],
  [/(^|\/)\.mergify\.yml$/, 'chemin protégé .mergify.yml'],
  [/(^|\/)(CODEOWNERS|vercel\.json)$/, 'chemin protégé'],
  [/(^|\/)\.env/, 'secret (.env)'],
  [/(^|\/)(drizzle|migrations?)\//i, 'base de données'],
  [/schema\.(ts|sql)$|\.sql$/i, 'base de données'],
  [/(^|\/)(auth|middleware|proxy)[\w.-]*\.(ts|tsx|js|mjs)$/i, 'authentification'],
  [/secret|token|credential|sentry/i, 'secret, jeton ou Sentry'],
  [/(^|\/)(BACKLOG|CLAUDE|AGENTS)\.md$/, 'fichier d\'instructions à ne pas réécrire'],
];
const DEPOTS_INTERDITS = { 'hub-contract': 'le contrat', };
/**
 * Tâches que Marc garde hors de Jules, nommées une à une. 21/10/2026 : à la carte « Laisser Jules prendre aussi les tâches prio:3 ? », Marc a
 * répondu « Oui sauf #247 » (Hubperso#247 : ADR de la tuile Wear OS, à faire après le backlog). La liste est un `Set` de « dépôt#n » en minuscules.
 */
export const EXCLUES_PAR_DECISION = new Set(['hubperso#247']);
export const exclueParDecision = (repo, n) => EXCLUES_PAR_DECISION.has(`${String(repo ?? '').toLowerCase()}#${n}`);
const ETIQUETTES_INTERDITES = ['sécurité', 'securite', 'incident', 'preuve-manquante', 'migration', 'secret'];
// Les apps sont privées (connexion centralisée dans le hub) : sans porte « mode captures », que Marc a refusée le 19/10/2026 (« b »), le workflow
// commun `captures.yml` ne peut pas photographier leurs pages, et le filet n'accepte seul une PR d'écran qu'avec ces captures. FinanceAI, 100 %
// navigateur avec un mode test, est la seule app dont les écrans se photographient.
export const DEPOTS_ECRAN_PERMIS = ['financeai'];
const ETIQUETTES_ECRAN = ['écran', 'ecran', 'ui', 'design'];
export const FICHIER_ECRAN = /\.(css|tsx|jsx)$|(^|\/)components\//i;
const FICHIER_DEPENDANCES = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/;
const FICHIER_MD = /\.md$/i;
const ETIQUETTES_QUI_OCCUPENT = ['en-cours', 'jules'];
const ETIQUETTES_QUI_ECARTENT = ['en-cours', 'jules', 'qui:marc', 'bloqué', 'preuve-attendue'];

/** Le texte d'une section `**Titre**` (parenthèse et deux-points tolérés) jusqu'à la section suivante, ou null si elle manque. */
export function section(corps, titre) {
  const motif = new RegExp(`\\*\\*${titre.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\*\\*[ \\t]*(?:\\([^)]*\\))?[ \\t]*:?[ \\t]*([\\s\\S]*?)(?=\\n\\s*\\*\\*[^*\\n]+\\*\\*|$)`, 'i');
  const m = motif.exec(String(corps ?? ''));
  return m ? m[1].trim() : null;
}

/** Les chemins listés dans « Fichiers permis » : une puce `- \`chemin\`` par ligne. */
export function fichiersPermis(corps) {
  const texte = section(corps, 'Fichiers permis') ?? '';
  return [...texte.matchAll(/^\s*[-*]\s*`([^`\n]+)`/gm)].map((m) => m[1].trim());
}

/**
 * Cette tâche est-elle confiable à Jules ? Rend { ok, raisons } : `raisons` dit tout ce qui manque, dans l'ordre.
 * @param issue { repo, n, labels, body }
 */
export function evaluerJules({ repo, n, labels = [], body = '' }) {
  const raisons = [];
  const depot = String(repo ?? '').toLowerCase();
  if (DEPOTS_INTERDITS[depot]) raisons.push(`dépôt réservé à Claude (${DEPOTS_INTERDITS[depot]})`);
  if (exclueParDecision(repo, n)) raisons.push('tâche gardée hors de Jules par décision de Marc (21/10/2026)');
  if (!labels.includes('faisable-jules')) raisons.push('étiquette « faisable-jules » absente');
  for (const l of labels) if (ETIQUETTES_INTERDITES.includes(String(l).toLowerCase())) raisons.push(`étiquette « ${l} » : tâche à garder pour Claude`);
  for (const l of ETIQUETTES_QUI_ECARTENT) if (labels.includes(l)) raisons.push(`étiquette « ${l} »`);

  const absentes = [];
  const vides = [];
  for (const titre of SECTIONS_REQUISES) {
    const texte = section(body, titre);
    if (texte === null) absentes.push(titre);
    else if (texte.length < 3) vides.push(titre);
  }
  if (absentes.length) raisons.push(`sections absentes : ${absentes.join(', ')}`);
  if (vides.length) raisons.push(`sections vides : ${vides.join(', ')}`);
  // Un gabarit recopié sans être rempli garde ses <crochets> : Jules les prendrait pour la consigne.
  if (/<[a-zA-ZÀ-ÿ][^>\n]*\s[^>\n]*>/.test(String(body))) raisons.push('crochets <…> du gabarit non remplis');

  const fichiers = fichiersPermis(body);
  if (section(body, 'Fichiers permis') !== null) {
    if (fichiers.length === 0) raisons.push('aucun fichier permis lisible (puces `chemin`)');
    const comptes = fichiers.filter((f) => !estDocDeSuite(f));
    if (comptes.length > FICHIERS_MAX) raisons.push(`plus de ${FICHIERS_MAX} fichiers permis (${comptes.length})`);
    for (const f of fichiers) for (const [motif, pourquoi] of CHEMINS_INTERDITS) if (motif.test(f)) { raisons.push(`${f} : ${pourquoi}`); break; }
    if (depot === 'driveai' && fichiers.some((f) => /^src\//.test(f))) raisons.push('moteur DriveAI (src/) réservé à Claude');

    // Exclusions levées par Marc le 19/10/2026 : permises seulement si le corps porte la preuve demandée.
    const consignes = ['À faire', 'À ne pas faire', 'Vérifier', 'Fini quand'].map((t) => section(body, t) ?? '').join('\n');
    const toucheEcran = fichiers.some((f) => FICHIER_ECRAN.test(f)) || labels.some((l) => ETIQUETTES_ECRAN.includes(String(l).toLowerCase()));
    if (toucheEcran && !DEPOTS_ECRAN_PERMIS.includes(depot)) raisons.push('écran sans captures possibles : app privée, aucune porte « mode captures » (décision de Marc du 19/10/2026)');
    if (toucheEcran && !(/capture/i.test(consignes) && /theme\.test/i.test(consignes))) {
      raisons.push('écran : le corps doit demander des captures avant/après ET le test tests/theme.test.ts');
    }
    if (fichiers.some((f) => FICHIER_DEPENDANCES.test(f)) && !(/npm audit/i.test(consignes) && /mineure|patch/i.test(consignes))) {
      raisons.push('dépendances : seulement des montées mineures/patch, avec « npm audit » à 0 dans Vérifier');
    }
    if (fichiers.some((f) => FICHIER_MD.test(f) && !estDocDeSuite(f)) && !(/fran[cç]ais/i.test(consignes) && /accent/i.test(consignes))) {
      raisons.push('.md : le corps doit demander explicitement le français et les accents (et un test des mots)');
    }
  } else {
    for (const l of labels) if (ETIQUETTES_ECRAN.includes(String(l).toLowerCase())) raisons.push(`étiquette « ${l} » : tâche à garder pour Claude`);
  }

  // Un seul objectif : un « OU » en majuscules dans la consigne, et Jules fait les deux (constat Hubperso#146).
  const consigne = ['Après', 'À faire'].map((t) => section(body, t) ?? '').join('\n');
  if (/(^|\s)OU(\s|$)/.test(consigne)) raisons.push('« OU » dans la consigne : un seul objectif');

  const citer = section(body, 'À citer dans la PR') ?? '';
  if (citer) {
    const propre = new RegExp(`Tâche\\s*:\\s*(?:${ORG}/${String(repo).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})?#${n}\\b`, 'i');
    if (!propre.test(citer)) raisons.push(`« Tâche : #${n} » absent de la ligne à citer dans la PR`);
    if (/\b(fixes|closes|resolves)\b/i.test(citer)) raisons.push('Fixes/Closes/Resolves dans la ligne à citer');
  }
  return { ok: raisons.length === 0, raisons };
}

/**
 * Pour chaque dépôt libre, la première tâche réservée dont le corps est une consigne complète.
 * @param prochaines contenu de prochaines.json (`depots[].reservees_jules`, `occupe_par`, `incidents`)
 * @param lireIssue (depot, n) -> { state, labels, body } (EN DIRECT)
 * @param etat { confies: { ref: { fois } } } : une tâche déjà confiée `FOIS_MAX` fois n'est plus proposée
 * @returns {{ choix: {repo, ref, n, titre}[], pasPretes: {ref, raisons}[], depotsConcernes: number, enCours: number }}
 */
export function choisirPourJules(prochaines, lireIssue, etat = {}) {
  const depots = prochaines.depots ?? [];
  // Jules ne tient plus de place dans `occupe_par` (23/10/2026) : ses tâches se lisent dans `jules_en_cours` (et, d'un ancien relevé, dans `occupe_par`).
  const julesDe = (d) => [...(d.jules_en_cours ?? []), ...(d.occupe_par ?? []).filter((o) => o.motif === 'jules')];
  const enCours = depots.filter((d) => julesDe(d).length).length;
  const resultat = { choix: [], pasPretes: [], depotsConcernes: 0, enCours };
  for (const d of depots) {
    if (!(d.reservees_jules ?? []).length) continue;
    resultat.depotsConcernes += 1;
    // Un incident ou un dépôt gelé : le dépôt attend, la tâche reste réservée. Un travail en cours ne le retient plus (23/10/2026) : seuls comptent ses fichiers.
    if (DEPOTS_GELES.has(String(d.repo).toLowerCase())) { resultat.pasPretes.push({ ref: d.reservees_jules[0].ref, raisons: ['dépôt gelé'] }); continue; }
    if ((d.incidents ?? []).length) continue;
    const occupants = [...(d.occupe_par ?? []).filter((o) => o.motif !== 'jules'), ...julesDe(d)].filter((o) => Array.isArray(o.fichiers) && o.fichiers.length);
    if (enCours + resultat.choix.length >= SIMULTANEES_MAX) continue;
    for (const c of d.reservees_jules.slice(0, CANDIDATES_MAX)) {
      if ((etat.confies?.[c.ref]?.fois ?? 0) >= FOIS_MAX) { resultat.pasPretes.push({ ref: c.ref, raisons: [`déjà confiée ${FOIS_MAX} fois`] }); continue; }
      let issue;
      try { issue = lireIssue(d.repo, c.n); } catch (e) { resultat.pasPretes.push({ ref: c.ref, raisons: [`issue illisible (${String(e.message).slice(0, 60)})`] }); continue; }
      if (issue.state !== 'open') { resultat.pasPretes.push({ ref: c.ref, raisons: ['fermée'] }); continue; }
      const verdict = evaluerJules({ repo: d.repo, n: c.n, labels: issue.labels, body: issue.body });
      if (!verdict.ok) { resultat.pasPretes.push({ ref: c.ref, raisons: verdict.raisons }); continue; }
      const gene = occupants.map((o) => raisonIncompatible(o.fichiers, fichiersDeclares(issue.body))).find(Boolean);
      if (gene) { resultat.pasPretes.push({ ref: c.ref, raisons: [`fichiers déjà pris : ${gene} avec ${occupants.map((o) => o.ref ?? o.motif).join(', ')}`] }); continue; }
      resultat.choix.push({ repo: d.repo, ref: c.ref, n: c.n, titre: c.titre });
      break;
    }
  }
  return resultat;
}

/**
 * Confie la tâche à Jules après une dernière vérification EN DIRECT : issue ouverte, dépôt non gelé, aucune étiquette qui l'écarte, et aucun fichier
 * déjà pris (PR ouvertes hors robots et boîte du Réacteur, tâches en cours sans PR). Un travail en cours ne la retient pas. `gh(methode, chemin, corps)` rend l'objet JSON ou lève.
 * @returns {{ statut: 'confiee'|'sautee', raison?: string }}
 */
export async function confierAJules({ repo, n }, gh, { aBlanc = false } = {}) {
  const base = `repos/${ORG}/${repo}`;
  const issue = await gh('GET', `${base}/issues/${n}`);
  const etiquettes = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
  if (issue.state !== 'open') return { statut: 'sautee', raison: 'fermée' };
  if (DEPOTS_GELES.has(repo.toLowerCase())) return { statut: 'sautee', raison: 'dépôt gelé' };
  const ecartee = ETIQUETTES_QUI_ECARTENT.find((l) => etiquettes.includes(l));
  if (ecartee) return { statut: 'sautee', raison: `étiquette « ${ecartee} »` };
  // Les travaux du dépôt, lus EN DIRECT : issues `en-cours` ou `jules` ouvertes (avec leur corps, donc leurs fichiers) et PR ouvertes.
  const issuesTravail = new Map();
  for (const l of ETIQUETTES_QUI_OCCUPENT) {
    const ouvertes = await gh('GET', `${base}/issues?labels=${encodeURIComponent(l)}&state=open&per_page=30`);
    for (const i of Array.isArray(ouvertes) ? ouvertes : []) if (!i.pull_request && i.number !== n) issuesTravail.set(i.number, i);
  }
  const prs = await gh('GET', `${base}/pulls?state=open&per_page=30`);
  const prsTravail = (Array.isArray(prs) ? prs : []).filter((p) => p.user?.type !== 'Bot' && !String(p.user?.login ?? '').endsWith('[bot]') && !(repo.toLowerCase() === BOITE.depot && p.number === BOITE.pr));
  // Jules part même si le dépôt a un travail en cours : il évite seulement les fichiers déjà touchés par une PR ouverte (déclarés ∪ réels pour la PR
  // d'une tâche en cours) ou déclarés par une tâche en cours sans PR. Fichiers de la PR illisibles ou tronqués : dans le doute, il attend.
  const fichiersDe = async (p) => {
    try {
      const fs = await gh('GET', `${base}/pulls/${p.number}/files?per_page=100`);
      return Array.isArray(fs) && fs.length < 100 ? fs.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean)) : null; // 100 fichiers : liste tronquée, elle ne prouve rien
    } catch { return null; }
  };
  const miens = fichiersDeclares(issue.body);
  const tacheDe = (p) => extraireTaches(p.body, repo).filter((t) => t.depot.toLowerCase() === repo.toLowerCase()).map((t) => issuesTravail.get(t.numero)).find(Boolean);
  for (const p of prsTravail) {
    const autre = tacheDe(p);
    const gene = raisonIncompatible(fichiersDuTravail(autre ? fichiersDeclares(autre.body) : null, await fichiersDe(p)), miens);
    if (gene) return { statut: 'sautee', raison: `fichiers déjà pris (PR #${p.number} ouverte : ${gene})` };
  }
  const prisParUnePr = new Set(prsTravail.map((p) => tacheDe(p)?.number).filter(Boolean));
  for (const t of issuesTravail.values()) {
    if (prisParUnePr.has(t.number)) continue;
    const declares = fichiersDeclares(t.body);
    const gene = declares ? raisonIncompatible(declares, miens) : null; // une tâche sans fichiers déclarés ne dit rien : seule sa PR comptera
    if (gene) return { statut: 'sautee', raison: `fichiers déjà pris (issue #${t.number} en cours : ${gene})` };
  }
  if (aBlanc) return { statut: 'confiee', raison: 'à blanc' };
  await gh('POST', `${base}/issues/${n}/labels`, { labels: ['jules'] });
  await gh('POST', `${base}/issues/${n}/comments`, {
    body: `${MARQUE_CONFIEE} par le Réacteur (tâche réservée \`faisable-jules\`, un événement du dépôt, corps au gabarit). Le corps de l'issue est sa consigne. Claude relit la PR et pose la preuve « Acceptée ».`,
  });
  return { statut: 'confiee' };
}

/** Combien de fois cette tâche a déjà été confiée : les commentaires de confiage de l'issue (pas de fichier d'état, rien ne dépend du PC). */
export const foisConfiee = (commentaires) => (commentaires ?? []).filter((c) => String(c?.body ?? '').startsWith(MARQUE_CONFIEE)).length;

/**
 * Confie à Jules la première tâche réservée d'UN dépôt, à l'événement qui vient de se produire (tâche MoKarade/.github#704, docs/cycle-de-vie-tache.md §5 quater) :
 * mêmes règles, mêmes plafonds, mêmes exclusions que le tour du PC (`choisirPourJules`, `confierAJules`), mais lues avec le jeton du job, jamais dans `prochaines.json`.
 * `file` : le résultat de `fileDuDepot` (`reservees`, `julesEnCours`, `occupePar`, `incidents`). `api(methode, chemin, corps)` : chemin avec « / » initial.
 * Les trois Jules du plafond se comptent sur toute l'organisation (recherche des issues ouvertes `jules`) ; un dépôt privé (DriveAI) que le jeton ne voit pas n'y
 * est pas compté, et deux événements simultanés dans deux dépôts peuvent dépasser le plafond d'un : le quota de Jules (15) ne s'en ressent pas.
 * Rend { statut: 'confiee'|'rien'|'illisible', ref?, raison?, pasPretes? } ; ne lève jamais.
 */
export async function confierJulesDuDepot({ api, depot, file, aBlanc = false }) {
  const nom = String(depot).split('/').pop();
  try {
    const reservees = file?.reservees ?? [];
    if (!file || file.statut === 'illisible') return { statut: 'illisible', raison: 'file du dépôt illisible' };
    if (!reservees.length) return { statut: 'rien', raison: 'aucune tâche réservée' };
    const propres = [...(file.julesEnCours ?? []), ...(file.occupePar ?? []).filter((o) => o.motif === 'jules')];
    // Jules en cours dans toute l'organisation, hors ce dépôt (déjà dans `propres`) : une recherche, un appel.
    const recherche = await api('GET', `/search/issues?q=${encodeURIComponent(`org:${ORG} is:issue is:open label:jules`)}&per_page=1`);
    const total = Number(recherche?.total_count);
    if (!Number.isFinite(total)) return { statut: 'illisible', raison: 'plafond des trois Jules non lisible' };
    const ailleurs = Math.max(0, total - propres.length);
    const lues = new Map();
    const etat = { confies: {} };
    for (const c of reservees.slice(0, CANDIDATES_MAX)) {
      const i = await api('GET', `/repos/${depot}/issues/${c.n}`);
      if (!i) continue;
      lues.set(c.n, { state: i.state, labels: (i.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)), body: i.body ?? '' });
      const commentaires = await api('GET', `/repos/${depot}/issues/${c.n}/comments?per_page=100`);
      etat.confies[c.ref] = { fois: foisConfiee(commentaires) };
    }
    const prochaines = {
      depots: [
        { repo: nom, reservees_jules: reservees, jules_en_cours: file.julesEnCours ?? [], occupe_par: file.occupePar ?? [], incidents: file.incidents ?? [] },
        // Les Jules des autres dépôts : une entrée par tâche, sans réservée, pour que le plafond de trois les compte.
        ...Array.from({ length: ailleurs }, (_, k) => ({ repo: `_ailleurs${k}`, jules_en_cours: [{ ref: `_${k}` }], reservees_jules: [] })),
      ],
    };
    const lire = (_repo, n) => { const i = lues.get(n); if (!i) throw new Error('issue introuvable'); return i; };
    const { choix, pasPretes } = choisirPourJules(prochaines, lire, etat);
    if (!choix.length) return { statut: 'rien', raison: pasPretes[0] ? `${pasPretes[0].ref} ${pasPretes[0].raisons[0]}` : 'plafond, incident ou dépôt gelé', pasPretes };
    const gh = (m, chemin, corps) => api(m, `/${chemin}`, corps);
    const r = await confierAJules({ repo: nom, n: choix[0].n }, gh, { aBlanc });
    return r.statut === 'confiee' ? { statut: 'confiee', ref: choix[0].ref, n: choix[0].n, aBlanc } : { statut: 'rien', raison: `${choix[0].ref} ${r.raison}`, pasPretes };
  } catch (e) {
    return { statut: 'illisible', raison: String(e.message).slice(0, 120) };
  }
}
