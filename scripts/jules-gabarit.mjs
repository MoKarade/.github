#!/usr/bin/env node
// Compléter seul le corps des tâches pour Jules (tâche MoKarade/.github#303, demande de Marc du 19/10/2026 19:56Z : « 1B : la rédaction
// mécanique, sans modèle », « 2 : au plus 20 tâches par jour », et rien de payant). Une tâche écrite pour Claude porte ce qu'il faut
// comprendre (Avant, Après, Fini quand, Source) mais pas ce que Jules exige : « Fichiers permis », « À faire », « À ne pas faire »,
// « Vérifier », « À citer dans la PR ». Le filet du PC les ajoute dans un bloc `<!-- gabarit-auto -->` À LA FIN du corps, sans toucher au
// texte existant, quand tout se déduit sans jugement ; sinon il REFUSE, sans écrire, et dit pourquoi (une fois).
//
// Déduit, jamais deviné :
// - « Fichiers permis » = les chemins en `backticks` cités dans Avant, Après, Fini quand (et Source, sauf les .md) qui EXISTENT dans le dépôt,
//   plus le fichier de test dérivé du premier fichier de code ;
// - les autres sections viennent du gabarit (`docs/jules-gabarit-issue.md`), avec les preuves que `evaluerJules` exige pour un écran ou un .md.
// Refus : chemin cité introuvable, motif de fichiers (`*`), chemin réservé à Claude cité dans Avant/Après/Fini quand, plus de cinq fichiers,
// outils MCP, dépendance ouverte ou illisible, section de fond (Avant, Après, Fini quand) absente, ou `evaluerJules` qui dit encore non.
//
// Fonctions pures (`cheminsCites`, `deriverTest`, `composerBloc`), I/O injecté (`gh`) : les tests n'ont besoin ni de réseau ni de fichier.

import { evaluerJules, section, fichiersPermis, SECTIONS_REQUISES, FICHIERS_MAX, FICHIER_ECRAN, CHEMINS_INTERDITS, exclueParDecision } from './jules-auto.mjs';
import { tachesCitees } from './jules-suivi.mjs';
import { ETIQUETTE, MENTION_MCP, dependanceOuverte, aLigneAttend } from './jules-marquage.mjs';

const ORG = 'MoKarade';
export const MARQUEUR = '<!-- gabarit-auto -->';
export const PAR_JOUR_MAX = 20;
export const EXAMEN_MAX = 5; // tâches examinées par dépôt et par tour : les lectures restent bornées
const FENETRE_H = 24;
const ETIQUETTES_QUI_ECARTENT = ['en-cours', 'jules', 'qui:marc', 'bloqué', 'preuve-attendue'];
const SECTIONS_DU_BLOC = ['Fichiers permis', 'À faire', 'À ne pas faire', 'Vérifier', 'À citer dans la PR'];
const PREFIXE_TESTS = { 'batchchef-': 'web/', driveai: 'app/' }; // dépôts dont l'app ne vit pas à la racine
const FICHIER_CODE = /\.(ts|tsx|js|mjs)$/;
const FICHIER_TEST = /\.(test|spec)\.[a-z]+$|(^|\/)(tests?|__tests__)\//;
// Base de données, migrations, secrets : restent à Claude (exclusions maintenues par Marc le 19/10/2026) ; un mot de ces familles dans le fond de la tâche suffit à refuser.
const MENTION_BASE = /migration|sch[ée]ma|base de donn[ée]es|\bdrizzle\b|\bsql\b|\bsentry\b|\bsecrets?\b|jetons?\b|authentification/i;
// Du dessin sur une toile publiée n'est pas un changement de fichier : Jules n'a rien à livrer dans le dépôt.
const MENTION_TOILE = /artifact|\btoile\b|maquette/i;
// Ce qu'un script peut contrôler dans « Fini quand » : un test, ou `npm audit` (0 vulnérabilité se lit sans jugement).
const CONTROLE_MECANIQUE = /test|npm audit/i;
// Une montée de dépendance (alerte Dependabot, `npm audit`) ne cite aucun chemin : ses fichiers sont toujours `package.json` et son lockfile.
const MONTEE_DEPENDANCE = /mise\s+à\s+jour|mettre\s+à\s+jour|\bmonter\b|montée/i;
const FICHIERS_DEPENDANCES = ['package.json', 'package-lock.json'];
const noms = (labels) => (labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));

/** Un refus : `memoriser` dit s'il tient tant que le corps de la tâche ne change pas (faux : il dépend de l'extérieur, on relit au prochain tour). */
const refus = (raison, memoriser = true) => ({ ok: false, raison, memoriser });

/**
 * Les chemins de fichiers cités entre `backticks` dans un texte, et les motifs (`*`) à part.
 * Un jeton sans `/` (un nom de fonction, `BACKLOG.md:L381`) ou qui commence par `/` (une URL de l'app) n'est pas un chemin de fichier.
 */
export function jetonsChemins(texte) {
  const chemins = [];
  const motifs = [];
  for (const m of String(texte ?? '').matchAll(/`([^`\n]+)`/g)) {
    const jeton = m[1].trim().replace(/:L?\d+(?:-L?\d+)?$/, '');
    if (!jeton.includes('/') || jeton.startsWith('/') || /^https?:/.test(jeton) || /\s/.test(jeton)) continue;
    if (jeton.includes('*')) { motifs.push(jeton); continue; }
    if (!/^[\w@.\-/[\]()]+\.\w{1,6}$/.test(jeton)) continue;
    if (!chemins.includes(jeton)) chemins.push(jeton);
  }
  return { chemins, motifs };
}

/**
 * `forts` : chemins cités dans Avant, Après ou Fini quand (la tâche les touche) ; `source` : cités dans Source seulement (de quoi lire, souvent) ;
 * `motifs` : chemins avec `*` (une liste fermée est requise).
 */
export function cheminsCites(corps) {
  const lire = (titres) => {
    const sortie = [];
    const motifs = [];
    for (const titre of titres) {
      const lu = jetonsChemins(section(corps, titre) ?? '');
      for (const c of lu.chemins) if (!sortie.includes(c)) sortie.push(c);
      motifs.push(...lu.motifs);
    }
    return { chemins: sortie, motifs };
  };
  const forts = lire(['Avant', 'Après', 'Fini quand']);
  const faibles = lire(['Source']);
  return {
    forts: forts.chemins,
    source: faibles.chemins.filter((c) => !forts.chemins.includes(c) && !/\.md$/i.test(c)),
    motifs: [...forts.motifs, ...faibles.motifs],
  };
}

/** Le fichier de test d'un fichier de code : `tests/<nom>.test.ts` (nom du dossier pour page, route, index, layout), sous le préfixe de l'app. */
export function deriverTest(chemin, prefixe = '') {
  const morceaux = chemin.split('/');
  const fichier = morceaux.pop();
  const [, nom, ext] = /^(.*?)\.(ts|tsx|js|mjs)$/.exec(fichier) ?? [];
  if (!nom) return null;
  const base = ['page', 'route', 'index', 'layout'].includes(nom) ? (morceaux.at(-1) ?? nom) : nom;
  const propre = base.replace(/[[\]()]/g, '').replace(/^_+|_+$/g, '') || nom;
  return `${prefixe}tests/${propre}.test.${ext === 'mjs' ? 'mjs' : ext === 'js' ? 'js' : 'ts'}`;
}

const premiereMinuscule = (t) => t.replace(/^\p{Lu}(?=\p{Ll})/u, (c) => c.toLowerCase());

/** Le type de commit permis : `test:` si seuls des tests changent, `docs:` si seuls des .md, `fix:` si le titre le dit, sinon `feat:`. */
function typeDeCommit(fichiers, titre) {
  if (fichiers.every((f) => FICHIER_TEST.test(f))) return 'test';
  if (fichiers.every((f) => /\.md$/i.test(f))) return 'docs';
  return /^(corriger|réparer|reparer|fix)/i.test(titre) ? 'fix' : 'feat';
}

/**
 * Le bloc à ajouter au corps : seulement les sections qui manquent (`manquantes`), dans l'ordre du gabarit.
 * @param fichiers  tous les fichiers permis (existants et test dérivé) ; `nouveaux` : ceux qui n'existent pas encore
 */
export function composerBloc({ n, titre, depot, fichiers, nouveaux = [], manquantes, prefixe = '' }) {
  const test = fichiers.find((f) => FICHIER_TEST.test(f));
  const ecran = fichiers.some((f) => FICHIER_ECRAN.test(f));
  const md = fichiers.some((f) => /\.md$/i.test(f));
  const dependances = fichiers.some((f) => /(^|\/)package(-lock)?\.json$/.test(f));
  const filtre = test ? (/\/([^/]+)\.(test|spec)\.[a-z]+$/.exec(test)?.[1] ?? '') : '';
  const lancer = (cmd) => (prefixe === 'web/' ? `cd web && ${cmd}` : cmd);
  const type = typeDeCommit(fichiers, titre);
  const sujet = premiereMinuscule(titre.replace(/\s+/g, ' ').replace(/\.$/, ''));
  const hubperso = String(depot).toLowerCase() === 'hubperso';

  const sections = {
    'Fichiers permis': `**Fichiers permis** (aucun autre) :\n${fichiers.map((f) => `- \`${f}\`${nouveaux.includes(f) ? ' (nouveau)' : ''}`).join('\n')}`,
    'À faire': `**À faire** (dans cet ordre) :\n${[
      'Relis « Avant », « Après » et « Fini quand » ci-dessus : ils sont la consigne.',
      'Modifie seulement les fichiers permis, pour obtenir exactement l\'« Après » et rien d\'autre.',
      test ? `Écris ou complète \`${test}\` pour verrouiller ce que « Fini quand » demande, avec des données fictives seulement.` : null,
      ecran ? 'Prends des captures avant/après avec des données fictives et joins-les à la PR (workflow de captures du dépôt).' : null,
      dependances ? 'Monte la dépendance visée par une mise à jour mineure ou un correctif (patch) seulement, jamais `npm audit fix --force` ; `npm install` met le lockfile à jour.' : null,
      md ? 'Écris en français, avec tous les accents ; ne touche à aucun mot français existant hors des lignes visées.' : null,
      'Lance les commandes de « Vérifier » et montre leur sortie dans la PR.',
    ].filter(Boolean).map((l, i) => `${i + 1}. ${l}`).join('\n')}`,
    'À ne pas faire': `**À ne pas faire** :\n${[
      'Toucher à un fichier hors de « Fichiers permis », même pour « bien faire » : si la tâche l\'exige, arrête-toi et écris-le dans la PR.',
      'Élargir au-delà de l\'« Après » : aucun refactor ni renommage qui n\'est pas demandé.',
      'Désactiver, sauter ou affaiblir un test.',
      'Écrire `Fixes`, `Closes` ou `Resolves`.',
      'Mettre une donnée personnelle de Marc dans le code, les tests ou la PR : données fictives seulement.',
    ].map((l) => `- ${l}`).join('\n')}`,
    'Vérifier': `**Vérifier** : ${[
      filtre ? `\`${lancer(`npm run test -- ${filtre}`)}\`, puis ` : '',
      `\`${lancer('npm run typecheck && npm run test && npm run lint && npm run build')}\``,
      ecran ? `. Lance aussi \`${lancer('npm run test -- tests/theme.test.ts')}\` (couleurs en variables, cibles de 44 px)` : '',
      dependances ? `. Lance aussi \`${lancer('npm audit --omit=dev')}\` : il doit rendre 0 vulnérabilité` : '',
      '. Montre la sortie dans la PR.',
    ].join('')}`,
    'À citer dans la PR': `**À citer dans la PR** : une ligne \`Tâche : #${n}\` dans le CORPS de la PR, titre \`${type}: ${sujet}\` (préfixe permis : \`${type}:\`).${hubperso ? ' Chaque commit commence par `HORS-BACKLOG:`.' : ''} Corps : Avant / Après / Comment.`,
  };
  return `${MARQUEUR}\n${manquantes.map((t) => sections[t]).join('\n\n')}\n`;
}

/** Le chemin existe-t-il comme FICHIER à la racine par défaut du dépôt ? Une erreur autre que « introuvable » remonte (rien n'est deviné). */
export function existe(gh, depot, chemin, { dossier = false } = {}) {
  try {
    const r = gh('GET', `repos/${depot}/contents/${chemin.split('/').map(encodeURIComponent).join('/')}`);
    return dossier ? Array.isArray(r) : !Array.isArray(r);
  } catch (e) {
    if (/404|Not Found/i.test(`${e.message} ${e.stderr ?? ''}`)) return false;
    throw e;
  }
}

/** Décide, pour une tâche, du corps complété ou du refus. Ne modifie rien ; lit le dépôt (existence des fichiers) et les dépendances. */
function preparer({ depot, court, tache, gh }) {
  const corps = tache.body ?? '';
  const titre = tache.title ?? '';
  if (MENTION_MCP.test(corps) || /\bmcp\b/i.test(titre)) return refus('outils MCP : réservés à Claude (décision de Marc du 19/10/2026)');
  if (!aLigneAttend(corps)) return refus('ligne « **Attend** » absente : à écrire par le fil de la tâche (sans elle, la file l\'écarte et Jules ne la verrait jamais)');
  const fond = ['Avant', 'Après', 'Fini quand'].map((t) => section(corps, t) ?? '').join('\n');
  const base = MENTION_BASE.exec(`${titre}\n${fond}`.replace(/`[^`\n]*`/g, ' ')); // hors identifiants de code (`colonnes-pc`)
  if (base) return refus(`« ${base[0]} » : base de données, secrets et authentification restent à Claude`);
  const toile = MENTION_TOILE.exec(`${titre}\n${fond}`);
  if (toile) return refus(`« ${toile[0]} » : travail sur une page publiée, pas sur des fichiers du dépôt`);
  if (!CONTROLE_MECANIQUE.test(section(corps, 'Fini quand') ?? '')) return refus('« Fini quand » ne cite aucun test : rien qu\'un script puisse contrôler');
  const montee = /npm audit/i.test(section(corps, 'Fini quand') ?? '') && MONTEE_DEPENDANCE.test(`${titre}\n${fond}`);
  const manquantes = SECTIONS_REQUISES.filter((t) => (section(corps, t) ?? '').length < 3);
  const absentesDeFond = manquantes.filter((t) => !SECTIONS_DU_BLOC.includes(t));
  if (absentesDeFond.length) return refus(`section de fond à écrire par Claude : ${absentesDeFond.join(', ')}`);
  if (!manquantes.length) return { ok: false, raison: 'corps déjà complet', memoriser: false, complet: true };

  const cites = cheminsCites(corps);
  if (cites.motifs.length) return refus(`motif de fichiers (${cites.motifs[0]}) : une liste fermée de chemins est requise`);
  const prefixe = PREFIXE_TESTS[court.toLowerCase()] ?? '';
  let permis;
  let nouveaux = [];
  if (manquantes.includes('Fichiers permis')) {
    for (const c of cites.forts) {
      const motif = CHEMINS_INTERDITS.find(([m]) => m.test(c));
      if (motif) return refus(`${c} : ${motif[1]}`);
    }
    const candidats = [...cites.forts, ...cites.source.filter((c) => !CHEMINS_INTERDITS.some(([m]) => m.test(c)))];
    permis = [];
    for (const c of candidats) {
      if (existe(gh, depot, c)) permis.push(c);
      else if (cites.forts.includes(c)) return refus(`${c} cité mais introuvable dans le dépôt`);
    }
    if (!permis.length && montee) {
      permis = FICHIERS_DEPENDANCES.map((f) => `${prefixe}${f}`).filter((f) => existe(gh, depot, f));
      if (!permis.includes(`${prefixe}package.json`)) return refus(`${prefixe}package.json introuvable : montée de dépendance impossible à cadrer`);
    }
    if (!permis.length) return refus('aucun chemin de fichier existant cité (Avant, Après, Fini quand, Source)');
    if (!permis.some((f) => !FICHIER_TEST.test(f))) return refus('aucun fichier à modifier cité (seulement des tests) : les fichiers de la tâche ne se déduisent pas');
    const premierCode = permis.find((f) => FICHIER_CODE.test(f) && !FICHIER_TEST.test(f));
    if (premierCode && !permis.some((f) => FICHIER_TEST.test(f))) {
      const test = deriverTest(premierCode, prefixe);
      if (test) {
        if (!existe(gh, depot, `${prefixe}tests`, { dossier: true })) return refus(`dossier ${prefixe}tests introuvable pour le test de ${premierCode}`);
        if (!existe(gh, depot, test)) nouveaux = [test];
        permis.push(test);
      }
    }
    if (permis.length > FICHIERS_MAX) return refus(`plus de ${FICHIERS_MAX} fichiers permis (${permis.length}) : à découper`);
  } else {
    permis = fichiersPermis(corps);
  }

  const bloc = composerBloc({ n: tache.number, titre, depot: court, fichiers: permis, nouveaux, manquantes, prefixe });
  const nouveauCorps = `${corps.replace(/\s+$/, '')}\n\n${bloc}`;
  const verdict = evaluerJules({ repo: court, n: tache.number, labels: [...noms(tache.labels), ETIQUETTE], body: nouveauCorps });
  if (!verdict.ok) return refus(verdict.raisons.join(' ; '));
  const dependance = dependanceOuverte({ depot, court, tache, gh });
  if (dependance === 'illisible') return refus('dépendance illisible : relue au prochain tour', false);
  if (dependance) return refus('dépendance ouverte : relue au prochain tour', false);
  return { ok: true, corps: nouveauCorps, fichiers: permis };
}

const prio = (t) => Number(/prio:(\d)/.exec(noms(t.labels).find((l) => /^prio:\d$/.test(l)) ?? '')?.[1] ?? 9);

/**
 * Complète, dans un dépôt, au plus UNE tâche par tour (la file des « réservées à Jules » n'a besoin que de deux) et au plus `PAR_JOUR_MAX` par 24 h
 * sur tous les dépôts. L'état `etat._completion` garde : `faites` (horodatages) et `refus[ref]` ({ vu: updated_at, raison }) : un refus fondé sur le
 * corps n'est pas relu tant que la tâche n'est pas modifiée.
 * @returns {{ completees: string[], refusees: {ref: string, raison: string}[] }}  `refusees` : seulement les refus NOUVEAUX de ce tour
 */
export function completerDepot({ depot, gh, etat = {}, maintenant = new Date(), aBlanc = false }) {
  const court = depot.replace(`${ORG}/`, '');
  const sortie = { completees: [], refusees: [] };
  const memoire = (etat._completion ??= { faites: [], refus: {} });
  memoire.faites = (memoire.faites ?? []).filter((t) => (maintenant.getTime() - Date.parse(t)) / 3_600_000 < FENETRE_H);
  memoire.refus ??= {};
  if (memoire.faites.length >= PAR_JOUR_MAX) return sortie;

  const ouvertes = gh('GET', `repos/${depot}/issues?state=open&per_page=100`).filter((i) => !i.pull_request && noms(i.labels).includes('niveau:tâche'));
  const candidates = ouvertes
    .filter((i) => {
      const l = noms(i.labels);
      return !l.includes(ETIQUETTE) && !exclueParDecision(court, i.number) && !ETIQUETTES_QUI_ECARTENT.some((x) => l.includes(x)) && !(i.body ?? '').includes(MARQUEUR);
    })
    .sort((a, b) => prio(a) - prio(b) || a.number - b.number);
  if (!candidates.length) return sortie;

  let citees = null;
  let examinees = 0;
  for (const t of candidates) {
    if (examinees >= EXAMEN_MAX) break;
    const ref = `${court}#${t.number}`;
    if (memoire.refus[ref]?.vu === t.updated_at) continue;
    examinees += 1;
    citees ??= new Set(gh('GET', `repos/${depot}/pulls?state=open&per_page=50`).flatMap((p) => tachesCitees(p)));
    if (citees.has(t.number)) continue;
    let r;
    try { r = preparer({ depot, court, tache: t, gh }); } catch (e) { r = refus(`lecture impossible (${String(e.message).replace(/\s+/g, ' ').slice(0, 60)})`, false); }
    if (r.complet) continue; // déjà au gabarit : c'est `marquerFaisables` qui s'en occupe
    if (!r.ok) {
      if (r.memoriser) {
        memoire.refus[ref] = { vu: t.updated_at, raison: r.raison };
        sortie.refusees.push({ ref, raison: r.raison });
      }
      continue;
    }
    if (!aBlanc) {
      gh('PATCH', `repos/${depot}/issues/${t.number}`, { body: r.corps });
      gh('POST', `repos/${depot}/issues/${t.number}/comments`, {
        body: `Corps complété automatiquement par le filet du PC pour que Jules puisse la prendre : bloc « gabarit-auto » ajouté à la fin (fichiers permis : ${r.fichiers.map((f) => `\`${f}\``).join(', ')}, étapes et vérifications du gabarit). Aucun texte existant n'a été modifié ; corrigez le bloc si un fichier manque. La tâche est réservée à Jules au prochain passage si rien d'autre ne l'en empêche.\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_`,
      });
      memoire.faites.push(maintenant.toISOString());
      delete memoire.refus[ref];
    }
    sortie.completees.push(ref);
    break;
  }
  return sortie;
}
