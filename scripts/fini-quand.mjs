#!/usr/bin/env node
// Classe de preuve du « Fini quand » d'une tâche (tâche MoKarade/.github#781, mission #703 phase 4, relais du Coordinateur du 28/10/2026 22:38Z).
//
// Constat : presque chaque tâche attendait une preuve lue dans Chrome sur le PC puis relayée, donc aucune tâche sur dix finie sans relais.
// Le « Fini quand » dit désormais QUELLE sorte de preuve il demande, pour que la machine lise ce qu'elle peut lire :
//   A : lisible par machine (réponse HTTP publique, déploiement READY, test ou contrôle de la CI) ; lue par le Réacteur à la fusion
//       (acceptation-auto.mjs).
//   B : page connectée ; lue dans GitHub Actions par un navigateur sans tête, sur l'app lancée avec les DONNÉES FICTIVES des tests (workflow
//       `preuve-page.yml`, comme `captures.yml`), après le déploiement READY. Aucun secret. La preuve DIT que la lecture est fictive.
//   C : exige vraiment Chrome sur le PC (rare) ; la raison est écrite sur la ligne `**Raison de la classe C**`.
//
// Grammaire (même famille que `**Attend**` et `**Fichiers touchés**`) :
//   **Fini quand** (classe B) : <critère vérifiable>
//   **Lecture de page** : GET /chemin → 200, contient « texte »        (une ligne par page, classe B, 5 au plus)
//   **Raison de la classe C** : <au moins 20 caractères>               (classe C)
// Un « Fini quand » sans classe, ou de classe inconnue, est SIGNALÉ sans bloquer la création de la tâche (un avertissement, jamais un rouge).
//
// Fonctions pures seulement (`lireClasse`, `lireLecturesPage`, `controleFiniQuand`, `avertissement`) ; le CLI lit un fichier et écrit l'avertissement.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const CLASSES = ['A', 'B', 'C'];
export const LECTURES_MAX = 5;
export const RAISON_C_MIN = 20;
export const MARQUEUR_AVERTISSEMENT = '<!-- fini-quand-classe -->';

// « **Fini quand** (classe B) : … » : l'en-tête exact (« Fini quand exécutable » est une autre ligne) et sa parenthèse facultative.
const ENTETE = /^[\s>*_-]*\*\*\s*Fini quand\s*\*\*[ \t]*(?:\(([^)\n]*)\))?/im;
const LIGNE_LECTURE = /^[\s>*_-]*\*{0,2}\s*Lecture de page\s*\*{0,2}\s*:\s*(.+?)\s*$/gim;
const LIGNE_RAISON_C = /^[\s>*_-]*\*{0,2}\s*Raison de la classe C\s*\*{0,2}\s*:\s*(.+?)\s*$/im;
// « GET /chemin → 200, contient « texte » » : chemin local de l'app (jamais une adresse libre : le texte d'une tâche est une donnée).
const FORME_LECTURE = /^GET\s+(\/[^\s?#]*(?:\?[^\s#]*)?)\s*(?:→|->)\s*(\d{3})(?:\s*,\s*contient\s*[«"“]\s*(.+?)\s*[»"”])?$/;

/**
 * La classe écrite sur la ligne « Fini quand ». Rend { classe, erreur } : `classe` vaut 'A' | 'B' | 'C' ou null, `erreur` dit pourquoi null.
 * @param corps corps de l'issue
 */
export function lireClasse(corps) {
  const m = ENTETE.exec(String(corps ?? ''));
  if (!m) return { classe: null, erreur: 'aucune ligne « **Fini quand** »' };
  if (m[1] === undefined) return { classe: null, erreur: 'le « Fini quand » ne dit pas sa classe de preuve : écris « **Fini quand** (classe A|B|C) : … »' };
  const c = /^\s*(?:classe|preuve)\s+([^\s,;)]+)\s*$/i.exec(m[1]);
  if (!c) return { classe: null, erreur: `la parenthèse du « Fini quand » (« ${m[1].trim().slice(0, 40)} ») n’est pas « classe A|B|C »` };
  const lettre = c[1].toUpperCase();
  if (!CLASSES.includes(lettre)) return { classe: null, erreur: `classe de preuve inconnue « ${c[1].slice(0, 10)} » (A, B ou C)` };
  return { classe: lettre, erreur: null };
}

/** Les lignes « Lecture de page » : { lectures: [{ chemin, statut, texte }], erreurs: [...] }. Jamais d'hôte, de schéma ni de `..`. */
export function lireLecturesPage(corps) {
  const lectures = [];
  const erreurs = [];
  for (const m of String(corps ?? '').matchAll(LIGNE_LECTURE)) {
    const f = FORME_LECTURE.exec(m[1]);
    if (!f) {
      erreurs.push(`ligne « Lecture de page » illisible : « ${m[1].slice(0, 60)} » (forme : GET /chemin → 200, contient « texte »)`);
      continue;
    }
    const [, chemin, statut, texte = null] = f;
    if (chemin.startsWith('//') || chemin.split('/').includes('..') || chemin.length > 200) {
      erreurs.push(`chemin refusé : « ${chemin.slice(0, 60)} »`);
      continue;
    }
    lectures.push({ chemin, statut: Number(statut), texte });
  }
  if (lectures.length > LECTURES_MAX) {
    erreurs.push(`plus de ${LECTURES_MAX} lectures de page (${lectures.length})`);
    lectures.length = LECTURES_MAX;
  }
  return { lectures, erreurs };
}

/**
 * Le jugement complet d'un « Fini quand ». Rend { ok, classe, lectures, motifs } ; `motifs` dit tout ce qui manque.
 * Classe B : au moins une lecture de page lisible. Classe C : la raison est écrite.
 */
export function controleFiniQuand(corps) {
  const motifs = [];
  const { classe, erreur } = lireClasse(corps);
  if (!classe) motifs.push(erreur);
  const { lectures, erreurs } = lireLecturesPage(corps);
  if (classe === 'B') {
    motifs.push(...erreurs);
    if (lectures.length === 0) motifs.push('classe B : aucune ligne « **Lecture de page** : GET /chemin → 200, contient « texte » »');
  }
  if (classe === 'C') {
    const raison = LIGNE_RAISON_C.exec(String(corps ?? ''))?.[1] ?? '';
    if (raison.length < RAISON_C_MIN) motifs.push(`classe C : écris la ligne « **Raison de la classe C** : … » (${RAISON_C_MIN} caractères au moins) : pourquoi la machine ne peut pas lire`);
  }
  return { ok: motifs.length === 0, classe, lectures: classe === 'B' ? lectures : [], motifs };
}

/** Le texte du commentaire d'avertissement (sans rien bloquer), ou null si le « Fini quand » est en règle. */
export function avertissement(corps) {
  const v = controleFiniQuand(corps);
  if (v.ok) return null;
  return [
    MARQUEUR_AVERTISSEMENT,
    '**Fini quand** : la classe de preuve est à écrire (avertissement, rien n’est bloqué).',
    '',
    ...v.motifs.map((m) => `- ${m}`),
    '',
    'A = lisible par machine (HTTP public, déploiement, CI) · B = page connectée, lue en mode fictif par `preuve-page.yml` · C = Chrome sur le PC, avec sa raison. Règle : `docs/cycle-de-vie-tache.md` §2 bis.',
  ].join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const fichier = process.argv[2];
  if (!fichier) {
    console.error('usage : node scripts/fini-quand.mjs <fichier du corps de l’issue>');
    process.exit(2);
  }
  const texte = avertissement(readFileSync(fichier, 'utf8'));
  if (texte) console.log(`::warning title=Fini quand::${texte.split('\n').slice(1, 2).join(' ')}`);
  else console.log('Fini quand : classe de preuve en règle.');
}
