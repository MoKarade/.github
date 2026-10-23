#!/usr/bin/env node
// Jules prend seul les tâches faisables (demande de Marc du 19/10/2026 : « full auto, mécaniquement, pour qu'il avance autant que possible
// malgré le quota bas de Claude »). Jules ne consomme pas le quota Claude : le filet du PC (`filet-pc.mjs`) lui confie, à chaque tour, la
// première tâche RÉSERVÉE (étiquette `faisable-jules`, posée par qui écrit ou range la tâche : le filet ne devine pas) d'un dépôt LIBRE
// dont le CORPS est une consigne complète au gabarit `docs/jules-gabarit-issue.md`. Aucune IA, aucun jugement : une tâche est confiable
// ou elle ne l'est pas, et la raison s'écrit. Règles : plan du fil Jules, `commun/plans/2026-10-19_jules-automatique.md`.
//
// Dépôt avec une place libre (deux places par dépôt, décision de Marc du 21/10/2026) : aucun incident et moins de deux travaux (issues `jules` ou
// `en-cours` ouvertes, PR ouvertes hors robots et boîte du Réacteur ; une tâche et sa PR comptent pour un). Avec un travail déjà en cours, Jules ne
// prend la deuxième place que si les fichiers de sa tâche (« Fichiers permis ») et ceux de ce travail sont DÉCLARÉS et disjoints (`capacite.mjs`) ;
// vérifié EN DIRECT au moment de confier. Plafond : trois tâches Jules en même temps sur les dix dépôts (le quota de Jules est de 15 simultanées).
// Confier = poser l'étiquette `jules` (le signal que Jules lit) + un commentaire d'une ligne. Le « ménage » du cycle de vie (§7) retire
// l'étiquette après 24 h sans PR ; une tâche déjà confiée deux fois ne l'est plus (elle reste réservée : le silence de 24 h réveille alors le
// Coordinateur, qui corrige le corps).
//
// Fonctions pures (`evaluerJules`, `choisirPourJules`), I/O injecté (`lireIssue`, `gh`) : les tests n'ont besoin ni de réseau ni de fichier.

import { PLACES_PAR_DEPOT, fichiersDeclares, fichiersDuTravail, raisonIncompatible } from './capacite.mjs';
import { extraireTaches } from './tache-liee.mjs';

const ORG = 'MoKarade';

export const SECTIONS_REQUISES = ['Avant', 'Après', 'Fini quand', 'Fichiers permis', 'À faire', 'À ne pas faire', 'Vérifier', 'À citer dans la PR'];
export const FICHIERS_MAX = 5;
export const CANDIDATES_MAX = 8;
export const FOIS_MAX = 2;
export const SIMULTANEES_MAX = 3;
const BOITE = { depot: 'app-template', pr: 58 };

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
  [/(^|\/)(BACKLOG|HANDOVER|CLAUDE|AGENTS)\.md$/, 'fichier d\'instructions à ne pas réécrire'],
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
    if (fichiers.length > FICHIERS_MAX) raisons.push(`plus de ${FICHIERS_MAX} fichiers permis (${fichiers.length})`);
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
    if (fichiers.some((f) => FICHIER_MD.test(f)) && !(/fran[cç]ais/i.test(consignes) && /accent/i.test(consignes))) {
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
    // Deux travaux en cours, ou un incident : le dépôt attend. La tâche reste réservée.
    // Le filet de Jules garde sa règle : il n'ajoute pas une tâche à un dépôt déjà occupé, par un fil ou par lui-même.
    const occupants = [...(d.occupe_par ?? []).filter((o) => o.motif !== 'jules'), ...julesDe(d)];
    if (occupants.length >= PLACES_PAR_DEPOT || (d.incidents ?? []).length) continue;
    // Un seul travail en cours dont les fichiers ne sont pas déclarés : pas de deuxième place (dans le doute, un seul), sans rien lire.
    if (occupants.some((o) => !Array.isArray(o.fichiers) || !o.fichiers.length)) continue;
    if (enCours + resultat.choix.length >= SIMULTANEES_MAX) continue;
    for (const c of d.reservees_jules.slice(0, CANDIDATES_MAX)) {
      if ((etat.confies?.[c.ref]?.fois ?? 0) >= FOIS_MAX) { resultat.pasPretes.push({ ref: c.ref, raisons: [`déjà confiée ${FOIS_MAX} fois`] }); continue; }
      let issue;
      try { issue = lireIssue(d.repo, c.n); } catch (e) { resultat.pasPretes.push({ ref: c.ref, raisons: [`issue illisible (${String(e.message).slice(0, 60)})`] }); continue; }
      if (issue.state !== 'open') { resultat.pasPretes.push({ ref: c.ref, raisons: ['fermée'] }); continue; }
      const verdict = evaluerJules({ repo: d.repo, n: c.n, labels: issue.labels, body: issue.body });
      if (!verdict.ok) { resultat.pasPretes.push({ ref: c.ref, raisons: verdict.raisons }); continue; }
      const gene = occupants.map((o) => raisonIncompatible(o.fichiers, fichiersDeclares(issue.body))).find(Boolean);
      if (gene) { resultat.pasPretes.push({ ref: c.ref, raisons: [`place partagée refusée : ${gene} avec ${occupants.map((o) => o.ref ?? o.motif).join(', ')}`] }); continue; }
      resultat.choix.push({ repo: d.repo, ref: c.ref, n: c.n, titre: c.titre });
      break;
    }
  }
  return resultat;
}

/**
 * Confie la tâche à Jules après une dernière vérification EN DIRECT : issue ouverte, aucune étiquette qui l'écarte, moins de deux travaux dans le
 * dépôt (issues `jules` ou `en-cours` ouvertes, PR ouvertes hors robots et boîte du Réacteur), et, avec un travail déjà en cours, des fichiers disjoints. `gh(methode, chemin, corps)` rend l'objet JSON ou lève.
 * @returns {{ statut: 'confiee'|'sautee', raison?: string }}
 */
export function confierAJules({ repo, n }, gh, { aBlanc = false } = {}) {
  const base = `repos/${ORG}/${repo}`;
  const issue = gh('GET', `${base}/issues/${n}`);
  const etiquettes = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
  if (issue.state !== 'open') return { statut: 'sautee', raison: 'fermée' };
  const ecartee = ETIQUETTES_QUI_ECARTENT.find((l) => etiquettes.includes(l));
  if (ecartee) return { statut: 'sautee', raison: `étiquette « ${ecartee} »` };
  // Les travaux du dépôt, lus EN DIRECT : issues `en-cours` ou `jules` ouvertes (avec leur corps, donc leurs fichiers), et PR ouvertes qui ne
  // citent aucune de ces issues (une tâche et sa PR comptent pour un travail ; une PR seule a des fichiers inconnus).
  const issuesTravail = new Map();
  for (const l of ETIQUETTES_QUI_OCCUPENT) {
    const ouvertes = gh('GET', `${base}/issues?labels=${encodeURIComponent(l)}&state=open&per_page=30`);
    for (const i of Array.isArray(ouvertes) ? ouvertes : []) if (!i.pull_request && i.number !== n) issuesTravail.set(i.number, i);
  }
  const prs = gh('GET', `${base}/pulls?state=open&per_page=30`);
  const prsTravail = (Array.isArray(prs) ? prs : []).filter((p) => p.user?.type !== 'Bot' && !String(p.user?.login ?? '').endsWith('[bot]') && !(repo.toLowerCase() === BOITE.depot && p.number === BOITE.pr));
  const prsSeules = prsTravail.filter((p) => !extraireTaches(p.body, repo).some((t) => t.depot.toLowerCase() === repo.toLowerCase() && issuesTravail.has(t.numero)));
  const travaux = issuesTravail.size + prsSeules.length;
  const nom = (i) => `issue #${i.number}`;
  if (travaux >= PLACES_PAR_DEPOT) {
    const premier = [...issuesTravail.values()].map(nom)[0] ?? `PR #${prsSeules[0]?.number} ouverte`;
    return { statut: 'sautee', raison: `dépôt occupé (${premier}, ${travaux} travaux sur ${PLACES_PAR_DEPOT} places)` };
  }
  if (travaux === 1) {
    // Deuxième place : seulement si le seul autre travail a des fichiers connus (ceux qu'il déclare plus ceux de sa PR ouverte, lus en direct)
    // et qu'ils sont disjoints de ceux de cette tâche.
    const autre = [...issuesTravail.values()][0];
    const fichiersDe = (p) => {
      try {
        const fs = gh('GET', `${base}/pulls/${p.number}/files?per_page=100`);
        return Array.isArray(fs) && fs.length < 100 ? fs.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean)) : null; // 100 fichiers : liste tronquée, elle ne prouve rien
      } catch { return null; }
    };
    const prDeLAutre = autre ? prsTravail.find((p) => extraireTaches(p.body, repo).some((t) => t.depot.toLowerCase() === repo.toLowerCase() && t.numero === autre.number)) : prsSeules[0];
    const fichiers = fichiersDuTravail(autre ? fichiersDeclares(autre.body) : null, prDeLAutre ? fichiersDe(prDeLAutre) : null);
    const gene = raisonIncompatible(fichiers, fichiersDeclares(issue.body));
    if (gene) return { statut: 'sautee', raison: `dépôt occupé (${autre ? `${nom(autre)} en cours` : `PR #${prDeLAutre.number} ouverte`} : ${gene})` };
  }
  if (aBlanc) return { statut: 'confiee', raison: 'à blanc' };
  gh('POST', `${base}/issues/${n}/labels`, { 'labels[]': 'jules' });
  gh('POST', `${base}/issues/${n}/comments`, {
    body: `Confiée à Jules automatiquement par le filet du PC (tâche réservée \`faisable-jules\`, une place libre dans le dépôt, corps au gabarit). Le corps de l'issue est sa consigne. Claude relit la PR et pose la preuve « Acceptée ».`,
  });
  return { statut: 'confiee' };
}
