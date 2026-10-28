#!/usr/bin/env node
// Contrôle d'une preuve AU MOMENT où elle est écrite (docs/cycle-de-vie-tache.md §10 bis ter, mission MoKarade/.github#703, tâche #713).
//
// Constat du 28/10/2026 : 87 tâches sur 660 (13 %) ont été rouvertes par le garde-fou de preuve parce que la preuve, souvent de bon fond, avait un mauvais format
// (empreinte du déploiement au lieu de celle de la PR, « Preuve » sans deux-points, PR non citée). Chaque réouverture coûte des heures d'attente et un rouge.
// Ici, à la création d'un commentaire qui commence par « **Acceptée** » sur une issue `niveau:tâche` OUVERTE, le même jugement que le garde-fou
// (`traiter` de scripts/preuve.mjs, importé, jamais modifié) est rendu comme si l'issue se fermait maintenant, et UNE réponse dit tout de suite :
// « serait acceptée » ou la liste des motifs. Rien n'est fermé, édité, rouvert ni étiqueté : toute écriture de `traiter` est interceptée et jetée.
//
// Aucun texte du commentaire n'est recopié dans la réponse (seuls les motifs fixes de preuve.mjs, des numéros, des empreintes hexadécimales et un nom de dépôt
// de la forme [\w.-]+ y figurent). Une seule réponse par commentaire : la réponse porte `<!-- controle-preuve:<id du commentaire> -->`.
// Fonctions pures d'un côté (`reponse`, `aControler`), I/O de l'autre (`controler`, avec `api` injecté : les tests n'ont besoin ni de réseau ni de jeton).
import { pathToFileURL } from 'node:url';
import { ENTETE_ACCEPTEE, LABEL_TACHE, traiter } from './preuve.mjs';

export const marqueur = (idCommentaire) => `<!-- controle-preuve:${idCommentaire} -->`;

/** Faut-il contrôler ce commentaire ? Une personne (jamais un robot ni Jules), « **Acceptée** » en tête, sur une tâche ouverte. */
export function aControler({ issue, commentaire }) {
  if (!issue || issue.state !== 'open') return { ok: false, raison: 'l’issue n’est pas ouverte' };
  const etiquettes = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
  if (!etiquettes.includes(LABEL_TACHE)) return { ok: false, raison: `pas de ${LABEL_TACHE}` };
  if (!commentaire || commentaire.user?.type !== 'User' || /jules/i.test(commentaire.user?.login ?? '')) return { ok: false, raison: 'commentaire d’un robot ou de Jules' };
  if (!ENTETE_ACCEPTEE.test(commentaire.body ?? '')) return { ok: false, raison: 'le commentaire ne commence pas par « **Acceptée** »' };
  return { ok: true };
}

/** La réponse : « serait acceptée », ou les motifs du garde-fou, avec le rappel qu'aucune écriture n'a eu lieu. */
export function reponse({ idCommentaire, statut, motifs }) {
  const tete = marqueur(idCommentaire);
  if (statut === 'acceptee') return `${tete}\n**Contrôle de la preuve** : serait acceptée. Rien n'est fermé : ferme l'issue quand tu veux.`;
  return [
    tete,
    '**Contrôle de la preuve** : serait refusée, et l’issue rouverte avec `preuve-manquante` si tu la fermais maintenant.',
    '',
    ...motifs.map((m) => `- ${m}`),
    '',
    'Corrige le commentaire (édite-le, ou pose-en un nouveau qui commence par `**Acceptée** —`) puis ferme l’issue. Rien n’a été fermé, édité ni rouvert par ce contrôle.',
  ].join('\n');
}

const pages = async (api, chemin) => {
  const tout = [];
  for (let p = 1; p <= 5; p += 1) {
    const page = await api(`${chemin}${chemin.includes('?') ? '&' : '?'}per_page=100&page=${p}`);
    tout.push(...page);
    if (page.length < 100) break;
  }
  return tout;
};

/**
 * Contrôle le commentaire `idCommentaire` de l'issue `numero`. Rend { statut: 'repondu'|'ignore', verdict?, raison? } ; ne lève que sur une panne d'API.
 * @param api (chemin, { method, body }) -> JSON (même forme que scripts/preuve.mjs)
 */
export async function controler({ api, depot, numero, idCommentaire, config = {} }) {
  const issue = await api(`/repos/${depot}/issues/${numero}`);
  const commentaires = await pages(api, `/repos/${depot}/issues/${numero}/comments`);
  const commentaire = commentaires.find((c) => String(c.id) === String(idCommentaire));
  const doit = aControler({ issue, commentaire });
  if (!doit.ok) return { statut: 'ignore', raison: doit.raison };
  if (commentaires.some((c) => String(c.body ?? '').includes(marqueur(idCommentaire)))) return { statut: 'ignore', raison: 'déjà contrôlé' };

  // Le juge est celui de la fermeture : l'issue est présentée comme fermée `completed`, et toute écriture est jetée.
  const lecture = async (chemin, init = {}) => {
    if ((init.method ?? 'GET') !== 'GET') return null;
    const r = await api(chemin, init);
    return chemin === `/repos/${depot}/issues/${numero}` ? { ...r, state: 'closed', state_reason: 'completed' } : r;
  };
  const verdict = await traiter({ api: lecture, depot, numero, config });
  await api(`/repos/${depot}/issues/${numero}/comments`, { method: 'POST', body: { body: reponse({ idCommentaire: commentaire.id, statut: verdict.statut, motifs: verdict.motifs }) } });
  return { statut: 'repondu', verdict: verdict.statut === 'acceptee' ? 'acceptee' : 'refusee', motifs: verdict.motifs };
}

const apiReelle = (jeton) => async (chemin, { method = 'GET', body } = {}) => {
  const r = await fetch(`https://api.github.com${chemin}`, {
    method,
    headers: {
      Authorization: `Bearer ${jeton}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`GitHub ${method} ${chemin.split('?')[0]} : HTTP ${r.status}`);
  return r.status === 204 ? null : r.json();
};

async function main() {
  const env = process.env;
  const numero = Number(env.ISSUE_NUMBER);
  const idCommentaire = Number(env.COMMENT_ID);
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY || !Number.isInteger(numero) || !Number.isInteger(idCommentaire)) throw new Error('GITHUB_TOKEN, GITHUB_REPOSITORY, ISSUE_NUMBER et COMMENT_ID sont requis');
  const config = {
    deploiement: env.PREUVE_DEPLOIEMENT === 'aucun' ? 'aucun' : 'vercel',
    workflows: (env.PREUVE_WORKFLOWS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  };
  const r = await controler({ api: apiReelle(env.GITHUB_TOKEN), depot: env.GITHUB_REPOSITORY, numero, idCommentaire, config });
  console.log(`Contrôle de la preuve — ${env.GITHUB_REPOSITORY}#${numero} (commentaire ${idCommentaire}) : ${r.statut}${r.verdict ? ` (${r.verdict})` : ''}${r.raison ? ` : ${r.raison}` : ''}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((e) => {
    // Jamais de rouge pour un contrôle de courtoisie : le garde-fou de fermeture reste le juge.
    console.log(`::warning::Contrôle de la preuve non fait (${e.message}). Le garde-fou de fermeture reste le juge.`);
  });
}
