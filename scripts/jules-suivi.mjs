#!/usr/bin/env node
// Suivi des PR de Jules par le PC (tâche MoKarade/.github#289, demande de Marc du 19/10/2026 « go full auto »).
// Avant : un fil nettoyait à la main le corps de chaque PR de Jules, relisait le diff, posait « Acceptée », retirait les
// étiquettes et fermait. Maintenant, sans IA, à chaque tour du PC (`filet-pc.mjs`, `tourJulesSuivi`) :
//   1. PR OUVERTE d'une tâche `jules` : on retire du corps `Fixes|Closes|Resolves #n` (la fusion ne doit pas fermer la tâche sans
//      preuve) et on pose `Tâche : #n` si elle manque ; si un fichier de la PR sort de « Fichiers permis », on pose `hold` et on
//      réveille le Coordinateur (une fois par 24 h et par PR). On ne lève jamais un `hold`.
//   2. PR FUSIONNÉE d'une tâche `jules` encore ouverte (ou rouverte par le garde-fou après un `Fixes`) : si TOUS ses fichiers sont des tests,
//      tous dans « Fichiers permis », et les contrôles de sa tête verts, on pose « **Acceptée** — … » au format du garde-fou
//      (`scripts/preuve.mjs`), on retire les étiquettes de travail et on ferme. Une PR qui touche autre chose que des tests n'est pas
//      acceptée ici : le fil du dépôt la reprend (le déploiement READY du code servi est une suite).
// Fonctions pures d'un côté, I/O de l'autre (`gh` injecté).
import { fichiersPermis } from './jules-auto.mjs';

export const ETIQUETTES_A_RETIRER = ['jules', 'faisable-jules', 'en-cours', 'preuve-manquante', 'preuve-attendue'];
export const TESTS = /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const FERMANT = /^[ \t]*(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)[ \t]*:?[ \t]*#\d+[^\n]*\n?/gim;
const CITATION = /(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?|t[âa]che)[ \t]*:?[ \t]*#(\d+)/gi;

/** Les numéros de tâche qu'une PR cite (corps et titre) : `Fixes #n`, `Closes #n`, `Resolves #n`, `Tâche : #n`. */
export function tachesCitees(pr) {
  const texte = `${pr.title ?? ''}\n${pr.body ?? ''}`;
  return [...new Set([...texte.matchAll(CITATION)].map((m) => Number(m[1])))];
}

/** Tous les fichiers sont des tests (et il y en a au moins un). */
export const testsSeuls = (fichiers) => fichiers.length > 0 && fichiers.every((f) => TESTS.test(f));

/** Fichiers de la PR qui ne sont pas dans « Fichiers permis » de la tâche (chemins exacts). */
export function horsPermis(fichiers, corpsTache) {
  const permis = new Set(fichiersPermis(corpsTache));
  return fichiers.filter((f) => !permis.has(f));
}

/** Le corps d'une PR ouverte de Jules, nettoyé : plus de ligne fermante, une ligne `Tâche : #n`. Rend le même texte s'il n'y a rien à faire. */
export function corpsNettoye(corps, n) {
  let c = String(corps ?? '').replace(FERMANT, '');
  c = c.replace(/\s+$/, '');
  if (!new RegExp(`T[âa]che\\s*:\\s*#${n}\\b`, 'i').test(c)) c = `${c}${c ? '\n\n' : ''}Tâche : #${n}`;
  return c === String(corps ?? '').replace(/\s+$/, '') ? String(corps ?? '') : `${c}\n`;
}

/** Les contrôles de la tête de la PR sont-ils tous verts ? (Mergify mis à part : sa file se termine après la fusion.) */
export function controlesVerts(runs) {
  const utiles = (runs ?? []).filter((r) => !/mergify/i.test(r.name ?? ''));
  const pasVerts = utiles.filter((r) => r.status !== 'completed' || !['success', 'neutral', 'skipped'].includes(r.conclusion));
  return { ok: utiles.length > 0 && pasVerts.length === 0, total: utiles.length, pasVerts: pasVerts.map((r) => r.name) };
}

/**
 * La PR fusionnée prouve-t-elle sa tâche seule ? Rend { ok, raisons } ; `raisons` dit ce qui empêche l'acceptation automatique.
 * @param tache { n, body } ; @param pr { merged, merge_commit_sha } ; @param fichiers noms ; @param runs check-runs de la tête
 */
export function evaluerFusion({ tache, pr, fichiers, runs }) {
  const raisons = [];
  if (!pr?.merged || !pr.merge_commit_sha) raisons.push('PR non fusionnée');
  if (!testsSeuls(fichiers)) raisons.push(`la PR ne touche pas que des tests (${fichiers.filter((f) => !TESTS.test(f)).slice(0, 3).join(', ') || 'aucun fichier'})`);
  const hors = horsPermis(fichiers, tache.body ?? '');
  if (hors.length) raisons.push(`fichier(s) hors « Fichiers permis » : ${hors.slice(0, 3).join(', ')}`);
  const c = controlesVerts(runs);
  if (!c.ok) raisons.push(c.total === 0 ? 'aucun contrôle lu sur la tête de la PR' : `contrôle(s) pas verts : ${c.pasVerts.slice(0, 3).join(', ')}`);
  return { ok: raisons.length === 0, raisons, controles: c.total };
}

const sha7 = (s) => String(s ?? '').slice(0, 7);

/** Le commentaire de preuve, au format que le garde-fou accepte (PR fusionnée + empreinte, « sans déploiement : », « preuve : » ≥ 40 car.). */
export function commentaireAcceptee({ pr, fichiers, controles, date }) {
  const liste = fichiers.slice(0, 5).join(', ') + (fichiers.length > 5 ? ` et ${fichiers.length - 5} autre(s)` : '');
  return `**Acceptée** — PR #${pr.number} fusionnée (${sha7(pr.merge_commit_sha)}), sans déploiement : tests seuls, aucun fichier servi, preuve : lu le ${date} sur la PR #${pr.number} : ${fichiers.length} fichier(s) (${liste}), tous des tests et tous dans « Fichiers permis » de la tâche ; ${controles} contrôles de la tête ${sha7(pr.head?.sha)} tous verts ; fusion le ${pr.merged_at}.\n\n_Posé par le tour du PC (scripts/jules-suivi.mjs, tâche .github#289), sans relecture humaine : la preuve est mécanique._\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_`;
}

const noms = (labels) => (labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));

/** Une PR de la liste GitHub citant la tâche n : la plus récente fusionnée, ou la plus récente ouverte. */
export function prDeLaTache(n, prs) {
  const citant = prs.filter((p) => tachesCitees(p).includes(n));
  const fusionnee = citant.filter((p) => p.merged_at).sort((a, b) => (a.merged_at < b.merged_at ? 1 : -1))[0];
  const ouverte = citant.filter((p) => p.state === 'open').sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
  return { fusionnee: fusionnee ?? null, ouverte: ouverte ?? null };
}

const FENETRE_SIGNAL_H = 24;
const heuresEntre = (depuis, maintenant) => (maintenant.getTime() - Date.parse(depuis)) / 3_600_000;

/**
 * Un tour pour un dépôt : applique ce qui est mécanique, rend ce qui reste à dire.
 * @param gh (methode, chemin, corps) -> JSON ; @returns { acceptees, nettoyees, holds, signaux: [{ref, raison}], vu }
 */
export function suivreDepot({ depot, gh, etat = {}, maintenant = new Date(), aBlanc = false }) {
  const court = depot.replace('MoKarade/', '');
  const sortie = { acceptees: [], nettoyees: [], holds: [], signaux: [], vu: 0 };
  const taches = gh('GET', `repos/${depot}/issues?labels=jules&state=open&per_page=50`).filter((i) => !i.pull_request);
  if (taches.length === 0) return sortie;
  const prs = [...gh('GET', `repos/${depot}/pulls?state=open&per_page=50`), ...gh('GET', `repos/${depot}/pulls?state=closed&sort=updated&direction=desc&per_page=30`)];
  const dejaVue = new Set();
  const liste = prs.filter((p) => (dejaVue.has(p.number) ? false : dejaVue.add(p.number)));
  const date = maintenant.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  for (const t of taches) {
    if (!noms(t.labels).includes('niveau:tâche')) continue;
    sortie.vu += 1;
    const ref = `${court}#${t.number}`;
    const { fusionnee, ouverte } = prDeLaTache(t.number, liste);
    const signaler = (raison) => {
      const dernier = etat[ref]?.signale;
      if (dernier && heuresEntre(dernier, maintenant) < FENETRE_SIGNAL_H) return;
      sortie.signaux.push({ ref, raison });
    };
    if (fusionnee) {
      const fichiers = gh('GET', `repos/${depot}/pulls/${fusionnee.number}/files?per_page=100`).map((f) => f.filename);
      const runs = gh('GET', `repos/${depot}/commits/${fusionnee.head.sha}/check-runs?per_page=100`).check_runs ?? [];
      const e = evaluerFusion({ tache: { n: t.number, body: t.body }, pr: { merged: Boolean(fusionnee.merged_at), merge_commit_sha: fusionnee.merge_commit_sha }, fichiers, runs });
      if (e.ok) {
        if (!aBlanc) {
          gh('POST', `repos/${depot}/issues/${t.number}/comments`, { body: commentaireAcceptee({ pr: fusionnee, fichiers, controles: e.controles, date }) });
          for (const l of ETIQUETTES_A_RETIRER) if (noms(t.labels).includes(l)) gh('DELETE', `repos/${depot}/issues/${t.number}/labels/${encodeURIComponent(l)}`);
          gh('PATCH', `repos/${depot}/issues/${t.number}`, { state: 'closed', state_reason: 'completed' });
        }
        sortie.acceptees.push(ref);
      } else {
        signaler(`PR #${fusionnee.number} fusionnée, non acceptée seule : ${e.raisons[0]}`);
      }
      continue;
    }
    if (ouverte) {
      const propre = corpsNettoye(ouverte.body, t.number);
      if (propre !== String(ouverte.body ?? '')) {
        if (!aBlanc) gh('PATCH', `repos/${depot}/pulls/${ouverte.number}`, { body: propre });
        sortie.nettoyees.push(`${court}#${ouverte.number}`);
      }
      const fichiers = gh('GET', `repos/${depot}/pulls/${ouverte.number}/files?per_page=100`).map((f) => f.filename);
      const hors = horsPermis(fichiers, t.body ?? '');
      if (hors.length && !noms(ouverte.labels).includes('hold')) {
        if (!aBlanc) gh('POST', `repos/${depot}/issues/${ouverte.number}/labels`, { 'labels[]': 'hold' });
        sortie.holds.push(`${court}#${ouverte.number}`);
        signaler(`PR #${ouverte.number} ouverte avec fichier(s) hors « Fichiers permis » (${hors.slice(0, 2).join(', ')}), hold posé`);
      }
    }
  }
  return sortie;
}
