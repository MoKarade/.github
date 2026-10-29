#!/usr/bin/env node
// Une tâche `en-cours` sans PR depuis plus de 3 h libère sa place (docs/places-immobiles.md, mission MoKarade/.github#703, tâche #868).
//
// Décision de Marc (29/10/2026, 15:00Z, « oui go » sur le rapport « Workflow Apps : objectif, bilan et direction », décision 2) : des tâches `en-cours` sans aucune PR
// tenaient des places (FinanceAI 5 `en-cours` pour 3 places, MemoryAI 4) et leurs files ne sortaient rien. L'alerte existait, elle ne libérait rien.
//
// À chaque événement du dépôt (le Réacteur appelle cette étape par `pilotage-evenement.mjs`, aucun minuteur en plus) :
//   - première fois : un commentaire marqueur `<!-- place-immobile -->` sur la tâche, une seule fois, et un signal qui réveille la boîte du fil ;
//   - une heure ou plus après le marqueur, toujours ni PR ni commentaire du fil : `en-cours` est retiré, `bloqué` posé, la raison écrite. La place se libère, la file avance.
// Jamais pour une tâche `preuve-attendue`, `qui:marc` ou `jules`, ni pour une tâche citée par une PR OUVERTE de n'importe quel dépôt de MoKarade (la PR de la tâche peut vivre
// ailleurs : .github#748 a ses PR dans les neuf dépôts d'app). L'issue n'est jamais fermée : on pose `bloqué`, le fil du dépôt décide.
// Un état qu'on ne peut pas lire (événements, commentaires, recherche en échec) ne libère rien : mieux vaut une place occupée de trop qu'un travail réel retiré.
//
// Fonctions pures d'un côté (`decider`), I/O de l'autre (`libererPlacesImmobiles`, `gh` injecté : `gh(methode, chemin, corps) -> JSON`, comme les autres étapes du pilotage).
import { extraireTachesCompletes } from './tache-liee.mjs';

export const MARQUEUR = '<!-- place-immobile -->';
export const SEUIL_H = 3;
export const ATTENTE_H = 1;
export const LABEL_EN_COURS = 'en-cours';
export const LABEL_BLOQUE = 'bloqué';
export const ETIQUETTES_PROTEGEES = ['preuve-attendue', 'qui:marc', 'jules'];
// Une tâche qui attend un relevé du PC ou un déploiement n'est pas immobile (cas Hubperso#719, 29/10/2026) : un commentaire de ce genre posé APRÈS `en-cours` la protège 24 h.
export const ATTENTE_RELEVE = /^\s*\*\*(Relevé PC demandé|Relevé PC|Preuve attendue)\*\*/i;
export const PROTECTION_RELEVE_H = 24;

const noms = (labels) => (labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
const heures = (depuis, maintenant) => (maintenant.getTime() - Date.parse(depuis)) / 3_600_000;

/**
 * Que faire d'une tâche `en-cours` ? Rend { action: 'rien' | 'signaler' | 'liberer', heures }.
 *   enCoursDepuis : ISO de la pose de `en-cours` (null = illisible : rien) ; marqueur : le commentaire marqueur ({ created_at }) ou null ;
 *   reponseDuFil : un commentaire autre que le marqueur existe-t-il après lui ? ; prOuverte : une PR ouverte cite-t-elle la tâche ?
 */
export function decider({ labels, enCoursDepuis, marqueur, reponseDuFil, prOuverte, attenteReleve = false, maintenant }) {
  const l = noms(labels);
  if (ETIQUETTES_PROTEGEES.some((p) => l.includes(p)) || !l.includes(LABEL_EN_COURS)) return { action: 'rien', raison: 'protégée' };
  if (prOuverte) return { action: 'rien', raison: 'PR ouverte' };
  if (attenteReleve) return { action: 'rien', raison: 'attend un relevé' };
  if (!enCoursDepuis) return { action: 'rien', raison: 'âge illisible' };
  const h = heures(enCoursDepuis, maintenant);
  if (h < SEUIL_H) return { action: 'rien', raison: 'récente', heures: h };
  if (!marqueur) return { action: 'signaler', heures: h };
  if (reponseDuFil) return { action: 'rien', raison: 'le fil a répondu', heures: h };
  return heures(marqueur.created_at, maintenant) >= ATTENTE_H ? { action: 'liberer', heures: h } : { action: 'rien', raison: 'marqueur récent', heures: h };
}

/** La pose la plus récente de `en-cours`, lue dans les événements de l'issue ; null si absente. */
export function poseEnCours(evenements) {
  const poses = (evenements ?? []).filter((e) => e.event === 'labeled' && e.label?.name === LABEL_EN_COURS).map((e) => e.created_at);
  return poses.length ? poses.sort().at(-1) : null;
}

const arrondi = (h) => Math.floor(h);

/** Un commentaire de relevé/preuve, posé après `en-cours` et il y a moins de 24 h, dit que la tâche attend un déploiement ou le PC. */
export function attendUnReleve({ commentaires, enCoursDepuis, maintenant }) {
  return (commentaires ?? []).some(
    (c) => ATTENTE_RELEVE.test(String(c.body ?? '')) && Date.parse(c.created_at) >= Date.parse(enCoursDepuis) && heures(c.created_at, maintenant) < PROTECTION_RELEVE_H,
  );
}

/** Une PR ouverte, dans n'importe quel dépôt de MoKarade, cite-t-elle `depot#n` ? Une recherche en échec lève (l'appelant ne libère alors rien). */
function prOuverteAilleurs({ depot, n, gh }) {
  const q = encodeURIComponent(`org:${depot.split('/')[0]} is:pr is:open "${depot}#${n}"`);
  return (gh('GET', `search/issues?q=${q}&per_page=5`)?.items ?? []).length > 0;
}

/**
 * Signale puis libère les places immobiles du dépôt. Ne lève pas pour une tâche : une lecture ratée la laisse telle quelle (elle est dite dans `illisibles`).
 * @returns {{ signalees: string[], liberees: string[], illisibles: string[] }} références courtes (« FinanceAI#17 »)
 */
export function libererPlacesImmobiles({ depot, gh, maintenant = new Date(), aBlanc = false }) {
  const court = depot.split('/').pop();
  const sortie = { signalees: [], liberees: [], illisibles: [] };
  const prises = gh('GET', `repos/${depot}/issues?state=open&labels=${LABEL_EN_COURS}&per_page=100`).filter((i) => !i.pull_request);
  if (prises.length === 0) return sortie;
  const prs = gh('GET', `repos/${depot}/pulls?state=open&per_page=100`);
  const citees = new Set(prs.flatMap((pr) => extraireTachesCompletes(pr.body, depot).filter((t) => t.depot.toLowerCase() === depot.toLowerCase()).map((t) => t.numero)));
  for (const t of prises) {
    const ref = `${court}#${t.number}`;
    try {
      // Les lectures coûteuses ne partent que pour une tâche qui peut vraiment être immobile.
      const avant = decider({ labels: t.labels, enCoursDepuis: t.updated_at ?? t.created_at, marqueur: null, reponseDuFil: false, prOuverte: citees.has(t.number), maintenant });
      if (avant.raison === 'protégée' || avant.raison === 'PR ouverte') continue;
      const enCoursDepuis = poseEnCours(gh('GET', `repos/${depot}/issues/${t.number}/events?per_page=100`));
      if (!enCoursDepuis || heures(enCoursDepuis, maintenant) < SEUIL_H) continue;
      if (prOuverteAilleurs({ depot, n: t.number, gh })) continue;
      const commentaires = gh('GET', `repos/${depot}/issues/${t.number}/comments?per_page=100`);
      const marqueur = commentaires.find((c) => String(c.body ?? '').includes(MARQUEUR)) ?? null;
      const reponseDuFil = marqueur ? commentaires.some((c) => c !== marqueur && Date.parse(c.created_at) > Date.parse(marqueur.created_at)) : false;
      const verdict = decider({ labels: t.labels, enCoursDepuis, marqueur, reponseDuFil, prOuverte: false, attenteReleve: attendUnReleve({ commentaires, enCoursDepuis, maintenant }), maintenant });
      if (verdict.action === 'signaler') {
        if (!aBlanc) {
          gh('POST', `repos/${depot}/issues/${t.number}/comments`, {
            body: `${MARQUEUR}\nCette tâche est \`en-cours\` depuis ${arrondi(verdict.heures)} h sans aucune PR ouverte : elle tient une place du dépôt. Si le travail continue, ouvrir la PR ou écrire ici où il en est. Sans réponse dans l'heure, \`en-cours\` est retiré et \`${LABEL_BLOQUE}\` posé, pour que la file avance (docs/places-immobiles.md).`,
          });
        }
        sortie.signalees.push(ref);
      } else if (verdict.action === 'liberer') {
        if (!aBlanc) {
          gh('DELETE', `repos/${depot}/issues/${t.number}/labels/${LABEL_EN_COURS}`);
          gh('POST', `repos/${depot}/issues/${t.number}/labels`, { labels: [LABEL_BLOQUE] });
          gh('POST', `repos/${depot}/issues/${t.number}/comments`, {
            body: `Aucune PR depuis ${arrondi(verdict.heures)} h, place libérée : \`${LABEL_EN_COURS}\` retiré, \`${LABEL_BLOQUE}\` posé. La tâche reste ouverte ; le fil du dépôt la reprend en retirant \`${LABEL_BLOQUE}\` quand il peut avancer.`,
          });
        }
        sortie.liberees.push(ref);
      }
    } catch {
      sortie.illisibles.push(ref);
    }
  }
  return sortie;
}
