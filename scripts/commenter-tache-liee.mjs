#!/usr/bin/env node
// Commentaire « tâche liée » sur les PR refusées (docs/cycle-de-vie-tache.md §8, mission MoKarade/.github#116).
//
// Le Garde-fou (scripts/garde-fou.mjs) dit déjà dans son journal pourquoi une PR est rouge, mais il ne peut pas le
// poser en commentaire : le jeton de ses workflows n'a pas `pull-requests: write` (HTTP 403), et le lui donner
// demande une PR de plus dans chacun des dix dépôts. Ce script est le seul endroit qui le fait pour les dix : il
// tourne ici, avec le jeton fin `RELECTURE_PAT` (Pull requests en lecture et écriture sur les dix dépôts), relit les
// PR ouvertes avec la MÊME règle que le Garde-fou (`controleTacheLiee`) et tient UN commentaire par PR, repéré par
// `<!-- garde-fou-tache -->` : posé quand la PR ne cite aucune tâche ouverte, mis à jour quand le texte change, passé
// à « levé » quand elle est corrigée. Il ne change jamais le verdict : le contrôle requis reste celui du Garde-fou.
//
// Fonctions pures d'un côté (`corpsDuCommentaire`), I/O de l'autre (`commenterDepot` avec `api` injecté, `main`).
import { pathToFileURL } from 'node:url';
import { MARQUEUR_TACHE, controleTacheLiee, rapportTacheLiee } from './tache-liee.mjs';

export const DEPOTS = ['.github', 'FinanceAI', 'JobAI', 'batchchef-', 'DriveAI', 'Hubperso', 'CarAI', 'MemoryAI', 'app-template', 'hub-contract'];
export const TEXTE_LEVE = 'Tâche liée : vert, le blocage est levé.';

/** Le plafond d'appels du jeton est atteint : insister ne sert à rien, le passage s'arrête et reprend au suivant. */
export class LimiteDebit extends Error {}

/** Mémorise les lectures d'issues d'un même passage : dix PR qui citent la même tâche ne coûtent qu'un appel. */
export function avecCache(api) {
  const vues = new Map();
  return async function apiCache(methode, chemin, corps) {
    if (methode !== 'GET' || !/\/issues\/\d+$/.test(chemin)) return api(methode, chemin, corps);
    if (!vues.has(chemin)) vues.set(chemin, api(methode, chemin, corps));
    return vues.get(chemin);
  };
}

/** Le corps du commentaire voulu pour ce résultat, ou null s'il n'y a rien à dire (PR en règle, pas de commentaire). */
export function corpsDuCommentaire(lien, ancien) {
  if (lien.ok && (lien.avertissements ?? []).length > 0) return `${MARQUEUR_TACHE}\n${rapportTacheLiee(lien)}`;
  if (lien.ok) return ancien ? `${MARQUEUR_TACHE}\n${TEXTE_LEVE}` : null;
  return `${MARQUEUR_TACHE}\n${rapportTacheLiee(lien)}`;
}

async function pages(api, chemin) {
  const sortie = [];
  for (let page = 1; page <= 20; page += 1) {
    const lot = (await api('GET', `${chemin}${chemin.includes('?') ? '&' : '?'}per_page=100&page=${page}`)) ?? [];
    sortie.push(...lot);
    if (lot.length < 100) break;
  }
  return sortie;
}

/**
 * Passe sur les PR ouvertes d'un dépôt. Rend { actions, erreurs } : une erreur sur une PR n'arrête pas les autres.
 * @param api (méthode, chemin, corps) -> JSON ou null (404) ; lève sur toute autre erreur
 */
export async function commenterDepot({ api, depot }) {
  const actions = [];
  const erreurs = [];
  const complet = `MoKarade/${depot}`;
  for (const pr of await pages(api, `/repos/${complet}/pulls?state=open`)) {
    try {
      const lien = await controleTacheLiee({ api, depot: complet, pr });
      if (lien.dispense) continue; // robot ou boîte du Réacteur : jamais de commentaire
      const commentaires = await pages(api, `/repos/${complet}/issues/${pr.number}/comments`);
      const ancien = commentaires.find((c) => c.body?.includes(MARQUEUR_TACHE));
      const corps = corpsDuCommentaire(lien, ancien);
      if (corps === null || ancien?.body === corps) continue;
      if (ancien) await api('PATCH', `/repos/${complet}/issues/comments/${ancien.id}`, { body: corps });
      else await api('POST', `/repos/${complet}/issues/${pr.number}/comments`, { body: corps });
      actions.push(`${depot}#${pr.number} : ${lien.ok && !(lien.avertissements ?? []).length ? 'levé' : ancien ? 'mis à jour' : 'posé'}`);
    } catch (erreur) {
      if (erreur instanceof LimiteDebit) throw erreur;
      erreurs.push(`${depot}#${pr.number} : ${erreur.message}`);
    }
  }
  return { actions, erreurs };
}

function apiReelle(jeton) {
  return async function api(methode, chemin, corps) {
    const r = await fetch(`https://api.github.com${chemin}`, {
      method: methode,
      headers: { Authorization: `Bearer ${jeton}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(corps ? { 'Content-Type': 'application/json' } : {}) },
      body: corps ? JSON.stringify(corps) : undefined,
    });
    if (r.status === 404) return null;
    if (!r.ok) {
      const texte = (await r.text()).slice(0, 200);
      if ((r.status === 403 || r.status === 429) && /rate limit/i.test(texte)) throw new LimiteDebit(`${methode} ${chemin} : plafond d'appels atteint`);
      throw new Error(`${methode} ${chemin} : HTTP ${r.status} ${texte}`);
    }
    return r.status === 204 ? null : r.json();
  };
}

async function main() {
  const jeton = process.env.GH_PAT;
  if (!jeton) { console.error('GH_PAT absent : rien à faire.'); process.exit(2); }
  const api = avecCache(apiReelle(jeton));
  const erreurs = [];
  for (const depot of DEPOTS) {
    try {
      const r = await commenterDepot({ api, depot });
      for (const a of r.actions) console.log(a);
      erreurs.push(...r.erreurs);
    } catch (erreur) {
      if (erreur instanceof LimiteDebit) {
        // Pas de rouge : le jeton est partagé et se vide pour d'autres raisons ; le passage suivant (10 min) reprend.
        console.log(`::warning::Commentaire tâche liée interrompu à ${depot} : ${erreur.message}. Reprise au prochain passage.`);
        return;
      }
      erreurs.push(`${depot} : ${erreur.message}`);
    }
  }
  if (erreurs.length) { for (const e of erreurs) console.error(`ERREUR ${e}`); process.exitCode = 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
