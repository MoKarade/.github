#!/usr/bin/env node
// Lancer une session par événement pour une tâche prête que Jules ne prend pas (tâche MoKarade/.github#860, choix « A » de Marc, 29/10/2026).
//
// Aucun événement GitHub ne crée une session Claude. Pour les dépôts où aucun fil n'écoute la boîte (app-template, hub-contract), le Réacteur
// lance donc la routine « Prendre une tâche » par son déclencheur d'API : `POST /v1/claude_code/routines/<id>/fire`. La routine ouvre une session
// neuve qui livre la tâche (compétence `livrer-une-tache`). Le texte envoyé ne contient que `dépôt#numéro` : jamais un titre ni un corps d'issue.
//
// Sans les secrets `ROUTINE_PRENDRE_URL` et `ROUTINE_PRENDRE_TOKEN`, rien ne se passe et rien n'échoue : le Réacteur réveille la boîte comme avant.
// Jamais d'exception : un lancement raté est un avertissement du journal, le réveil de la boîte part quand même.
//
// Fonctions pures (`adresseValide`, `texteDeLancement`, `marqueRecente`, `tacheLancable`), I/O injecté (`api`, `appeler`) : les tests n'ont besoin ni de réseau ni de fichier.

export const MARQUE_ROUTINE = '<!-- routine-lancee -->';
export const FENETRE_ROUTINE_H = 6;
export const ENTETE_BETA = 'experimental-cc-routine-2026-04-01';
export const LABEL_TACHE = 'niveau:tâche';
// Une tâche qui porte l'une de ces étiquettes est déjà prise (ou ne se prend pas) : la routine ne part pas.
export const ETIQUETTES_QUI_ECARTENT = ['en-cours', 'jules', 'faisable-jules', 'qui:marc', 'bloqué', 'preuve-attendue'];
// La file doit avoir au moins une place libre.
export const STATUTS_AVEC_PLACE = new Set(['libre', 'partiel']);
export const DELAI_APPEL_MS = 15000;

// Le jeton ne part que vers cette adresse : un secret mal posé ne l'envoie jamais ailleurs.
const ADRESSE = /^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/trig_[A-Za-z0-9]{10,64}\/fire$/;
const DEPOT = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export const adresseValide = (url) => ADRESSE.test(String(url ?? ''));

/** Le texte envoyé à la routine : le dépôt et le numéro, rien d'autre (règle MoKarade/.github#136). Lève sur une entrée douteuse. */
export function texteDeLancement(depot, n) {
  if (!DEPOT.test(String(depot ?? '')) || !Number.isInteger(Number(n)) || Number(n) <= 0) throw new Error('dépôt ou numéro de tâche invalide');
  return `${depot}#${Number(n)}`;
}

const noms = (issue) => (issue?.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));

/** La tâche peut-elle être prise par une session neuve ? Rend { ok: true } ou { ok: false, raison }. */
export function tacheLancable(issue) {
  if (!issue) return { ok: false, raison: 'issue introuvable' };
  if (issue.state !== 'open') return { ok: false, raison: 'fermée' };
  const etiquettes = noms(issue);
  if (!etiquettes.includes(LABEL_TACHE)) return { ok: false, raison: 'pas une tâche' };
  const ecartee = ETIQUETTES_QUI_ECARTENT.find((l) => etiquettes.includes(l));
  return ecartee ? { ok: false, raison: `étiquette « ${ecartee} »` } : { ok: true };
}

/** Un commentaire marqueur de moins de `FENETRE_ROUTINE_H` heures ? Rend ce commentaire, sinon null. */
export function marqueRecente(commentaires, maintenant = new Date()) {
  const limite = maintenant.getTime() - FENETRE_ROUTINE_H * 3600 * 1000;
  return (commentaires ?? []).find((c) => String(c?.body ?? '').startsWith(MARQUE_ROUTINE) && new Date(c.created_at).getTime() >= limite) ?? null;
}

/**
 * Lance la routine pour la tâche `depot#n`. `routine` : { url, token } (les secrets ; absents = rien). `api(methode, chemin, corps)` : chemin avec « / » initial,
 * 404 en lecture = null. `appeler` : `fetch` (injecté par les tests). `file` : le résultat de `fileDuDepot` (statut de la file) ; absent = on ne devine pas.
 * Rend { statut: 'lancee'|'rien'|'erreur', raison?, session? } ; ne lève jamais.
 * Ordre : réserver (commentaire marqueur) → lancer → relâcher le marqueur si le lancement échoue. Deux événements simultanés ne lancent donc pas deux sessions
 * (la fenêtre qui reste est celle de deux réservations dans la même seconde).
 */
export async function lancerRoutine({ api, depot, n, routine = {}, file = null, maintenant = new Date(), journal = console.log, appeler = fetch }) {
  const url = String(routine.url ?? '').trim();
  const token = String(routine.token ?? '').trim();
  if (!url || !token) return { statut: 'rien', raison: 'secrets de la routine absents' };
  if (!adresseValide(url)) {
    journal('::warning::Routine : ROUTINE_PRENDRE_URL n’est pas l’adresse /fire d’une routine (https://api.anthropic.com/v1/claude_code/routines/trig_…/fire). Rien n’est envoyé.');
    return { statut: 'rien', raison: 'adresse refusée' };
  }
  let texte;
  try {
    texte = texteDeLancement(depot, n);
  } catch (e) {
    return { statut: 'rien', raison: e.message };
  }
  if (!file || !STATUTS_AVEC_PLACE.has(file.statut)) return { statut: 'rien', raison: `file du dépôt « ${file?.statut ?? 'illisible'} » : pas de place libre` };
  let reservation = null;
  try {
    const issue = await api('GET', `/repos/${depot}/issues/${n}`);
    const lancable = tacheLancable(issue);
    if (!lancable.ok) return { statut: 'rien', raison: lancable.raison };
    const commentaires = await api('GET', `/repos/${depot}/issues/${n}/comments?per_page=100`);
    if (marqueRecente(commentaires, maintenant)) return { statut: 'rien', raison: `routine déjà lancée dans les ${FENETRE_ROUTINE_H} dernières heures` };
    reservation = await api('POST', `/repos/${depot}/issues/${n}/comments`, {
      body: `${MARQUE_ROUTINE}\nRoutine « Prendre une tâche » en cours de lancement par le Réacteur (un événement du dépôt, aucun minuteur). Une session neuve livre cette tâche ; elle pose \`en-cours\` en la prenant.`,
    });
  } catch (e) {
    journal(`::warning::Routine : tâche ${depot}#${n} non réservée (${e.message}). Rien n’est lancé.`);
    return { statut: 'erreur', raison: `réservation : ${e.message}` };
  }
  const relacher = async () => {
    if (!reservation?.id) return;
    try {
      await api('DELETE', `/repos/${depot}/issues/comments/${reservation.id}`);
    } catch (e) {
      journal(`::warning::Routine : marqueur de ${depot}#${n} non retiré (${e.message}). Aucune nouvelle tentative pendant ${FENETRE_ROUTINE_H} h.`);
    }
  };
  let session = '';
  try {
    const reponse = await appeler(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': ENTETE_BETA,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text: texte }),
      signal: AbortSignal.timeout(DELAI_APPEL_MS),
    });
    if (!reponse.ok) {
      // 429 : plafond de 30 lancements par heure pour une routine ; 401/403 : jeton révoqué ; 4xx autre : en-tête bêta périmé. Le détail de la réponse ne se journalise pas.
      journal(`::warning::Routine : lancement de ${texte} refusé (HTTP ${reponse.status}). Le Coordinateur reprend la tâche comme avant.`);
      await relacher();
      return { statut: 'erreur', raison: `HTTP ${reponse.status}` };
    }
    const corps = await reponse.json().catch(() => ({}));
    session = typeof corps?.claude_code_session_url === 'string' && corps.claude_code_session_url.startsWith('https://claude.ai/') ? corps.claude_code_session_url : '';
  } catch (e) {
    journal(`::warning::Routine : lancement de ${texte} impossible (${e.message}). Le Coordinateur reprend la tâche comme avant.`);
    await relacher();
    return { statut: 'erreur', raison: e.message };
  }
  if (reservation?.id && session) {
    try {
      await api('PATCH', `/repos/${depot}/issues/comments/${reservation.id}`, {
        body: `${MARQUE_ROUTINE}\nRoutine « Prendre une tâche » lancée par le Réacteur (un événement du dépôt, aucun minuteur) : ${session}\nElle pose \`en-cours\` en prenant la tâche.`,
      });
    } catch (e) {
      journal(`::warning::Routine : lien de la session non écrit sur ${depot}#${n} (${e.message}).`);
    }
  }
  journal(`Routine : session lancée pour ${texte}${session ? ` (${session})` : ''}.`);
  return { statut: 'lancee', ...(session ? { session } : {}) };
}
