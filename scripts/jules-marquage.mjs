// Marquage automatique `faisable-jules` (tâche MoKarade/.github#296, demande de Marc du 19/10/2026 19:45Z : « full autonome, même pas de fil »).
//
// Le tour du PC pose `faisable-jules` sur toute tâche ouverte que Jules peut prendre SANS relecture du gabarit par un fil : `evaluerJules`
// (jules-auto.mjs) dit oui (huit sections, cinq fichiers permis au plus, aucun chemin interdit, preuves demandées pour écrans, dépendances et .md),
// aucune étiquette ne l'écarte, aucune dépendance n'est ouverte (ligne `**Attend**` ET lien natif « Bloquée par »), aucune PR ouverte ne la cite.
// Une tâche pas au gabarit est refusée et laissée : c'est voulu, rien n'est deviné. Le poids de la réserve est borné (RESERVE_MAX par dépôt) :
// une tâche réservée sort de la file de Claude, donc on ne réserve pas plus que Jules ne peut prendre.
import { evaluerJules, exclueParDecision } from './jules-auto.mjs';
import { tachesCitees } from './jules-suivi.mjs';

const ORG = 'MoKarade';
export const RESERVE_MAX = 2;
export const ETIQUETTE = 'faisable-jules';
// `prio:3` n'écarte plus le marquage : Marc a répondu « Oui sauf #247 » le 21/10/2026 (carte « Laisser Jules prendre aussi les tâches prio:3 ? »).
// Les tâches qu'il garde hors de Jules sont nommées dans `EXCLUES_PAR_DECISION` (jules-auto.mjs).
/**
 * Une tâche qui ajoute un outil MCP reste hors du full auto (décision de Marc, 19/10/2026 19:56Z : « 4 oui ») : sa preuve en production
 * demande une session avec son connecteur. Lu dans le corps de la tâche ; le diff est relu à la fusion (`toucheMcp`, jules-suivi.mjs).
 */
export const MENTION_MCP = /registerTool|lib\/mcp\/|app\/api\/mcp|(?:outil|serveur|tool)s?\s+MCP/i;

const noms = (labels) => (labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));

/** Reste de la ligne `**Attend**` (aussi écrite `**Attend :**` ou `**Attend:**`, faute courante : .github#503, 22/10/2026), ou null. Même règle que `deps.py` (`reste_attend`). */
export const resteAttend = (ligne) => /^\*\*Attend\s*(?::\s*\*\*|\*\*\s*:?)\s*(.*)$/.exec(ligne)?.[1] ?? null;

/** Les tâches citées par la ligne `**Attend**` d'un corps : « #12, MoKarade/x#3 — raison » -> [{depot, n}] (« rien/aucune » = aucune). */
export function dependancesEcrites(corps, depot) {
  const refs = [];
  for (const ligne of String(corps ?? '').split('\n')) {
    const reste = resteAttend(ligne);
    if (reste === null) continue;
    const avant = reste.split('—')[0];
    if (/^[\s:*]*(?:rien|aucune?|néant)\b/i.test(avant)) continue;
    for (const m of avant.matchAll(/(?:MoKarade\/([\w.-]+))?#(\d+)/g)) refs.push({ depot: m[1] ?? depot, n: Number(m[2]) });
  }
  return refs;
}

/**
 * Une dépendance de la tâche est-elle ouverte ? `true` : oui ; `false` : aucune ; `'illisible'` : une lecture a échoué (à traiter comme « oui »).
 * Lit la ligne `**Attend**` ET les liens natifs « Bloquée par ».
 */
export function dependanceOuverte({ depot, court, tache, gh }) {
  try {
    const ecrite = dependancesEcrites(tache.body, court).some((d) => gh('GET', `repos/${ORG}/${d.depot}/issues/${d.n}`).state === 'open');
    const native = gh('GET', `repos/${depot}/issues/${tache.number}/dependencies/blocked_by`).some((b) => b.state === 'open');
    return ecrite || native;
  } catch {
    return 'illisible';
  }
}

/**
 * Une étiquette `faisable-jules` périmée se retire : sur une tâche ouverte, pas encore confiée (ni `jules` ni `en-cours`), dont le corps ne passe plus
 * `evaluerJules` (sections absentes, fichiers en prose, MCP…), l'étiquette ne réserve rien — Jules ne peut jamais la prendre — et elle cache la tâche à
 * Claude (une tâche réservée sort de sa file). Constat du fil Jules, JobAI#198 et #200, 19/10/2026. Une dépendance ouverte, elle, n'est PAS une raison
 * de retirer : la réserve attend. Le commentaire dit pourquoi ; `completerDepot` peut ensuite compléter le corps.
 * @returns {string[]} les références dont l'étiquette est retirée
 */
export function retirerPerimees({ depot, gh, aBlanc = false }) {
  const court = depot.replace(`${ORG}/`, '');
  const retirees = [];
  const reservees = gh('GET', `repos/${depot}/issues?state=open&labels=${ETIQUETTE}&per_page=100`).filter((i) => !i.pull_request);
  for (const t of reservees) {
    const l = noms(t.labels);
    if (l.includes('jules') || l.includes('en-cours')) continue; // déjà confiée : le suivi s'en occupe
    const mcp = MENTION_MCP.test(t.body ?? '') || /\bmcp\b/i.test(t.title ?? '');
    const verdict = evaluerJules({ repo: court, n: t.number, labels: l, body: t.body ?? '' });
    if (verdict.ok && !mcp) continue;
    const raison = mcp ? 'outils MCP : hors du full auto' : verdict.raisons.join(' ; ');
    if (!aBlanc) {
      gh('DELETE', `repos/${depot}/issues/${t.number}/labels/${ETIQUETTE}`);
      gh('POST', `repos/${depot}/issues/${t.number}/comments`, {
        body: `Étiquette \`${ETIQUETTE}\` retirée automatiquement : Jules ne pourrait pas prendre cette tâche en l'état (${raison.slice(0, 400)}). Elle revient dans la file de Claude ; le filet complète le corps seul quand tout se déduit (\`<!-- gabarit-auto -->\`), puis la réserve de nouveau.\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_`,
      });
    }
    retirees.push(`${court}#${t.number}`);
  }
  return retirees;
}

/**
 * @param depot  « MoKarade/JobAI »
 * @param gh     (methode, chemin, corps) -> JSON ou lève
 * @returns {{ marquees: string[], refusees: number, reserve: number }}
 */
/** La tâche porte-t-elle sa ligne `**Attend**` ? Sans elle, `prochaine-tache.mjs` la sort de la file (« attend-absent ») : la réserver à Jules serait une impasse. */
export const aLigneAttend = (corps) => String(corps ?? '').split('\n').some((l) => resteAttend(l) !== null);

export function marquerFaisables({ depot, gh, aBlanc = false }) {
  const court = depot.replace(`${ORG}/`, '');
  const sortie = { marquees: [], refusees: 0, reserve: 0 };
  const ouvertes = gh('GET', `repos/${depot}/issues?state=open&per_page=100`).filter((i) => !i.pull_request && noms(i.labels).includes('niveau:tâche'));
  sortie.reserve = ouvertes.filter((i) => noms(i.labels).includes(ETIQUETTE)).length;
  let place = RESERVE_MAX - sortie.reserve;
  const candidates = ouvertes.filter((i) => {
    const l = noms(i.labels);
    return !l.includes(ETIQUETTE) && !exclueParDecision(court, i.number);
  });
  if (place <= 0 || candidates.length === 0) return sortie;

  const prs = gh('GET', `repos/${depot}/pulls?state=open&per_page=50`);
  const citees = new Set(prs.flatMap((p) => tachesCitees(p)));
  for (const t of candidates) {
    if (place <= 0) break;
    const verdict = evaluerJules({ repo: court, n: t.number, labels: [...noms(t.labels), ETIQUETTE], body: t.body ?? '' });
    if (!aLigneAttend(t.body)) { sortie.refusees += 1; continue; } // la ligne s'écrit à la main : rien n'est deviné
    if (!verdict.ok || citees.has(t.number) || MENTION_MCP.test(t.body ?? '') || /\bmcp\b/i.test(t.title ?? '')) { sortie.refusees += 1; continue; }
    if (dependanceOuverte({ depot, court, tache: t, gh }) !== false) { sortie.refusees += 1; continue; } // ouverte ou illisible : rien n'est deviné
    if (!aBlanc) {
      gh('POST', `repos/${depot}/issues/${t.number}/labels`, { 'labels[]': ETIQUETTE });
      gh('POST', `repos/${depot}/issues/${t.number}/comments`, {
        body: `Réservée à Jules automatiquement par le Réacteur : corps au gabarit complet, aucune dépendance ouverte, aucune PR ouverte. Le Réacteur la lui confie dès que le dépôt est libre.\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_`,
      });
    }
    sortie.marquees.push(`${court}#${t.number}`);
    place -= 1;
  }
  return sortie;
}
