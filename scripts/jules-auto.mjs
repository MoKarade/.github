#!/usr/bin/env node
// Jules prend seul les tâches que le frein de quota retient (demande de Marc du 19/10/2026 : « full auto, mécaniquement, pour qu'il
// avance autant que possible malgré le quota bas de Claude »). Jules ne consomme pas le quota Claude : quand le frein retient tout ce
// qui reste à un dépôt, le filet du PC (`filet-pc.mjs`) lui confie la première tâche dont le CORPS est une consigne complète au
// gabarit `docs/jules-gabarit-issue.md`. Aucune IA, aucun jugement : une tâche est confiable ou elle ne l'est pas, et la raison s'écrit.
//
// Quand : le dépôt est au statut `frein` (rien de ce qui reste n'est permis à Claude, aucun travail en cours), jamais sinon. Un dépôt
// que Claude peut servir reste à Claude : Jules ne lui prend pas sa suivante. Une seule tâche Jules par dépôt, vérifiée EN DIRECT
// (aucune issue `jules` ou `en-cours` ouverte) au moment de la confier.
// Confier = poser l'étiquette `jules` (le signal que Jules lit) + un commentaire d'une ligne. Le « ménage » du cycle de vie (§7)
// retire l'étiquette après 24 h sans PR ; une tâche déjà confiée deux fois ne l'est plus (elle revient à Claude).
//
// Fonctions pures (`evaluerJules`, `choisirPourJules`), I/O injecté (`lireIssue`, `gh`) : les tests n'ont besoin ni de réseau ni de fichier.

const ORG = 'MoKarade';

export const SECTIONS_REQUISES = ['Avant', 'Après', 'Fini quand', 'Fichiers permis', 'À faire', 'À ne pas faire', 'Vérifier', 'À citer dans la PR'];
export const FICHIERS_MAX = 2;
export const CANDIDATES_MAX = 8;
export const FOIS_MAX = 2;

// Ce que Jules ne touche jamais (AGENTS.md, gabarit « Tâches à garder pour Claude »).
const CHEMINS_INTERDITS = [
  [/^\.github\//, 'chemin protégé .github/'],
  [/^scripts\//, 'chemin protégé scripts/'],
  [/^surveillance\//, 'chemin protégé surveillance/'],
  [/^qualite\//, 'chemin protégé qualite/'],
  [/^\.claude\//, 'chemin protégé .claude/'],
  [/(^|\/)\.mergify\.yml$/, 'chemin protégé .mergify.yml'],
  [/(^|\/)(CODEOWNERS|vercel\.json)$/, 'chemin protégé'],
  [/(^|\/)\.env/, 'secret (.env)'],
  [/(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/, 'dépendances'],
  [/(^|\/)(drizzle|migrations?)\//i, 'base de données'],
  [/schema\.(ts|sql)$|\.sql$/i, 'base de données'],
  [/(^|\/)(auth|middleware|proxy)[\w.-]*\.(ts|tsx|js|mjs)$/i, 'authentification'],
  [/secret|token|credential/i, 'secret ou jeton'],
  [/(^|\/)(BACKLOG|HANDOVER|CLAUDE|AGENTS)\.md$/, 'long .md à ne pas réécrire'],
];
const DEPOTS_INTERDITS = { 'hub-contract': 'le contrat', };
const ETIQUETTES_INTERDITES = ['sécurité', 'securite', 'incident', 'preuve-manquante', 'écran', 'ecran', 'ui', 'design', 'migration', 'secret'];
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
 * Pour chaque dépôt au frein, la première tâche retenue dont le corps est une consigne complète.
 * @param prochaines contenu de prochaines.json
 * @param lireIssue (depot, n) -> { state, labels, body } (EN DIRECT)
 * @param etat { confies: { ref: { fois } } } : une tâche déjà confiée `FOIS_MAX` fois n'est plus proposée
 * @returns {{ choix: {repo, ref, n, titre}[], pasPretes: {ref, raisons}[], depotsAuFrein: number }}
 */
export function choisirPourJules(prochaines, lireIssue, etat = {}) {
  const resultat = { choix: [], pasPretes: [], depotsAuFrein: 0 };
  for (const d of prochaines.depots ?? []) {
    if (d.statut !== 'frein') continue;
    resultat.depotsAuFrein += 1;
    for (const c of (d.retenues_frein ?? []).slice(0, CANDIDATES_MAX)) {
      if ((etat.confies?.[c.ref]?.fois ?? 0) >= FOIS_MAX) { resultat.pasPretes.push({ ref: c.ref, raisons: [`déjà confiée ${FOIS_MAX} fois`] }); continue; }
      let issue;
      try { issue = lireIssue(d.repo, c.n); } catch (e) { resultat.pasPretes.push({ ref: c.ref, raisons: [`issue illisible (${String(e.message).slice(0, 60)})`] }); continue; }
      if (issue.state !== 'open') { resultat.pasPretes.push({ ref: c.ref, raisons: ['fermée'] }); continue; }
      const verdict = evaluerJules({ repo: d.repo, n: c.n, labels: issue.labels, body: issue.body });
      if (!verdict.ok) { resultat.pasPretes.push({ ref: c.ref, raisons: verdict.raisons }); continue; }
      resultat.choix.push({ repo: d.repo, ref: c.ref, n: c.n, titre: c.titre });
      break;
    }
  }
  return resultat;
}

/**
 * Confie la tâche à Jules après une dernière vérification EN DIRECT : issue ouverte, aucune étiquette qui l'écarte, et aucun autre travail
 * `jules` ou `en-cours` ouvert dans le dépôt. `gh(methode, chemin, corps)` rend l'objet JSON ou lève.
 * @returns {{ statut: 'confiee'|'sautee', raison?: string }}
 */
export function confierAJules({ repo, n, palier }, gh, { aBlanc = false } = {}) {
  const base = `repos/${ORG}/${repo}`;
  const issue = gh('GET', `${base}/issues/${n}`);
  const etiquettes = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
  if (issue.state !== 'open') return { statut: 'sautee', raison: 'fermée' };
  const ecartee = ETIQUETTES_QUI_ECARTENT.find((l) => etiquettes.includes(l));
  if (ecartee) return { statut: 'sautee', raison: `étiquette « ${ecartee} »` };
  for (const l of ETIQUETTES_QUI_OCCUPENT) {
    const ouvertes = gh('GET', `${base}/issues?labels=${encodeURIComponent(l)}&state=open&per_page=5`);
    if ((Array.isArray(ouvertes) ? ouvertes : []).some((i) => !i.pull_request)) return { statut: 'sautee', raison: `dépôt occupé (issue « ${l} » ouverte)` };
  }
  if (aBlanc) return { statut: 'confiee', raison: 'à blanc' };
  gh('POST', `${base}/issues/${n}/labels`, { 'labels[]': 'jules' });
  gh('POST', `${base}/issues/${n}/comments`, {
    body: `Confiée à Jules automatiquement par le filet du PC : le frein de quota Claude est au palier ${palier}, Claude ne prend pas cette tâche, Jules n'en consomme pas. Le corps de l'issue est sa consigne. Claude relit la PR et pose la preuve « Acceptée ».`,
  });
  return { statut: 'confiee' };
}
