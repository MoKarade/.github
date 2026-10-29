#!/usr/bin/env node
// Verrous de CI (option C de Marc, 29/10/2026, étape 2 du plan) : les trois contrôles que le Garde-fou fait
// aujourd'hui pour les lignes rouges de Marc, refaits en CI ordinaire, SANS le remplacer (mode miroir, non requis) :
//   1. aucun test retiré ou sauté par rapport à la branche de base ;
//   2. aucun secret en clair ajouté ;
//   3. aucune migration destructive.
// Mêmes définitions que scripts/garde-fou.mjs (motifs recopiés : ce fichier-là ne se modifie pas). Écarts voulus :
// `DELETE FROM` n'est destructif que sans `WHERE` (demande de Marc), et quelques motifs de clés courants s'ajoutent.
//
// Fonctions pures d'un côté (`verifier` et ce qu'elle appelle : entrée = fichiers + patch, sortie = verdict + raisons),
// I/O de l'autre (`main` lance `git diff` dans le dépôt de l'appelant). Échec fermé : une erreur git = rouge.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const EST_TEST = /(^|\/)(tests?|__tests__|e2e|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const CAS_DE_TEST = /^\s*(?:it|test)\b[.(]/;
const TEST_SAUTE =
  /\b(?:it|test|describe|suite|t)\.(?:skip|skipIf|todo|only|fixme)\b|\bx(?:it|describe|test)\s*\(|\{\s*skip\s*:\s*(?!false)/;

const EST_ENV = /(^|\/)\.env[^/]*$/;
const ENV_MODELE = /(^|\/)\.env\.(example|sample|template)$/;
const SECRET_LITTERAL = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\b[sr]k_live_[0-9A-Za-z]{20,}/,
  /\bnpm_[A-Za-z0-9]{36}\b/,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:(?!\$\{|<|\*|x{3,}|password|motdepasse)[^\s:/@$<{*]{6,}@[^\s/]+/i,
];

const EST_SQL = /\.sql$/i;
const EST_MIGRATION = /(^|\/)(drizzle|migrations?)\/.+\.sql$/;
const SQL_DESTRUCTIF = [
  [/\bALTER\b[^;]*\bDROP\b/i, 'ALTER ... DROP'],
  [/\bDROP\s+(?:TABLE|COLUMN|SCHEMA|INDEX|TYPE|CONSTRAINT|VIEW|DATABASE|SEQUENCE)\b/i, 'DROP'],
  [/\bTRUNCATE\b/i, 'TRUNCATE'],
  [/\bRENAME\s+(?:TO|COLUMN|CONSTRAINT)\b/i, 'RENAME'],
  [/\bALTER\s+COLUMN\s+\S+\s+(?:SET\s+DATA\s+)?TYPE\b/i, 'ALTER COLUMN ... TYPE'],
  [/\bUPDATE\s+\S+\s+SET\b/i, 'UPDATE ... SET'],
];

const abreger = (texte) => {
  const propre = texte.trim().replace(/\s+/g, ' ');
  return propre.length > 90 ? `${propre.slice(0, 87)}...` : propre;
};

/** Sépare les lignes ajoutées et retirées d'un patch (hunks seulement, sans en-têtes de fichier). */
export function lignesDuPatch(patch) {
  const ajoutees = [];
  const retirees = [];
  for (const ligne of (patch ?? '').split('\n')) {
    if (ligne.startsWith('+')) ajoutees.push(ligne.slice(1));
    else if (ligne.startsWith('-')) retirees.push(ligne.slice(1));
  }
  return { ajoutees, retirees };
}

/**
 * Lit la sortie de `git diff -M` : [{ filename, status, previous_filename, patch }].
 * `status` : added | removed | modified | renamed. `patch` est absent pour un binaire ou un simple changement de mode.
 */
export function parserDiff(texte) {
  const fichiers = [];
  for (const bloc of (texte ?? '').split(/^diff --git /m).slice(1)) {
    const lignes = bloc.split('\n');
    const entete = lignes[0];
    const indexHunk = lignes.findIndex((l) => l.startsWith('@@'));
    const avantHunk = (indexHunk === -1 ? lignes : lignes.slice(0, indexHunk)).join('\n');
    const f = { filename: '', status: 'modified' };
    const de = /^rename from (.+)$/m.exec(avantHunk);
    const vers = /^rename to (.+)$/m.exec(avantHunk);
    if (de && vers) {
      f.status = 'renamed';
      f.previous_filename = de[1];
      f.filename = vers[1];
    } else {
      const m = /^a\/(.+) b\/\1$/.exec(entete);
      f.filename = m ? m[1] : entete.replace(/^a\/.+? b\//, '');
      if (/^new file mode/m.test(avantHunk)) f.status = 'added';
      else if (/^deleted file mode/m.test(avantHunk)) f.status = 'removed';
    }
    if (indexHunk !== -1) f.patch = lignes.slice(indexHunk).join('\n');
    fichiers.push(f);
  }
  return fichiers;
}

const violation = (controle, fichier, detail) => ({ controle, fichier, detail });

/** Contrôle 1 : aucun test retiré, sauté, isolé, ni moins de cas qu'avant (quand le patch se lit). */
export function controleTests(fichiers) {
  const raisons = [];
  let casAjoutes = 0;
  let casRetires = 0;
  for (const f of fichiers) {
    const nom = f.filename;
    const estTest = EST_TEST.test(nom);
    if (estTest && f.status === 'removed') raisons.push(violation('tests', nom, 'fichier de test supprimé'));
    if (f.status === 'renamed' && f.previous_filename && EST_TEST.test(f.previous_filename) && !estTest) {
      raisons.push(violation('tests', nom, `fichier de test renommé hors des tests (était ${f.previous_filename})`));
    }
    if (!estTest) continue;
    const { ajoutees, retirees } = lignesDuPatch(f.patch);
    for (const l of ajoutees) {
      if (TEST_SAUTE.test(l)) raisons.push(violation('tests', nom, `test sauté ou isolé : ${abreger(l)}`));
      if (CAS_DE_TEST.test(l)) casAjoutes += 1;
    }
    for (const l of retirees) if (CAS_DE_TEST.test(l)) casRetires += 1;
  }
  if (casRetires > casAjoutes) {
    raisons.push(violation('tests', '(PR)', `moins de cas de test qu'avant : ${casRetires} retirés, ${casAjoutes} ajoutés`));
  }
  return raisons;
}

/** Contrôle 2 : aucun secret en clair dans les lignes ajoutées, aucun .env réel versionné. */
export function controleSecrets(fichiers) {
  const raisons = [];
  for (const f of fichiers) {
    const nom = f.filename;
    if (f.status !== 'removed' && EST_ENV.test(nom) && !ENV_MODELE.test(nom)) {
      raisons.push(violation('secrets', nom, 'fichier .env versionné ajouté ou modifié'));
    }
    for (const l of lignesDuPatch(f.patch).ajoutees) {
      if (SECRET_LITTERAL.some((motif) => motif.test(l))) {
        // La valeur n'est jamais recopiée dans le message : un rapport de CI ne doit pas republier le secret.
        raisons.push(violation('secrets', nom, 'valeur qui ressemble à un secret en clair (ligne ajoutée)'));
      }
    }
  }
  return raisons;
}

/** Instructions SQL des lignes ajoutées : commentaires de ligne et de bloc retirés, coupées sur le point-virgule. */
function instructionsSql(ajoutees) {
  const sansLigneCommentee = ajoutees.filter((l) => !l.trim().startsWith('--')).join('\n');
  return sansLigneCommentee
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Contrôle 3 : aucune migration destructive (SQL ajouté ou modifié ; migration existante réécrite ou supprimée). */
export function controleMigrations(fichiers) {
  const raisons = [];
  for (const f of fichiers) {
    const nom = f.filename;
    if (!EST_SQL.test(nom)) continue;
    if (EST_MIGRATION.test(nom) && (f.status === 'modified' || f.status === 'removed' || f.status === 'renamed')) {
      raisons.push(violation('migrations', nom, 'migration existante modifiée ou supprimée (l’historique ne se réécrit pas)'));
    }
    if (f.status === 'removed') continue;
    for (const instruction of instructionsSql(lignesDuPatch(f.patch).ajoutees)) {
      const trouve = SQL_DESTRUCTIF.find(([motif]) => motif.test(instruction));
      if (trouve) {
        raisons.push(violation('migrations', nom, `migration destructive (${trouve[1]}) : ${abreger(instruction)}`));
      } else if (/\bDELETE\s+FROM\b/i.test(instruction) && !/\bWHERE\b/i.test(instruction)) {
        raisons.push(violation('migrations', nom, `migration destructive (DELETE FROM sans WHERE) : ${abreger(instruction)}`));
      }
    }
  }
  return raisons;
}

/** Verdict complet. `fichiers` = sortie de `parserDiff` (ou liste de l'API GitHub : filename, status, patch). */
export function verifier(fichiers) {
  const raisons = [...controleTests(fichiers), ...controleSecrets(fichiers), ...controleMigrations(fichiers)];
  return { verdict: raisons.length === 0 ? 'vert' : 'rouge', raisons };
}

/** Texte du rapport (résumé d'étape GitHub). */
export function rapport({ verdict, raisons }) {
  if (verdict === 'vert') return 'Verrous : vert. Aucun test retiré ou sauté, aucun secret en clair, aucune migration destructive.';
  const lignes = [`Verrous : ROUGE (${raisons.length} raison${raisons.length > 1 ? 's' : ''}).`];
  for (const r of raisons) lignes.push(`- [${r.controle}] ${r.fichier} : ${r.detail}`);
  return lignes.join('\n');
}

// ── Entrées/sorties ──────────────────────────────────────────────────────────────

function main() {
  const base = process.env.VERROUS_BASE || (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : '');
  if (!base) {
    console.log('Verrous : pas de branche de base (hors PR), rien à comparer. Aucun verdict rendu.');
    return 0;
  }
  const texte = execFileSync(
    'git',
    ['-c', 'core.quotepath=off', 'diff', '--no-color', '--no-ext-diff', '-U0', '-M', `${base}...HEAD`],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  const resultat = verifier(parserDiff(texte));
  const sortie = rapport(resultat);
  console.log(sortie);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${sortie}\n`);
  for (const r of resultat.raisons) console.log(`::error title=Verrous ${r.controle}::${r.fichier} : ${r.detail}`);
  return resultat.verdict === 'vert' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main());
  } catch (erreur) {
    console.error(`Verrous : erreur, donc rouge (échec fermé) : ${erreur.message}`);
    process.exit(1);
  }
}
