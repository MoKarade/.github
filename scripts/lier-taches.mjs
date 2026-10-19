#!/usr/bin/env node
// Lie sur GitHub ce que les tâches écrivent déjà dans leur ligne `**Attend**` (MoKarade/.github, demande de Marc du 19/10/2026) :
// « une tâche qui dépend d'une autre doit y être visiblement liée ». GitHub n'affiche « Bloquée par » que pour une dépendance NATIVE ;
// le script de la file (`prochaine-tache.mjs`, `liens_manquants`) liste celles qui manquent, celui-ci les crée.
// Idempotent (un lien déjà posé n'est pas un échec), jamais destructif (il ne retire rien), ne lève jamais : un échec se lit dans le résultat.
// Fonctions pures d'un côté (`analyserLien`, `lierTout`), I/O de l'autre (`main`, `gh`).
//
// Usage : node scripts/lier-taches.mjs prochaines.json [--a-blanc]

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ORG = 'MoKarade';

/** « memoryai#93 » ou « .github#16 » -> { depot, n }, ou null si la forme est illisible. */
export function analyserLien(reference) {
  const m = /^([\w.-]+)#(\d+)$/.exec(String(reference ?? '').trim());
  return m ? { depot: m[1], n: Number(m[2]) } : null;
}

/**
 * Pose chaque lien { ref, attend } : `ref` est bloquée par `attend`. `gh(methode, chemin, corps)` rend l'objet JSON de la réponse ou lève une erreur.
 * @returns {{ faits: string[], deja: string[], echecs: { lien: string, raison: string }[] }}
 */
export function lierTout(liens, gh, { aBlanc = false } = {}) {
  const resultat = { faits: [], deja: [], echecs: [] };
  const ids = new Map();
  const identifiant = (cible) => {
    const cle = `${cible.depot}#${cible.n}`;
    if (!ids.has(cle)) ids.set(cle, gh('GET', `repos/${ORG}/${cible.depot}/issues/${cible.n}`).id);
    return ids.get(cle);
  };
  for (const { ref, attend } of liens) {
    const nom = `${ref} <- ${attend}`;
    const tache = analyserLien(ref);
    const bloqueur = analyserLien(attend);
    if (!tache || !bloqueur) { resultat.echecs.push({ lien: nom, raison: 'référence illisible' }); continue; }
    if (aBlanc) { resultat.faits.push(nom); continue; }
    try {
      gh('POST', `repos/${ORG}/${tache.depot}/issues/${tache.n}/dependencies/blocked_by`, { issue_id: identifiant(bloqueur) });
      resultat.faits.push(nom);
    } catch (e) {
      const raison = String(e?.message ?? e);
      // Déjà lié : GitHub répond 422 « already exists » ; le lien est là, c'est le but.
      if (/already|exist|déjà/i.test(raison)) resultat.deja.push(nom);
      else resultat.echecs.push({ lien: nom, raison: raison.slice(0, 200) });
    }
  }
  return resultat;
}

export function ghCli(methode, chemin, corps) {
  const args = ['api', '-X', methode, chemin];
  if (corps) for (const [k, v] of Object.entries(corps)) args.push('-F', `${k}=${v}`);
  const sortie = execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return sortie ? JSON.parse(sortie) : {};
}

function main() {
  const [fichier, ...options] = process.argv.slice(2);
  if (!fichier) { console.error('usage : node scripts/lier-taches.mjs prochaines.json [--a-blanc]'); process.exit(2); }
  const prochaines = JSON.parse(readFileSync(fichier, 'utf8'));
  const r = lierTout(prochaines.liens_manquants ?? [], ghCli, { aBlanc: options.includes('--a-blanc') });
  console.log(`liens : ${r.faits.length} posé(s), ${r.deja.length} déjà là, ${r.echecs.length} échec(s)`);
  for (const e of r.echecs) console.log(`  ÉCHEC ${e.lien} : ${e.raison}`);
  process.exit(r.echecs.length ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
