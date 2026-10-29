#!/usr/bin/env node
// Détecteur de silence : si le Réacteur de .github n'a rien traité depuis trop longtemps, une issue `boucle:erreur` prévient Marc (docs/boucle-erreur.md,
// mission MoKarade/.github#703, tâche #720).
//
// Décision de Marc (29/10/2026, 15:06Z) : UptimeRobot est payant, le guetteur tourne SUR LE PC (exception voulue à « rien ne s'active sur le tour du PC »).
// Limite connue, dite à Marc : PC éteint, aucune alerte. Lancé par une tâche Windows en console cachée (conhost --headless), jamais au premier plan.
//
// L'état vit dans GitHub, pas sur le PC : l'alerte est une issue ouverte (une seule par silence), la reprise la referme. Un redémarrage du PC ne la double donc pas.
//   - dernier run terminé (succès ou échec) du Réacteur plus vieux que le seuil : une issue s'ouvre, une fois ;
//   - un run récent alors que l'issue est ouverte : un commentaire de reprise, puis fermeture ;
//   - l'API GitHub échoue : « guetteur aveugle », JAMAIS une alerte de silence (on ne sait pas) ;
//   - jeton absent : rien, et le tour n'échoue pas.
// Un run « skipped » ne compte pas : ouvrir l'issue d'alerte lance elle-même le Réacteur, qui s'ignore, et masquerait le silence.
//
// Fonctions pures d'un côté (`seuilEnHeures`, `dernierTraitement`, `evaluer`), I/O de l'autre (`guetter`, avec `api` injecté).
import { pathToFileURL } from 'node:url';

export const DEPOT = 'MoKarade/.github';
export const WORKFLOW = 'reacteur.yml';
export const LABEL = 'boucle:erreur';
export const TITRE = 'Silence : le Réacteur de .github ne traite plus rien';
export const SEUIL_DEFAUT_H = 2;
const CONCLUSIONS_COMPTEES = new Set(['success', 'failure', 'timed_out']);

/** `SILENCE_MAX_H` en heures (nombre > 0), sinon 2 h. Une valeur absurde ne désactive pas le guetteur. */
export function seuilEnHeures(valeur) {
  const n = Number(valeur);
  return Number.isFinite(n) && n > 0 ? n : SEUIL_DEFAUT_H;
}

/** L'heure (ms) du dernier run terminé qui a vraiment traité quelque chose, ou null. */
export function dernierTraitement(runs) {
  const heures = (runs ?? [])
    .filter((r) => r.status === 'completed' && CONCLUSIONS_COMPTEES.has(r.conclusion))
    .map((r) => Date.parse(r.updated_at ?? r.run_started_at ?? r.created_at))
    .filter(Number.isFinite);
  return heures.length ? Math.max(...heures) : null;
}

/**
 * Que faire ? `dernier` : ms du dernier traitement ou null ; `ouverte` : l'issue d'alerte ouverte ou null.
 * Rend { action: 'alerter' | 'reprise' | 'rien', silenceH }. Aucun traitement lisible = silence (le Réacteur écoute chaque événement du dépôt).
 */
export function evaluer({ maintenant, dernier, seuilH, ouverte }) {
  const silenceH = dernier == null ? Infinity : (maintenant - dernier) / 3_600_000;
  const enSilence = silenceH > seuilH;
  if (enSilence) return { action: ouverte ? 'rien' : 'alerter', silenceH };
  return { action: ouverte ? 'reprise' : 'rien', silenceH };
}

const arrondi = (h) => (Number.isFinite(h) ? `${Math.round(h * 10) / 10} h` : 'plus de 24 h');

export function corpsDAlerte({ silenceH, seuilH }) {
  return [
    `Aucun run du Réacteur de ${DEPOT} n'a fini depuis ${arrondi(silenceH)} (seuil : ${seuilH} h).`,
    '',
    `- Les runs : https://github.com/${DEPOT}/actions/workflows/${WORKFLOW}`,
    '- Causes possibles : réveils perdus, Actions en panne, dépôt gelé, ou simplement rien à traiter (alors cette issue se referme seule au prochain événement).',
    '',
    `Posée par le guetteur du PC (docs/boucle-erreur.md). Limite connue : PC éteint, aucune alerte. Étiquette \`${LABEL}\`.`,
  ].join('\n');
}

/** Un tour du guetteur. Ne lève jamais. Rend { etat: 'ok' | 'alerte' | 'reprise' | 'aveugle' | 'sans-jeton', ... }. */
export async function guetter({ api, maintenant = Date.now(), seuilH = SEUIL_DEFAUT_H, journal = console.log }) {
  try {
    const lot = await api('GET', `/repos/${DEPOT}/actions/workflows/${WORKFLOW}/runs?status=completed&per_page=50`);
    const issues = await api('GET', `/repos/${DEPOT}/issues?labels=${encodeURIComponent(LABEL)}&state=open&per_page=100`);
    if (!lot || !Array.isArray(lot.workflow_runs) || !Array.isArray(issues)) throw new Error('réponse GitHub illisible');
    const ouverte = issues.find((i) => !i.pull_request && i.title === TITRE) ?? null;
    const { action, silenceH } = evaluer({ maintenant, dernier: dernierTraitement(lot.workflow_runs), seuilH, ouverte });
    if (action === 'alerter') {
      const cree = await api('POST', `/repos/${DEPOT}/issues`, { title: TITRE, body: corpsDAlerte({ silenceH, seuilH }), labels: [LABEL] });
      journal(`Guetteur : silence de ${arrondi(silenceH)}, issue #${cree?.number} ouverte.`);
      return { etat: 'alerte', issue: cree?.number ?? null, silenceH };
    }
    if (action === 'reprise') {
      await api('POST', `/repos/${DEPOT}/issues/${ouverte.number}/comments`, { body: `Reprise : un run du Réacteur a fini il y a ${arrondi(silenceH)}. Fermée.` });
      await api('PATCH', `/repos/${DEPOT}/issues/${ouverte.number}`, { state: 'closed', state_reason: 'completed' });
      journal(`Guetteur : reprise, #${ouverte.number} fermée.`);
      return { etat: 'reprise', issue: ouverte.number, silenceH };
    }
    journal(`Guetteur : ok (dernier traitement il y a ${arrondi(silenceH)}).`);
    return { etat: 'ok', silenceH };
  } catch (e) {
    // On ne sait pas : jamais une alerte de silence sur une API en échec.
    journal(`Guetteur aveugle : ${String(e.message).replace(/\s+/g, ' ').slice(0, 160)}`);
    return { etat: 'aveugle', erreur: e.message };
  }
}

function apiGitHub(jeton) {
  return async function api(methode, chemin, corps) {
    const r = await fetch(`https://api.github.com${chemin}`, {
      method: methode,
      headers: { authorization: `Bearer ${jeton}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json', 'user-agent': 'guetteur-silence' },
      body: corps ? JSON.stringify(corps) : undefined,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} sur ${methode} ${chemin}`);
    return r.status === 204 ? null : r.json();
  };
}

export async function main(env = process.env, journal = console.log) {
  const jeton = env.GUETTEUR_TOKEN || env.GITHUB_TOKEN || env.GH_TOKEN;
  if (!jeton) {
    journal('Guetteur : jeton absent, rien à faire.');
    return { etat: 'sans-jeton' };
  }
  return guetter({ api: apiGitHub(jeton), seuilH: seuilEnHeures(env.SILENCE_MAX_H), journal });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
