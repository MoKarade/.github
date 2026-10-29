#!/usr/bin/env node
// Écoute de la boîte « preuve PC » (tâche MoKarade/.github#808, choix « A » de Marc du 29/10/2026 00:40Z).
//
// La session du PC n'a pas d'abonnement aux PR (`subscribe_pr_activity`) : elle lance ce script sous l'outil Monitor, qui la réveille à chaque ligne imprimée.
// Le script lit les commentaires de la PR boîte PC (app-template#211) avec un ETag : une réponse 304 ne compte pas dans le quota REST. Il n'écrit rien sur GitHub.
// Une ligne par NOUVELLE demande : « RELEVÉ PC : <dépôt>#<n> (demandé il y a <s> s) ». Le PC lit alors l'issue, fait le relevé dans Chrome, puis écrit
// `**Relevé PC** — lu le AAAA-MM-JJ HH:MM (Québec) : …` sur l'issue (docs/cycle-de-vie-tache.md §10 quinquies).
//
// Usage : GH_TOKEN=… node scripts/ecoute-boite-pc.mjs [--etat <fichier>] [--pause <secondes>] [--une-fois]
//   --etat   fichier JSON des demandes déjà annoncées (redémarrage sans rejouer ni perdre) ; sans lui, la mémoire seule.
//   --pause  secondes entre deux lectures (30 par défaut, 10 au plus bas).
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const BOITE_PC_DEPOT = 'MoKarade/app-template';
export const BOITE_PC_NUMERO = 211;
export const PAUSE_DEFAUT_S = 30;
export const PAUSE_MIN_S = 10;
// Le motif posé par le Réacteur (scripts/reveil-reacteur.mjs) : « RÉACTEUR : relevé PC demandé sur <dépôt>#<n> ». Rien d'autre ne réveille le PC.
const MOTIF = /^RÉACTEUR : relevé PC demandé sur ([A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*)#(\d{1,6})\s*$/;

/**
 * Les demandes lisibles dans les commentaires de la boîte : [{ id, depot, n, date }]. Seul github-actions[bot] compte : un autre auteur ne réveille jamais le PC.
 * @param commentaires réponse de GET /repos/…/issues/<boîte>/comments
 */
export function lireDemandes(commentaires) {
  const sortie = [];
  for (const c of Array.isArray(commentaires) ? commentaires : []) {
    if (c?.user?.login !== 'github-actions[bot]') continue;
    const m = MOTIF.exec(String(c.body ?? ''));
    if (!m) continue;
    sortie.push({ id: c.id, depot: m[1], n: Number(m[2]), date: c.created_at ?? '' });
  }
  return sortie;
}

/** Les demandes pas encore annoncées, dans l'ordre ; `vues` est l'ensemble des identifiants déjà imprimés. */
export function nouvelles(demandes, vues) {
  return demandes.filter((d) => !vues.has(d.id));
}

export function ligne(demande, maintenant = new Date()) {
  const ecart = Math.max(0, Math.round((maintenant.getTime() - Date.parse(demande.date)) / 1000));
  return `RELEVÉ PC : ${demande.depot}#${demande.n} (demandé il y a ${Number.isFinite(ecart) ? ecart : '?'} s)`;
}

async function lire({ jeton, etag }) {
  const reponse = await fetch(`https://api.github.com/repos/${BOITE_PC_DEPOT}/issues/${BOITE_PC_NUMERO}/comments?per_page=100&sort=created&direction=desc`, {
    headers: {
      authorization: `Bearer ${jeton}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'ecoute-boite-pc',
      ...(etag ? { 'if-none-match': etag } : {}),
    },
  });
  if (reponse.status === 304) return { etag, commentaires: null };
  if (!reponse.ok) throw new Error(`HTTP ${reponse.status}`);
  return { etag: reponse.headers.get('etag') ?? etag, commentaires: await reponse.json() };
}

function lireEtat(fichier) {
  if (!fichier) return new Set();
  try {
    return new Set(JSON.parse(readFileSync(fichier, 'utf8')));
  } catch {
    return new Set();
  }
}

async function boucle({ jeton, fichier, pauseS, uneFois }) {
  const vues = lireEtat(fichier);
  let etag = '';
  for (;;) {
    try {
      const lu = await lire({ jeton, etag });
      etag = lu.etag;
      if (lu.commentaires) {
        for (const d of nouvelles(lireDemandes(lu.commentaires).reverse(), vues)) {
          console.log(ligne(d));
          vues.add(d.id);
        }
        if (fichier) writeFileSync(fichier, JSON.stringify([...vues]));
      }
    } catch (e) {
      // Une lecture ratée ne s'annonce pas comme une demande : un avertissement sur la sortie d'erreur, et on recommence.
      console.error(`ecoute-boite-pc : lecture ratée (${e.message})`);
    }
    if (uneFois) return;
    await new Promise((fin) => setTimeout(fin, pauseS * 1000));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = (nom) => {
    const i = process.argv.indexOf(nom);
    return i >= 0 ? process.argv[i + 1] : '';
  };
  const jeton = process.env.GH_TOKEN ?? '';
  if (!jeton) {
    console.error('usage : GH_TOKEN=… node scripts/ecoute-boite-pc.mjs [--etat <fichier>] [--pause <secondes>] [--une-fois]');
    process.exit(2);
  }
  const pauseS = Math.max(PAUSE_MIN_S, Number(arg('--pause')) || PAUSE_DEFAUT_S);
  await boucle({ jeton, fichier: arg('--etat'), pauseS, uneFois: process.argv.includes('--une-fois') });
}
