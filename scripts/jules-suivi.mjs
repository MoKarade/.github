#!/usr/bin/env node
// Suivi des PR de Jules par le PC (tâche MoKarade/.github#289, demande de Marc du 19/10/2026 « go full auto »).
// Avant : un fil nettoyait à la main le corps de chaque PR de Jules, relisait le diff, posait « Acceptée », retirait les
// étiquettes et fermait. Maintenant, sans IA, à chaque tour du PC (`filet-pc.mjs`, `tourJulesSuivi`) :
//   1. PR OUVERTE d'une tâche `jules` : on retire du corps `Fixes|Closes|Resolves #n` (la fusion ne doit pas fermer la tâche sans
//      preuve) et on pose `Tâche : #n` si elle manque ; si un fichier de la PR sort de « Fichiers permis », on pose `hold` et on
//      réveille le Coordinateur (une fois par 24 h et par PR). On ne lève jamais un `hold`.
//   2. PR FUSIONNÉE d'une tâche `jules` encore ouverte (ou rouverte par le garde-fou après un `Fixes`) : si tous ses fichiers sont dans
//      « Fichiers permis », les contrôles de sa tête verts, aucun outil MCP touché, et, SI elle change du code servi, un déploiement de
//      production réussi sur le commit fusionné (et, pour un écran, le commentaire de captures avant/après), on pose « **Acceptée** — … »
//      au format du garde-fou (`scripts/preuve.mjs`), on retire les étiquettes de travail et on ferme (suite de #289 : tâche #300, décisions de
//      Marc du 19/10/2026 19:56Z, « 3 ok 4 oui »). Déploiement ou captures pas encore là : on attend ; au-delà d'une heure, réveil.
// Fonctions pures d'un côté, I/O de l'autre (`gh` injecté).
import { fichiersPermis, FICHIER_ECRAN } from './jules-auto.mjs';
import { servi } from './preuve.mjs';
import { MARQUEUR as MARQUEUR_CAPTURES } from './captures.mjs';

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

/** Un outil MCP ajouté ou un fichier du serveur MCP touché : hors du full auto (décision de Marc, 19/10/2026 : « 4 oui »). */
export const MCP_CHEMIN = /(?:^|\/)(?:app\/api\/mcp\/|lib\/mcp\/)/;
export const MCP_AJOUT = /^\+.*registerTool/m;
export const toucheMcp = (fichiers, patches = []) => fichiers.some((f) => MCP_CHEMIN.test(f)) || patches.some((p) => MCP_AJOUT.test(String(p ?? '')));

/** La PR touche-t-elle un écran ? (mêmes fichiers que `evaluerJules` : css, tsx, jsx, components/). */
export const toucheEcran = (fichiers) => fichiers.some((f) => FICHIER_ECRAN.test(f));

const descend = (gh, depot, base, tete) => {
  if (base === tete) return true;
  const r = gh('GET', `repos/${depot}/compare/${base}...${tete}`);
  return r.status === 'ahead' || r.status === 'identical';
};

/**
 * Le commit fusionné est-il en production ? Cherche un déploiement « Production » réussi, créé après la fusion, sur ce commit ou sur un commit qui le contient
 * (même lecture que `verifierDeploiement` de preuve.mjs, en synchrone). Ne lève jamais : une lecture qui échoue rend { ok: false }.
 */
export function deploiementProduction({ depot, sha, fusionLe, gh }) {
  const plancher = new Date(Date.parse(fusionLe) - 60_000).toISOString();
  let deps;
  try { deps = gh('GET', `repos/${depot}/deployments?environment=Production&per_page=15`); } catch { return { ok: false, detail: 'déploiements illisibles' }; }
  if (!Array.isArray(deps)) return { ok: false, detail: 'aucun déploiement « Production »' };
  let essais = 0;
  for (const d of deps) {
    if (d.created_at < plancher || essais >= 8) continue;
    essais += 1;
    try {
      const etats = gh('GET', `repos/${depot}/deployments/${d.id}/statuses?per_page=5`);
      if (!Array.isArray(etats) || etats[0]?.state !== 'success') continue;
      if (descend(gh, depot, sha, d.sha)) return { ok: true, id: d.id, sha: d.sha, detail: `déploiement ${d.id} sur ${sha7(d.sha)}` };
    } catch { /* un déploiement illisible n'en prouve pas un autre */ }
  }
  return { ok: false, detail: 'aucun déploiement « Production » réussi depuis la fusion' };
}

/** Le commentaire de captures avant/après posé par captures.yml sur la PR, ou null. */
export function commentaireCaptures({ depot, numero, gh }) {
  try {
    const coms = gh('GET', `repos/${depot}/issues/${numero}/comments?per_page=100`);
    const c = (Array.isArray(coms) ? coms : []).find((x) => String(x.body ?? '').includes(MARQUEUR_CAPTURES));
    return c ? { url: c.html_url ?? '' } : null;
  } catch { return null; }
}

/**
 * La PR fusionnée prouve-t-elle sa tâche seule ? Rend { ok, attente, raisons, controles }.
 * `raisons` dit ce qui empêche l'acceptation automatique ; `attente` est vrai quand il ne manque QUE le déploiement ou les captures (ça viendra).
 * @param tache { n, body } ; @param pr { merged, merge_commit_sha } ; @param fichiers noms ; @param patches diffs ; @param runs check-runs de la tête
 * @param deploiement { ok } ou null (lu seulement si la PR change du code servi) ; @param captures { url } ou null (écrans)
 */
export function evaluerFusion({ tache, pr, fichiers, patches = [], runs, deploiement = null, captures = null }) {
  const bloquants = [];
  const attendre = [];
  if (!pr?.merged || !pr.merge_commit_sha) bloquants.push('PR non fusionnée');
  if (fichiers.length === 0) bloquants.push('aucun fichier');
  const hors = horsPermis(fichiers, tache.body ?? '');
  if (hors.length) bloquants.push(`fichier(s) hors « Fichiers permis » : ${hors.slice(0, 3).join(', ')}`);
  if (toucheMcp(fichiers, patches)) bloquants.push('la PR ajoute ou touche un outil MCP : hors du full auto');
  const c = controlesVerts(runs);
  if (!c.ok) bloquants.push(c.total === 0 ? 'aucun contrôle lu sur la tête de la PR' : `contrôle(s) pas verts : ${c.pasVerts.slice(0, 3).join(', ')}`);
  const sert = servi(fichiers);
  if (sert && !deploiement?.ok) attendre.push('déploiement de production pas encore réussi sur le commit fusionné');
  if (sert && toucheEcran(fichiers) && !captures) attendre.push('captures avant/après absentes de la PR');
  const raisons = [...bloquants, ...attendre];
  return { ok: raisons.length === 0, attente: bloquants.length === 0 && attendre.length > 0, raisons, controles: c.total, servi: sert };
}

const sha7 = (s) => String(s ?? '').slice(0, 7);

/** Le commentaire de preuve, au format que le garde-fou accepte (PR fusionnée + empreinte, « sans déploiement : » ou « déploiement READY (id) », « preuve : » ≥ 40 car.). */
export function commentaireAcceptee({ pr, fichiers, controles, date, deploiement = null, captures = null }) {
  const liste = fichiers.slice(0, 5).join(', ') + (fichiers.length > 5 ? ` et ${fichiers.length - 5} autre(s)` : '');
  const tests = fichiers.every((f) => TESTS.test(f));
  const lu = `lu le ${date} sur la PR #${pr.number} : ${fichiers.length} fichier(s) (${liste}), tous dans « Fichiers permis » de la tâche ; ${controles} contrôles de la tête ${sha7(pr.head?.sha)} tous verts ; fusion le ${pr.merged_at}`;
  const entete = deploiement?.ok
    ? `déploiement READY (${deploiement.id}), preuve : ${lu} ; déploiement de production ${deploiement.id} réussi sur ${sha7(deploiement.sha)}, qui contient le commit fusionné${captures ? `${captures.url ? ` ; captures avant/après : ${captures.url}` : ' ; captures avant/après présentes sur la PR'} (jointes à la PR, sans examen par une personne : accepté par Marc le 19/10/2026)` : ''}`
    : `sans déploiement : ${tests ? 'tests seuls' : 'docs, tests ou CI'}, aucun fichier servi, preuve : ${lu}`;
  return `**Acceptée** — PR #${pr.number} fusionnée (${sha7(pr.merge_commit_sha)}), ${entete}.\n\n_Posé par le tour du PC (scripts/jules-suivi.mjs, tâches .github#289 et #300), sans relecture humaine : la preuve est mécanique._\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_`;
}

const noms = (labels) => (labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));

/** Une PR de la liste GitHub citant la tâche n : la plus récente fusionnée, ou la plus récente ouverte. */
export function prDeLaTache(n, prs) {
  const citant = prs.filter((p) => tachesCitees(p).includes(n));
  const fusionnee = citant.filter((p) => p.merged_at).sort((a, b) => (a.merged_at < b.merged_at ? 1 : -1))[0];
  const ouverte = citant.filter((p) => p.state === 'open').sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
  return { fusionnee: fusionnee ?? null, ouverte: ouverte ?? null };
}

/**
 * Retire une étiquette. Déjà partie (le garde-fou de preuve les retire à la fermeture validée, en même temps que ce tour : 404 « Label does not exist ») = rien à faire.
 * Sans cette tolérance, le 21/10/2026 15:52Z, la tâche CarAI#50 acceptée seule faisait écrire « jules-suivi : ÉCHEC CarAI » dans etat.json et le tour sautait la fermeture.
 */
export function retirerEtiquette(gh, depot, numero, etiquette) {
  try { gh('DELETE', `repos/${depot}/issues/${numero}/labels/${encodeURIComponent(etiquette)}`); } catch (e) {
    if (!/\b404\b|Not Found|does not exist/i.test(`${e?.stderr ?? ''} ${e?.message ?? ''}`)) throw e;
  }
}

/** Étiquettes d'avancement qui n'ont plus de sens sur une tâche FERMÉE (le garde-fou de preuve retire les siennes à la fermeture validée ; une fermeture à la main ou par une PR les laisse). */
export const ETIQUETTES_FERMEES = ['en-cours', 'jules', 'faisable-jules', 'preuve-attendue'];

/**
 * Retire ETIQUETTES_FERMEES des tâches fermées récemment (30 dernières mises à jour du dépôt : un seul appel par dépôt).
 * Ne touche ni à l'état ni aux commentaires, jamais à `qui:marc`.
 * @returns string[] « depot#n:etiquette » (retirées, ou à retirer si `aBlanc`)
 */
export function menageFermees({ depot, gh, aBlanc = false }) {
  const court = depot.replace('MoKarade/', '');
  const fermees = gh('GET', `repos/${depot}/issues?state=closed&sort=updated&direction=desc&per_page=30`).filter((i) => !i.pull_request);
  const retirees = [];
  for (const i of fermees) {
    for (const l of noms(i.labels).filter((x) => ETIQUETTES_FERMEES.includes(x))) {
      if (!aBlanc) retirerEtiquette(gh, depot, i.number, l);
      retirees.push(`${court}#${i.number}:${l}`);
    }
  }
  return retirees;
}

const FENETRE_SIGNAL_H = 24;
/** Déploiement ou captures attendus : au-delà, réveil. */
export const ATTENTE_MAX_H = 1;
const heuresEntre = (depuis, maintenant) => (maintenant.getTime() - Date.parse(depuis)) / 3_600_000;

// Étiquette des PR de Jules (tâche MoKarade/.github#426, demande de Marc du 21/10/2026 18:00Z relayée par le fil Jules) : Jules ouvre ses PR sous l'identité
// de Marc, rien ne les distingue ; la page de suivi lit cette étiquette. Critère mesuré sur 1 483 PR (17 de Jules, aucune autre) : le corps porte
// `jules.google.com/task/`, ou le compte `google-labs-jules[bot]` a commenté la PR.
export const ETIQUETTE_PAR_JULES = 'par-jules';
export const COULEUR_PAR_JULES = '9b7be0';
export const PIED_JULES = 'jules.google.com/task/';
export const BOT_JULES = 'google-labs-jules[bot]';
export const COMMENTAIRES_MAX = 20; // PR ouvertes dont on lit les commentaires par dépôt et par tour

/** Le corps d'une PR porte-t-il le pied de page de Jules ? (Le commentaire du bot se lit à part, par `marquerParJules`.) */
export const piedDeJules = (corps) => String(corps ?? '').includes(PIED_JULES);

/**
 * Pose `par-jules` sur les PR de Jules d'un dépôt : les ouvertes et les trente dernières fermées. Le corps suffit pour toutes ; le commentaire du bot
 * n'est lu que pour une PR OUVERTE sans pied de page (une lecture par PR et par tour, au plus `COMMENTAIRES_MAX`). Une PR déjà étiquetée n'est pas relue.
 * L'étiquette est créée au premier besoin (le dépôt neuf n'en a pas). @returns {{ marquees: string[] }}
 */
export function marquerParJules({ depot, gh, aBlanc = false }) {
  const court = depot.replace('MoKarade/', '');
  const sortie = { marquees: [] };
  const ouvertes = gh('GET', `repos/${depot}/pulls?state=open&per_page=50`);
  const fermees = gh('GET', `repos/${depot}/pulls?state=closed&sort=updated&direction=desc&per_page=30`);
  const vues = new Set();
  let lectures = 0;
  let creee = false;
  for (const p of [...ouvertes, ...fermees]) {
    if (vues.has(p.number)) continue;
    vues.add(p.number);
    if (noms(p.labels).includes(ETIQUETTE_PAR_JULES)) continue;
    let jules = piedDeJules(p.body);
    if (!jules && p.state === 'open' && lectures < COMMENTAIRES_MAX) {
      lectures += 1;
      jules = (gh('GET', `repos/${depot}/issues/${p.number}/comments?per_page=100`) ?? []).some((c) => c.user?.login === BOT_JULES);
    }
    if (!jules) continue;
    if (!aBlanc) {
      if (!creee) {
        try { gh('POST', `repos/${depot}/labels`, { name: ETIQUETTE_PAR_JULES, color: COULEUR_PAR_JULES, description: 'PR ouverte par Jules' }); } catch { /* existe déjà (422) */ }
        creee = true;
      }
      gh('POST', `repos/${depot}/issues/${p.number}/labels`, { 'labels[]': ETIQUETTE_PAR_JULES });
    }
    sortie.marquees.push(`${court}#${p.number}`);
  }
  return sortie;
}

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
      const detail = gh('GET', `repos/${depot}/pulls/${fusionnee.number}/files?per_page=100`);
      const fichiers = detail.map((f) => f.filename);
      const runs = gh('GET', `repos/${depot}/commits/${fusionnee.head.sha}/check-runs?per_page=100`).check_runs ?? [];
      const sert = servi(fichiers);
      // Le déploiement et les captures ne se lisent que si la PR change du code servi (économie d'appels : un tour tous les 10 min).
      const deploiement = sert ? deploiementProduction({ depot, sha: fusionnee.merge_commit_sha, fusionLe: fusionnee.merged_at, gh }) : null;
      const captures = sert && toucheEcran(fichiers) ? commentaireCaptures({ depot, numero: fusionnee.number, gh }) : null;
      const e = evaluerFusion({ tache: { n: t.number, body: t.body }, pr: { merged: Boolean(fusionnee.merged_at), merge_commit_sha: fusionnee.merge_commit_sha }, fichiers, patches: detail.map((f) => f.patch), runs, deploiement, captures });
      if (e.ok) {
        if (!aBlanc) {
          gh('POST', `repos/${depot}/issues/${t.number}/comments`, { body: commentaireAcceptee({ pr: fusionnee, fichiers, controles: e.controles, date, deploiement, captures }) });
          for (const l of ETIQUETTES_A_RETIRER) if (noms(t.labels).includes(l)) retirerEtiquette(gh, depot, t.number, l);
          gh('PATCH', `repos/${depot}/issues/${t.number}`, { state: 'closed', state_reason: 'completed' });
        }
        sortie.acceptees.push(ref);
      } else if (e.attente) {
        // Il ne manque que le déploiement ou les captures : on attend ; au-delà d'une heure après la fusion, quelqu'un doit le savoir.
        if (heuresEntre(fusionnee.merged_at, maintenant) > ATTENTE_MAX_H) signaler(`PR #${fusionnee.number} fusionnée depuis plus d'une heure, toujours pas acceptée : ${e.raisons.join(' ; ')}`);
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
