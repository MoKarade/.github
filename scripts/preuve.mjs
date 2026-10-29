#!/usr/bin/env node
// Garde-fou de preuve (docs/cycle-de-vie-tache.md §10 bis) : une tâche ne reste fermée que si sa preuve est valide.
//
// Rôle : quand une issue `niveau:tâche` est fermée, ce script relit ses commentaires et vérifie, sur GitHub,
// que la fermeture est justifiée.
//   - `completed` : un commentaire « **Acceptée** — … » écrit par une personne ou par Claude (jamais un robot,
//     jamais Jules, sauf l'acceptation automatique marquée de scripts/acceptation-auto.mjs), après la fusion de la PR citée, avec l'empreinte du commit fusionné, sans aveu de doute
//     ([Probable], « pas lu »…), et, si la PR change quelque chose de servi, un déploiement de production réussi
//     sur ce commit (ou sur un commit qui le contient) lu dans l'API GitHub.
//   - `not_planned` / `duplicate` : un commentaire « **Abandonnée** — raison ».
// Sinon l'issue est ROUVERTE, l'étiquette `preuve-manquante` est posée et un commentaire dit ce qui manque.
// La fusion ne ferme donc jamais une tâche (« Fixes #n » de Jules ou de Mergify compris) : seule la preuve la ferme.
//
// Fonctions pures d'un côté (`evaluer`, `lireCitation`, `trouverPreuve`, `corpsReouverture`), I/O de l'autre
// (`traiter`, avec `api` injecté : les tests n'ont besoin ni de réseau ni de jeton). Le jeton n'est lu que dans `main`.
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { estDeConfiance } from './auteur-de-confiance.mjs';

export const LABEL_TACHE = 'niveau:tâche';
export const LABEL_MANQUE = 'preuve-manquante';
export const LABEL_ATTENDUE = 'preuve-attendue';
// Retirés à toute fermeture validée : une tâche finie n'est plus « en cours » et n'attend plus de geste de Marc.
export const LABELS_A_RETIRER = [LABEL_MANQUE, LABEL_ATTENDUE, 'en-cours', 'qui:marc'];
// Une issue d'essai fermée `not_planned` par l'essai lui-même n'a rien à prouver (le Gantt l'ignore aussi).
export const LABEL_ESSAI = 'essai';

// Même définition que le Gantt (fetch.py, PREUVE) : un commentaire de preuve COMMENCE par ce mot en gras.
export const ENTETE_ACCEPTEE = /^\s*\*\*\s*Accept[ée]e\s*\*\*/i;
export const ENTETE_ABANDON = /^\s*\*\*\s*Abandonn[ée]e\s*\*\*/i;

// Aveux de doute : une preuve qui dit qu'elle n'a pas lu, pas testé ou qu'elle est probable n'est pas une preuve.
export const NON_PROUVE =
  /\[(?:probable|supposition|à vérifier|a verifier)\]|(?<![\p{L}])(?:pas|non)\s+(?:encore\s+)?(?:lu|lue|lus|vérifié|vérifiée|verifie|testé|testée)(?![\p{L}])|(?<![\p{L}])je n['’]ai pas (?:lu|vérifié|verifie|pu (?:lire|vérifier|verifier|tester))(?![\p{L}])/iu;

// Fichiers qui ne changent rien de servi : docs, tests, CI, qualité. Tout le reste exige un déploiement.
const SANS_SERVICE =
  /^(?:(?:web|app)\/)?(?:docs?\/|tests?\/|qualite\/|surveillance\/)|^\.github\/|(?:^|\/)[^/]+\.md$|\.(?:test|spec)\.[cm]?[jt]sx?$|^\.mergify\.yml$|^\.gitignore$|^LICENSE$/;

export const servi = (fichiers) => fichiers.some((f) => !SANS_SERVICE.test(f));

const humain = (c) => c.user?.type === 'User' && !/jules/i.test(c.user.login ?? '') && estDeConfiance(c);
// Seule exception à « jamais un robot » (docs/cycle-de-vie-tache.md §10 ter) : l'acceptation automatique de scripts/acceptation-auto.mjs,
// écrite par le robot des workflows et qui porte ce marqueur. Elle n'est reconnue que pour « Acceptée », jamais pour un abandon.
export const MARQUEUR_AUTO = '<!-- acceptation-auto -->';
const automatique = (c) => c.user?.login === 'github-actions[bot]' && String(c.body ?? '').includes(MARQUEUR_AUTO);
const tri = (a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0);

/** Le dernier commentaire d'une personne qui commence par l'en-tête voulu, ou null. */
export function trouverPreuve(commentaires, entete = ENTETE_ACCEPTEE) {
  return commentaires.filter((c) => (humain(c) || (entete === ENTETE_ACCEPTEE && automatique(c))) && entete.test(c.body ?? '')).sort(tri)[0] ?? null;
}

/** Ce que le commentaire cite : la PR, l'empreinte, le déploiement, le texte de preuve. */
export function lireCitation(body) {
  const texte = String(body ?? '');
  // « PR #n », « PR dépôt#n » et « PR MoKarade/dépôt#n » (tâche .github#195 : « PR JobAI#180 » n'était pas reconnu, la tâche rouverte).
  const pr = /\bPR\s+(?:(?:MoKarade\/)?([\w.-]+))?#(\d+)\b/i.exec(texte);
  // Toute suite de 7 à 40 caractères hexadécimaux est une empreinte candidate, y compris « 9088582 » (chiffres seuls) ou
  // « abcdefa » (lettres seules) : tâche .github#215. Un nombre ordinaire ne fait rien de mal ici, puisque `evaluer` ne
  // retient la preuve que si une candidate est le début de l'empreinte réelle du commit fusionné.
  const shas = [...texte.matchAll(/\b([0-9a-f]{7,40})\b/g)].map((m) => m[1]);
  const preuve = /\bpreuve\s*:\s*([\s\S]*)/i.exec(texte);
  return {
    pr: pr ? { depot: pr[1] ?? null, numero: Number(pr[2]) } : null,
    sansPr: /\bsans PR\b/i.test(texte),
    shas,
    preuve: preuve ? preuve[1].replace(/\s+/g, ' ').trim() : '',
  };
}

/** « PR #12 » dans ce dépôt, « PR JobAI#12 » ailleurs : le motif dit quelle PR a été cherchée. */
const nomPr = (pr) => `PR ${pr.depot ?? ''}#${pr.numero}`;

const PREUVE_MIN = 40;
const SANS_PR_MIN = 60;

/**
 * Décide si la fermeture est justifiée.
 * `pr` = la PR citée lue sur GitHub ({ merged, merged_at, merge_commit_sha, head_sha }) ou null ;
 * `fichiers` = noms des fichiers de la PR ; `deploiement` = { requis, ok, detail } pour une PR qui change du servi.
 */
export function evaluer({ raison, commentaires, pr = null, fichiers = [], deploiement = { requis: false, ok: null, detail: '' } }) {
  const motifs = [];
  if (raison === 'not_planned' || raison === 'duplicate') {
    const c = trouverPreuve(commentaires, ENTETE_ABANDON);
    if (!c) motifs.push('abandon sans commentaire « **Abandonnée** — <la raison> » écrit par une personne ou Claude');
    else if (c.body.replace(ENTETE_ABANDON, '').replace(/[\s—:-]+/g, ' ').trim().length < 20) motifs.push('la raison de l’abandon est trop courte (20 caractères au moins)');
    return { ok: motifs.length === 0, motifs, type: 'abandon' };
  }

  const c = trouverPreuve(commentaires);
  if (!c) {
    motifs.push('aucun commentaire « **Acceptée** — … » écrit par une personne ou Claude (un robot ou Jules ne prouve rien)');
    return { ok: false, motifs, type: 'acceptee' };
  }
  const cite = lireCitation(c.body);
  if (NON_PROUVE.test(c.body)) motifs.push('le commentaire avoue un doute ou une lecture manquante ([Probable], « pas lu », « non testé »…) : ce n’est pas une preuve, la tâche reste ouverte avec la ligne « Preuve attendue »');
  if (cite.preuve.length < (cite.pr ? PREUVE_MIN : SANS_PR_MIN)) motifs.push(`la ligne « preuve : … » manque ou est trop courte (${cite.pr ? PREUVE_MIN : SANS_PR_MIN} caractères au moins : ce qui a été LU et le résultat)`);

  if (!cite.pr && !cite.sansPr) {
    motifs.push('ni « PR #n fusionnée » ni « sans PR » : dis quelle PR livre la tâche, ou qu’il n’y en a pas');
  } else if (cite.pr) {
    if (pr?.illisible) {
      // PR d'un autre dépôt, privé : le jeton de ce dépôt ne la lit pas. On ne rouvre pas pour ce que GitHub ne laisse pas voir.
    } else if (!pr) motifs.push(`${nomPr(cite.pr)} introuvable`);
    else if (!pr.merged) motifs.push(`${nomPr(cite.pr)} non fusionnée`);
    else {
      const shas = [pr.merge_commit_sha, pr.head_sha].filter(Boolean);
      if (cite.shas.length === 0) motifs.push('l’empreinte (sha) du commit fusionné n’est pas dans le commentaire');
      else if (!cite.shas.some((c2) => shas.some((s) => s.startsWith(c2)))) motifs.push(`aucune empreinte citée (${cite.shas.join(', ')}) n’est celle de la ${nomPr(cite.pr)}`);
      if (pr.merged_at && c.created_at < pr.merged_at) motifs.push('la preuve est datée d’avant la fusion de la PR');
      if (deploiement.requis && servi(fichiers) && deploiement.ok !== true) {
        motifs.push(`la PR change du code servi et aucun déploiement de production réussi n’est trouvé sur son commit (${deploiement.detail || 'non vérifié'})`);
      }
    }
  }
  return { ok: motifs.length === 0, motifs, type: 'acceptee', preuve: c.html_url ?? null };
}

export const corpsReouverture = (motifs, raison) =>
  [
    `**Garde-fou de preuve** : cette tâche a été fermée (${raison}) sans preuve valide. Elle est rouverte et reçoit l’étiquette \`${LABEL_MANQUE}\`.`,
    '',
    ...motifs.map((m) => `- ${m}`),
    '',
    raison === 'completed' || !raison
      ? 'Pour la refermer : poser un commentaire qui commence par `**Acceptée** — PR #p fusionnée (<sha court>), déploiement READY (<id>), preuve : <ce qui a été LU en production et le résultat>`, puis fermer l’issue. Si la preuve dépend d’un événement ou d’un geste de Marc, rester ouverte avec l’étiquette `preuve-attendue` et la ligne `**Preuve attendue** : AAAA-MM-JJ HH:MM (heure du Québec) — événement`.'
      : 'Pour la refermer : poser un commentaire `**Abandonnée** — <la raison>`, puis fermer l’issue `not_planned`.',
    '',
    'Règle : docs/cycle-de-vie-tache.md §10 bis (MoKarade/.github). La fusion d’une PR ne ferme jamais une tâche.',
  ].join('\n');

const pages = async (api, chemin) => {
  const tout = [];
  for (let p = 1; p <= 5; p += 1) {
    const page = await api(`${chemin}${chemin.includes('?') ? '&' : '?'}per_page=100&page=${p}`);
    tout.push(...page);
    if (page.length < 100) break;
  }
  return tout;
};

const descend = async (api, depot, base, tete) => {
  if (base === tete) return true;
  const r = await api(`/repos/${depot}/compare/${base}...${tete}`);
  return r.status === 'ahead' || r.status === 'identical';
};

/** Délais d'attente (ms) avant de conclure qu'un déploiement manque, pour une fusion de moins de FENETRE_FUSION_MS. */
export const DELAIS_DEPLOIEMENT = [20_000, 20_000, 20_000, 20_000, 20_000, 20_000];
const FENETRE_FUSION_MS = 10 * 60_000;
const pauseReelle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Cherche un déploiement de production réussi sur le commit fusionné, ou sur un commit qui le contient.
 * GitHub n'enregistre le statut `success` d'un déploiement Vercel qu'une à deux minutes après la fusion : une preuve posée
 * dans cette fenêtre était rouverte à tort (Hubperso#743 et batchchef-#366, 29/10/2026). Pour une fusion récente, la lecture
 * est donc refaite après chaque délai de `delais` avant de conclure que le déploiement manque (un événement de plus, pas un
 * minuteur : la lecture se déclenche toujours sur la fermeture de l'issue). Une fusion plus ancienne n'attend jamais.
 */
export async function verifierDeploiement({ api, depot, sha, fusionLe, workflows = [], delais = [], pause = pauseReelle, maintenant = Date.now }) {
  let r = await lireDeploiement({ api, depot, sha, fusionLe, workflows });
  if (r.ok || Date.parse(fusionLe) + FENETRE_FUSION_MS < maintenant()) return r;
  for (const delai of delais) {
    await pause(delai);
    r = await lireDeploiement({ api, depot, sha, fusionLe, workflows });
    if (r.ok) return r;
  }
  return r;
}

async function lireDeploiement({ api, depot, sha, fusionLe, workflows }) {
  const plancher = new Date(Date.parse(fusionLe) - 60_000).toISOString();
  let essais = 0;
  const deps = await api(`/repos/${depot}/deployments?environment=Production&per_page=15`).catch(() => []);
  for (const d of deps) {
    if (d.created_at < plancher || essais >= 8) continue;
    essais += 1;
    const etats = await api(`/repos/${depot}/deployments/${d.id}/statuses?per_page=5`).catch(() => []);
    if (etats[0]?.state !== 'success') continue;
    if (await descend(api, depot, sha, d.sha).catch(() => false)) return { ok: true, detail: `déploiement ${d.id} sur ${d.sha.slice(0, 7)}` };
  }
  for (const wf of workflows) {
    const r = await api(`/repos/${depot}/actions/workflows/${wf}/runs?status=success&per_page=10`).catch(() => ({ workflow_runs: [] }));
    for (const run of r.workflow_runs ?? []) {
      if (run.created_at < plancher || essais >= 14) continue;
      essais += 1;
      if (!(await descend(api, depot, sha, run.head_sha).catch(() => false))) continue;
      // Une exécution « réussie » peut n'avoir déployé personne (job ignoré : leçon FinanceAI, 27 jours de serveur
      // non déployé sous une coche verte). Il faut un JOB de déploiement réussi.
      const jobs = await api(`/repos/${depot}/actions/runs/${run.id}/jobs?per_page=30`).catch(() => ({ jobs: [] }));
      if ((jobs.jobs ?? []).some((j) => /d[ée]ploy|d[ée]ploi/i.test(j.name) && j.conclusion === 'success')) {
        return { ok: true, detail: `workflow ${wf}, exécution ${run.id} sur ${run.head_sha.slice(0, 7)}` };
      }
    }
  }
  return { ok: false, detail: 'aucun déploiement « Production » réussi depuis la fusion' };
}

/**
 * Traite la fermeture de l'issue `numero` du dépôt `depot`. Rend { statut, motifs } où statut vaut :
 * `acceptee` (fermeture justifiée), `abandon` (abandon justifié), `rouverte` (fermeture sans preuve : rouverte),
 * `ignoree` (pas une tâche, ou déjà rouverte).
 */
export async function traiter({ api, depot, numero, config = {} }) {
  const issue = await api(`/repos/${depot}/issues/${numero}`);
  if (issue.state !== 'closed') return { statut: 'ignoree', motifs: ['l’issue n’est pas fermée'] };
  const etiquettes = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
  if (!etiquettes.includes(LABEL_TACHE)) return { statut: 'ignoree', motifs: [`pas de ${LABEL_TACHE}`] };

  const raison = issue.state_reason ?? 'completed';
  if (etiquettes.includes(LABEL_ESSAI) && raison === 'not_planned') return { statut: 'ignoree', motifs: ['issue d’essai fermée sans suite'] };
  const commentaires = await pages(api, `/repos/${depot}/issues/${numero}/comments`);

  let pr = null;
  let fichiers = [];
  let deploiement = { requis: false, ok: null, detail: '' };
  if (raison === 'completed') {
    const c = trouverPreuve(commentaires);
    const cite = c ? lireCitation(c.body) : null;
    if (cite?.pr) {
      const cible = cite.pr.depot ? `MoKarade/${cite.pr.depot}` : depot;
      pr = await api(`/repos/${cible}/pulls/${cite.pr.numero}`).catch(() => null);
      if (!pr && cible !== depot) pr = { illisible: true };
      if (pr?.merged) {
        fichiers = (await pages(api, `/repos/${cible}/pulls/${cite.pr.numero}/files`).catch(() => [])).map((f) => f.filename);
        pr = { merged: true, merged_at: pr.merged_at, merge_commit_sha: pr.merge_commit_sha, head_sha: pr.head?.sha };
        if (config.deploiement !== 'aucun' && servi(fichiers)) {
          const d = await verifierDeploiement({ api, depot: cible, sha: pr.merge_commit_sha, fusionLe: pr.merged_at, workflows: config.workflows ?? [], delais: config.delaisDeploiement ?? DELAIS_DEPLOIEMENT, pause: config.pause, maintenant: config.maintenant });
          deploiement = { requis: true, ...d };
        }
      } else if (pr && !pr.illisible) pr = { merged: false };
    }
  }

  const verdict = evaluer({ raison, commentaires, pr, fichiers, deploiement });
  if (verdict.ok) {
    for (const nom of LABELS_A_RETIRER) {
      if (etiquettes.includes(nom)) await api(`/repos/${depot}/issues/${numero}/labels/${encodeURIComponent(nom)}`, { method: 'DELETE' }).catch(() => {});
    }
    return { statut: verdict.type === 'abandon' ? 'abandon' : 'acceptee', motifs: [] };
  }
  await api(`/repos/${depot}/issues/${numero}`, { method: 'PATCH', body: { state: 'open' } });
  await api(`/repos/${depot}/issues/${numero}/labels`, { method: 'POST', body: { labels: [LABEL_MANQUE] } });
  await api(`/repos/${depot}/issues/${numero}/comments`, { method: 'POST', body: { body: corpsReouverture(verdict.motifs, raison) } });
  return { statut: 'rouverte', motifs: verdict.motifs };
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
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY || !Number.isInteger(numero)) throw new Error('GITHUB_TOKEN, GITHUB_REPOSITORY et ISSUE_NUMBER sont requis');
  const config = {
    deploiement: env.PREUVE_DEPLOIEMENT === 'aucun' ? 'aucun' : 'vercel',
    workflows: (env.PREUVE_WORKFLOWS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  };
  const r = await traiter({ api: apiReelle(env.GITHUB_TOKEN), depot: env.GITHUB_REPOSITORY, numero, config });
  const ligne = `Garde-fou de preuve — ${env.GITHUB_REPOSITORY}#${numero} : ${r.statut}${r.motifs.length ? ` (${r.motifs.join(' ; ')})` : ''}`;
  console.log(ligne);
  if (r.statut === 'rouverte') console.log(`::warning title=Tâche rouverte::${ligne}`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `statut=${r.statut}\n`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${ligne}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((e) => {
    console.log(`::error title=Garde-fou de preuve::${e.message}`);
    process.exit(1);
  });
}
