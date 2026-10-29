#!/usr/bin/env node
// Commentaire d'impact du graphe de code sur chaque PR (tâche MoKarade/.github#842, mission #839, demande de Marc 29/10/2026).
//
// Pour chaque fichier de code modifié par la PR (12 au plus), le workflow commun `impact-pr.yml` lance
// `scripts/graphe.sh affected <fichier> --depth 2` ; ce script lit les sorties, compte les fichiers qui en dépendent (dont les tests)
// et pose UN commentaire, mis à jour sur place (marqueur `<!-- impact-graphe -->`). Rien à dire (aucun fichier de code modifié ou aucun
// dépendant) : pas de commentaire, et celui d'une passe précédente est retiré. Aucun jeton de LLM, aucun réseau hors l'API GitHub.
//
// Fonctions pures d'un côté (`choisirFichiers`, `lireAffected`, `construireCommentaire`, `echapper`), I/O de l'autre (`poster`, avec `api`
// injecté : les tests n'ont besoin ni de réseau ni de jeton). Les chemins viennent du dépôt : ils sont des DONNÉES, écrits dans un
// segment de code, sans retour à la ligne ni accent grave. Ne fait jamais échouer le job : un avertissement dit ce qui n'a pas marché.
//
// Usage :  impact-pr.mjs choisir <modifies.txt>                 (écrit les fichiers à interroger, un par ligne)
//          impact-pr.mjs commenter <modifies.txt> <dossier>     (lit <dossier>/<n>.txt, la sortie d'affected du n-ième fichier choisi)
//          env du second : GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER (sans eux, le commentaire s'affiche seulement)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MARQUEUR = '<!-- impact-graphe -->';
export const MAX_FICHIERS = 12;
export const MAX_DEPENDANTS = 8;
const CODE = /\.(?:[cm]?[jt]sx?|py|gs|sh|sql)$/;
const TEST = /(?:\.(?:test|spec)\.[^/]+$|(?:^|\/)(?:tests?|__tests__)\/)/;
const DOC = /\.(?:md|mdx|txt|json|ya?ml)$/;

export const estCode = (chemin) => CODE.test(chemin);
export const estTest = (chemin) => TEST.test(chemin);

// Les fichiers à interroger : du code, les tests en dernier (ils n'ont presque jamais de dépendants), 12 au plus ; `reste` = ceux qui ne tiennent pas.
export function choisirFichiers(modifies) {
  const code = [...new Set(modifies.map((f) => String(f).trim()).filter((f) => f && estCode(f)))];
  const ordonnes = [...code.filter((f) => !estTest(f)), ...code.filter(estTest)];
  return { choisis: ordonnes.slice(0, MAX_FICHIERS), reste: Math.max(0, ordonnes.length - MAX_FICHIERS) };
}

// Un chemin écrit dans un segment de code : sans retour à la ligne, sans accent grave, borné.
export function echapper(chemin) {
  const propre = String(chemin).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/`/g, "'").trim().slice(0, 200);
  return `\`${propre}\``;
}

// La sortie de `graphify affected` : « - <nom> [relation] chemin:Lnn ». On garde les chemins, sans le fichier modifié lui-même ni les docs.
export function lireAffected(texte, fichier) {
  const vus = new Set();
  const dependants = [];
  for (const ligne of String(texte ?? '').split('\n')) {
    const m = /^- .*\[[a-z_]+\]\s+(\S.*?):L\d+\s*$/.exec(ligne);
    if (!m) continue;
    const chemin = m[1].trim();
    if (chemin === fichier || vus.has(chemin) || DOC.test(chemin)) continue;
    vus.add(chemin);
    dependants.push(chemin);
  }
  return { dependants, tests: dependants.filter(estTest).length };
}

export function construireCommentaire({ modifies, sorties }) {
  const { choisis, reste } = choisirFichiers(modifies);
  const lignes = [];
  choisis.forEach((fichier, i) => {
    const { dependants, tests } = lireAffected(sorties[i], fichier);
    if (!dependants.length) return;
    const nb = dependants.length;
    lignes.push(`- ${echapper(fichier)} : **${nb} fichier${nb > 1 ? 's' : ''}** en dépendent, dont ${tests} test${tests > 1 ? 's' : ''}`);
    const premiers = dependants.slice(0, MAX_DEPENDANTS).map(echapper).join(', ');
    lignes.push(`  - ${premiers}${nb > MAX_DEPENDANTS ? ` et ${nb - MAX_DEPENDANTS} autres` : ''}`);
  });
  if (!lignes.length) return null;
  if (reste > 0) lignes.push(`- et ${reste} autres fichiers de code modifiés, non interrogés (12 au plus)`);
  return [
    MARQUEUR,
    '### Impact du graphe de code',
    '',
    'Qui dépend des fichiers de code que cette PR modifie (`scripts/graphe.sh affected --depth 2`, sans jeton ni IA). Indicatif : un appel dynamique peut manquer ; relire les tests concernés.',
    '',
    ...lignes,
    '',
    '---',
    '_Généré par le workflow commun `impact-pr` de MoKarade/.github._',
  ].join('\n');
}

// Pose, met à jour ou retire le commentaire marqué. Retourne l'action faite : 'cree' | 'mis-a-jour' | 'retire' | 'rien'.
export async function poster({ api, depot, pr, corps }) {
  const existants = [];
  for (let page = 1; page <= 5; page++) {
    const lot = await api('GET', `/repos/${depot}/issues/${pr}/comments?per_page=100&page=${page}`);
    if (!Array.isArray(lot)) break;
    existants.push(...lot);
    if (lot.length < 100) break;
  }
  const ancien = existants.find((c) => c.user?.type === 'Bot' && typeof c.body === 'string' && c.body.startsWith(MARQUEUR));
  if (corps == null) {
    if (!ancien) return 'rien';
    await api('DELETE', `/repos/${depot}/issues/comments/${ancien.id}`);
    return 'retire';
  }
  if (ancien) {
    if (ancien.body === corps) return 'rien';
    await api('PATCH', `/repos/${depot}/issues/comments/${ancien.id}`, { body: corps });
    return 'mis-a-jour';
  }
  await api('POST', `/repos/${depot}/issues/${pr}/comments`, { body: corps });
  return 'cree';
}

function apiGithub(jeton) {
  return async function api(methode, chemin, corps) {
    const reponse = await fetch(`${process.env.GITHUB_API_URL || 'https://api.github.com'}${chemin}`, {
      method: methode,
      headers: { authorization: `Bearer ${jeton}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'x-github-api-version': '2022-11-28' },
      body: corps === undefined ? undefined : JSON.stringify(corps),
    });
    if (!reponse.ok) throw new Error(`${methode} ${chemin} : HTTP ${reponse.status}`);
    return reponse.status === 204 ? null : reponse.json();
  };
}

const lireLignes = (chemin) => readFileSync(chemin, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);

async function main() {
  const [commande, fichierModifies, dossier] = process.argv.slice(2);
  if (commande === 'choisir' && fichierModifies) {
    console.log(choisirFichiers(lireLignes(fichierModifies)).choisis.join('\n'));
    return;
  }
  if (commande !== 'commenter' || !fichierModifies || !dossier) {
    console.error('Usage : impact-pr.mjs choisir <modifies.txt> | commenter <modifies.txt> <dossier>');
    process.exit(2);
  }
  const modifies = lireLignes(fichierModifies);
  const { choisis } = choisirFichiers(modifies);
  const sorties = choisis.map((_, i) => {
    try {
      return readFileSync(join(dossier, `${i + 1}.txt`), 'utf8');
    } catch {
      return '';
    }
  });
  const corps = construireCommentaire({ modifies, sorties });
  const { GITHUB_TOKEN: jeton, GITHUB_REPOSITORY: depot, PR_NUMBER: pr } = process.env;
  if (!jeton || !depot || !pr) {
    console.log(corps ?? 'Aucun impact à signaler.');
    return;
  }
  try {
    console.log(`Commentaire d'impact : ${await poster({ api: apiGithub(jeton), depot, pr, corps })}`);
  } catch (e) {
    console.log(`::warning title=Impact du graphe::commentaire non posé : ${String(e.message).slice(0, 200)}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
