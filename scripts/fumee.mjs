// Test de fumée de production, appelé par .github/workflows/fumee.yml (workflow commun aux dix dépôts).
// Aucune dépendance : Node 24 et son `fetch`. La logique est ici (testable, `node --test scripts/`),
// le workflow ne fait que l'appeler.
//
// Quatre contrôles sur l'app déployée :
//   sante            GET <santé>   → 200 et JSON { ok: true } (un 200 avec ok:false est une PANNE).
//   summary-ferme    GET <summary> SANS jeton → 401 ou 503, jamais 200 (échec fermé).
//   summary          GET <summary> AVEC x-hub-token → 200, no-store, JSON de forme valide.
//   connexion        GET <connexion> sans suivre la redirection → 200, ou 3xx avec Location.
// Chaque contrôle a N essais espacés ; un seul succès suffit (une panne passagère n'est pas une panne).
//
// Sortie : jamais le corps d'une réponse, jamais le jeton, jamais une valeur lue chez l'app : seulement
// le nom du contrôle, un code HTTP et une cause fixe. C'est un journal public.
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const STATUTS = new Set(['ok', 'degraded', 'error', 'building']);

/** Forme minimale d'un summary du contrat hub (la validation complète Zod vit dans le hub). */
export function formeSummary(corps) {
  if (corps === null || typeof corps !== 'object' || Array.isArray(corps)) return 'le corps n’est pas un objet';
  if (!Number.isInteger(corps.contractVersion) || corps.contractVersion < 1) return 'contractVersion absent ou invalide';
  if (!STATUTS.has(corps.status)) return 'status hors de ok/degraded/error/building';
  if (typeof corps.generatedAt !== 'string' || Number.isNaN(Date.parse(corps.generatedAt))) return 'generatedAt absent ou invalide';
  if (!corps.app || typeof corps.app.id !== 'string' || !/^[a-z0-9-]+$/.test(corps.app.id)) return 'app.id absent ou invalide';
  if ('appId' in corps) return 'appId présent dans le corps (interdit : le hub identifie l’app par son jeton)';
  return null;
}

const jsonDe = async (reponse) => {
  try {
    return await reponse.json();
  } catch {
    return undefined;
  }
};

/** Un contrôle = une fonction qui rend null (vert) ou une cause courte (rouge). */
export function controles({ base, sante, summary, connexion, jeton, appel }) {
  const url = (chemin) => new URL(chemin, base).toString();
  const liste = [];

  liste.push({
    nom: 'sante',
    async verifier() {
      const r = await appel(url(sante));
      if (r.status !== 200) {
        // Les apps disent la cause d'une panne dans `{ ok:false, cause }` ; on ne garde qu'un mot court (journal public).
        const cause = (await jsonDe(r))?.cause;
        return typeof cause === 'string' && /^[a-z-]{1,20}$/.test(cause) ? `HTTP ${r.status} (${cause})` : `HTTP ${r.status}`;
      }
      const corps = await jsonDe(r);
      if (corps?.ok !== true) return 'ok:true absent de la réponse';
      return null;
    },
  });

  if (summary) {
    liste.push({
      nom: 'summary-ferme',
      async verifier() {
        const r = await appel(url(summary));
        if (r.status === 200) return 'HTTP 200 sans jeton (la route doit refuser)';
        if (r.status !== 401 && r.status !== 503) return `HTTP ${r.status} au lieu de 401/503`;
        return null;
      },
    });
    liste.push({
      nom: 'summary',
      async verifier() {
        if (!jeton) return 'jeton du hub absent (secret HUB_TOKEN non transmis)';
        const r = await appel(url(summary), { headers: { 'x-hub-token': jeton } });
        if (r.status !== 200) return `HTTP ${r.status}`;
        if (!/no-store/i.test(r.headers.get('cache-control') ?? '')) return 'Cache-Control sans no-store';
        const corps = await jsonDe(r);
        if (corps === undefined) return 'la réponse n’est pas du JSON';
        return formeSummary(corps);
      },
    });
  }

  liste.push({
    nom: 'connexion',
    async verifier() {
      const r = await appel(url(connexion), { redirect: 'manual' });
      if (r.status === 200) return null;
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) return null;
      return `HTTP ${r.status}`;
    },
  });

  return liste;
}

const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Lance un contrôle jusqu'à `essais` fois ; rend { nom, ok, cause, essais }. */
export async function lancer(controle, { essais, delaiMs, timeoutMs }) {
  let cause = 'aucun essai';
  for (let i = 1; i <= essais; i += 1) {
    try {
      cause = await controle.verifier();
    } catch (err) {
      // Cause fixe : le message brut d'une erreur réseau peut contenir l'hôte ou un détail interne.
      cause = err?.name === 'TimeoutError' ? `délai de ${timeoutMs} ms dépassé` : 'connexion impossible';
    }
    if (cause === null) return { nom: controle.nom, ok: true, cause: null, essais: i };
    if (i < essais) await dormir(delaiMs);
  }
  return { nom: controle.nom, ok: false, cause, essais };
}

export function tableau(resultats, base) {
  const lignes = resultats.map(
    (r) => `| ${r.nom} | ${r.ok ? 'vert' : 'ROUGE'} | ${r.ok ? '' : r.cause} | ${r.essais} |`,
  );
  return ['### Test de fumée', '', `Cible : ${base}`, '', '| Contrôle | État | Cause | Essais |', '|---|---|---|---|', ...lignes, ''].join('\n');
}

export async function fumee(config) {
  const { essais, delaiMs, timeoutMs } = config;
  const appel = (u, init = {}) => fetch(u, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const liste = controles({ ...config, appel });
  const resultats = [];
  for (const c of liste) resultats.push(await lancer(c, { essais, delaiMs, timeoutMs }));
  return resultats;
}

async function main() {
  const env = process.env;
  const base = env.FUMEE_BASE;
  if (!base || !/^https:\/\//.test(base)) {
    console.error('PANNE configuration — FUMEE_BASE absent ou non https');
    process.exit(2);
  }
  const config = {
    base,
    sante: env.FUMEE_SANTE || '/api/sante',
    summary: env.FUMEE_SUMMARY ?? '',
    connexion: env.FUMEE_CONNEXION || '/login',
    jeton: env.HUB_TOKEN || '',
    essais: Number(env.FUMEE_ESSAIS || 3),
    delaiMs: Number(env.FUMEE_DELAI_MS || 10_000),
    timeoutMs: Number(env.FUMEE_TIMEOUT_MS || 10_000),
  };
  const resultats = await fumee(config);
  const texte = tableau(resultats, base);
  console.log(texte);
  for (const r of resultats.filter((x) => !x.ok)) console.log(`::error title=Fumée::PANNE ${r.nom} — ${r.cause}`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${texte}\n`);
  process.exit(resultats.every((r) => r.ok) ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
