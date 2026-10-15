#!/usr/bin/env node
// Garde-fou des chemins protégés (oui écrit de Marc, 15/10/2026, fil « fusion automatique »).
//
// Rôle : une PR qui touche un chemin protégé (.github/, qualite/, vercel.json, drizzle/, .env*, ...)
// ne demande plus Marc SI ce contrôle est vert. Il est rouge quand la PR :
//   1. retire ou saute un test (ou neutralise une étape de test de la CI) ;
//   2. baisse un seuil de qualite/ (ou touche au mécanisme du cliquet) ;
//   3. ajoute ou modifie une référence à un secret ;
//   4. contient une migration destructive (ou réécrit une migration existante) ;
//   5. modifie le garde-fou lui-même (script, workflow, .mergify.yml, CODEOWNERS) : sans cela
//      une PR pourrait desserrer ses propres règles puis se fusionner seule.
// Rouge = la PR attend, un commentaire dit pourquoi et une issue `qui:marc` s'ouvre.
//
// Sûreté : lancé par `pull_request_target`, donc depuis le workflow de la branche par défaut, que
// la PR ne peut pas modifier. Il ne récupère JAMAIS le code de la PR : il lit la liste des
// fichiers et les contenus par l'API GitHub. Échec fermé : toute erreur = rouge.
//
// Fonctions pures (`evaluer` et ce qu'elle appelle) d'un côté, I/O de l'autre : les tests
// (scripts/garde-fou.test.mjs) n'ont besoin ni de réseau ni de jeton.
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MARQUEUR = '<!-- garde-fou -->';

// Le garde-fou ne se modifie pas seul, et la fusion automatique non plus.
const AUTOPROTEGES =
  /(^|\/)(\.mergify\.yml|CODEOWNERS|\.github\/workflows\/[^/]*garde-fou[^/]*\.ya?ml|scripts\/garde-fou[^/]*)$/;

const EST_TEST = /(^|\/)(tests?|__tests__|e2e|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const EST_WORKFLOW = /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/;
const EST_YAML_CI = /(^|\/)\.github\/.+\.ya?ml$/;
const EST_QUALITE = /(^|\/)qualite\/(.+)$/;
const EST_SQL = /(^|\/)(drizzle|migrations?)\/.+\.sql$/;
const EST_PACKAGE = /(^|\/)package\.json$/;
const EST_GITLEAKS = /(^|\/)\.gitleaks(ignore|\.toml)$/;
const EST_ENV = /(^|\/)\.env[^/]*$/;
const ENV_MODELE = /(^|\/)\.env\.(example|sample|template)$/;

const CAS_DE_TEST = /^\s*(?:it|test)\b[.(]/;
const TEST_SAUTE =
  /\b(?:it|test|describe|suite|t)\.(?:skip|skipIf|todo|only|fixme)\b|\bx(?:it|describe|test)\s*\(|\{\s*skip\s*:\s*(?!false)/;
const CI_AFFAIBLIE =
  /continue-on-error:\s*true\b|\|\|\s*(?:true|exit\s+0|:)\s*$|--passWithNoTests|^\s*(?:-\s*)?if:\s*(?:false|\$\{\{\s*false\s*\}\})\s*$|--no-verify/;
const COMMANDE_DE_CONTROLE =
  /\b(?:npm (?:run )?(?:test|typecheck|lint|build|portes)|npx vitest|vitest(?: run)?|node --test|playwright test)\b/;
const SCRIPT_NEUTRE = /^\s*(?:echo\b|true\b|exit\s+0|:\s*$)/;
const SCRIPTS_DE_CONTROLE = ['test', 'typecheck', 'lint', 'build', 'portes'];

const SECRETS_CI = /\bsecrets\.[A-Za-z_]\w*|\bsecrets:\s*inherit\b/;
const NOM_SECRET =
  /(SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|API_?KEY|ACCESS_?KEY|AUTH_?KEY|_KEY$|DATABASE_URL|DSN)/i;
const REF_ENV_CODE =
  /(?:process\.env|import\.meta\.env)\s*(?:\.\s*|\[\s*['"])([A-Z][A-Z0-9_]*)|Deno\.env\.get\(\s*['"]([A-Z][A-Z0-9_]*)/g;
const DEFINITION_ENV = /^\s*#?\s*(?:export\s+)?([A-Za-z][A-Za-z0-9_]*)\s*=/;
const SECRET_LITTERAL =
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bsk-ant-[A-Za-z0-9_-]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAIza[0-9A-Za-z_-]{35}\b/;

const SQL_DESTRUCTIF =
  /\bDROP\s+(?:TABLE|COLUMN|SCHEMA|INDEX|TYPE|CONSTRAINT|VIEW|DATABASE|SEQUENCE)\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bRENAME\s+(?:TO|COLUMN|CONSTRAINT)\b|\bALTER\s+COLUMN\s+\S+\s+(?:SET\s+DATA\s+)?TYPE\b|\bUPDATE\s+\S+\s+SET\b/i;

/** Sépare les lignes ajoutées et retirées d'un patch GitHub (sans en-têtes de fichier). */
export function lignesDuPatch(patch) {
  const ajoutees = [];
  const retirees = [];
  for (const ligne of (patch ?? '').split('\n')) {
    if (ligne.startsWith('+')) ajoutees.push(ligne.slice(1));
    else if (ligne.startsWith('-')) retirees.push(ligne.slice(1));
  }
  return { ajoutees, retirees };
}

/** Écarts entre deux versions de qualite/seuils.json : tout ce qui desserre le cliquet. */
export function compareSeuils(base, tete) {
  const ecarts = [];
  const portesBase = base?.portes ?? {};
  const portesTete = tete?.portes ?? {};
  for (const [cle, bornes] of Object.entries(portesBase)) {
    if (!(cle in portesTete)) {
      ecarts.push(`porte « ${cle} » supprimée`);
      continue;
    }
    for (const [borne, ancienne] of Object.entries(bornes)) {
      const nouvelle = portesTete[cle][borne];
      if (nouvelle === undefined) ecarts.push(`${cle}.${borne} supprimé`);
      else if (borne === 'max' || borne === 'min') {
        const ok =
          typeof nouvelle === 'number' &&
          (borne === 'max' ? nouvelle <= ancienne : nouvelle >= ancienne);
        if (!ok) ecarts.push(`${cle}.${borne} : ${ancienne} → ${nouvelle} (desserré)`);
      } else if (JSON.stringify(nouvelle) !== JSON.stringify(ancienne)) {
        ecarts.push(`${cle}.${borne} modifié`);
      }
    }
  }
  if (JSON.stringify(base?.config) !== JSON.stringify(tete?.config)) {
    ecarts.push('section « config » modifiée (commandes ou périmètre des portes)');
  }
  return ecarts;
}

const abreger = (texte) => {
  const propre = texte.trim().replace(/\s+/g, ' ');
  return propre.length > 90 ? `${propre.slice(0, 87)}...` : propre;
};

function lireJson(texte) {
  try {
    return { json: JSON.parse(texte) };
  } catch (erreur) {
    return { erreur: erreur.message };
  }
}

/**
 * Décide. `fichiers` = liste de l'API GitHub (filename, status, previous_filename, patch,
 * additions, deletions). `proteges` = RegExp des chemins protégés du dépôt.
 * `contenu(ref, chemin)` rend le texte du fichier à 'base' ou 'tete' (null s'il n'existe pas).
 */
export async function evaluer({ fichiers, proteges, contenu }) {
  const concerne = (f) =>
    proteges.test(f.filename) ||
    (f.previous_filename && proteges.test(f.previous_filename)) ||
    AUTOPROTEGES.test(f.filename);
  const concernes = fichiers.filter(concerne).map((f) => f.filename);
  if (concernes.length === 0) return { protege: false, concernes, violations: [] };

  const violations = [];
  const ajouter = (regle, fichier, detail) => violations.push({ regle, fichier, detail });

  const retireesGlobales = [];
  for (const f of fichiers) retireesGlobales.push(...lignesDuPatch(f.patch).retirees);
  const retireesTexte = retireesGlobales.join('\n');

  let casAjoutes = 0;
  let casRetires = 0;
  let commandesAjoutees = 0;
  let commandesRetirees = 0;

  for (const f of fichiers) {
    const nom = f.filename;
    const { ajoutees, retirees } = lignesDuPatch(f.patch);
    const estTest = EST_TEST.test(nom);
    const estSeuils = EST_QUALITE.test(nom);
    const surveille =
      concerne(f) || estTest || estSeuils || EST_SQL.test(nom) || EST_PACKAGE.test(nom);

    // Diff trop gros ou binaire : on ne peut pas le lire, donc on ne peut pas le garantir.
    if (surveille && f.patch === undefined && (f.additions ?? 0) + (f.deletions ?? 0) > 0) {
      ajouter('illisible', nom, 'diff trop gros ou binaire : impossible à contrôler');
    }

    // ── 1. Tests ────────────────────────────────────────────────────────────────
    if (estTest && f.status === 'removed') ajouter('test', nom, 'fichier de test supprimé');
    if (
      f.status === 'renamed' &&
      f.previous_filename &&
      EST_TEST.test(f.previous_filename) &&
      !estTest
    ) {
      ajouter('test', nom, `fichier de test renommé hors des tests (était ${f.previous_filename})`);
    }
    if (estTest) {
      for (const l of ajoutees) {
        if (TEST_SAUTE.test(l)) ajouter('test', nom, `test sauté ou isolé : ${abreger(l)}`);
        if (CAS_DE_TEST.test(l)) casAjoutes += 1;
      }
      for (const l of retirees) if (CAS_DE_TEST.test(l)) casRetires += 1;
    }
    if (EST_WORKFLOW.test(nom)) {
      for (const l of ajoutees) {
        if (CI_AFFAIBLIE.test(l)) ajouter('test', nom, `contrôle de la CI affaibli : ${abreger(l)}`);
        if (COMMANDE_DE_CONTROLE.test(l)) commandesAjoutees += 1;
      }
      for (const l of retirees) if (COMMANDE_DE_CONTROLE.test(l)) commandesRetirees += 1;
    }
    if (EST_PACKAGE.test(nom) && f.status === 'modified') {
      const avant = lireJson((await contenu('base', nom)) ?? 'null');
      const apres = lireJson((await contenu('tete', nom)) ?? 'null');
      if (apres.erreur) ajouter('test', nom, `package.json illisible : ${apres.erreur}`);
      else if (avant.json && apres.json) {
        for (const cle of SCRIPTS_DE_CONTROLE) {
          const ancien = avant.json.scripts?.[cle];
          const nouveau = apres.json.scripts?.[cle];
          if (ancien && (!nouveau || SCRIPT_NEUTRE.test(nouveau))) {
            ajouter('test', nom, `script « ${cle} » supprimé ou vidé`);
          }
        }
      }
    }

    // ── 2. Seuils de qualite/ ───────────────────────────────────────────────────
    if (estSeuils) {
      const base = nom.split('/').pop();
      if (f.status === 'removed') ajouter('seuil', nom, 'fichier de qualite/ supprimé');
      else if (base !== 'seuils.json') {
        ajouter('seuil', nom, 'le mécanisme du cliquet (qualite/) ne se modifie pas seul');
      } else if (f.status === 'modified' || f.status === 'renamed') {
        const avant = lireJson((await contenu('base', f.previous_filename ?? nom)) ?? 'null');
        const apres = lireJson((await contenu('tete', nom)) ?? 'null');
        if (avant.erreur || apres.erreur) {
          ajouter('seuil', nom, `seuils illisibles : ${avant.erreur ?? apres.erreur}`);
        } else if (avant.json && apres.json) {
          for (const ecart of compareSeuils(avant.json, apres.json)) ajouter('seuil', nom, ecart);
        }
      }
    }

    // ── 3. Secrets ──────────────────────────────────────────────────────────────
    if (EST_GITLEAKS.test(nom)) ajouter('secret', nom, 'réglage du scan de secrets modifié');
    if (EST_ENV.test(nom)) {
      if (!ENV_MODELE.test(nom)) {
        ajouter('secret', nom, 'fichier .env versionné modifié');
      } else {
        for (const l of [...ajoutees, ...retirees]) {
          const nomVar = DEFINITION_ENV.exec(l)?.[1];
          if (nomVar && NOM_SECRET.test(nomVar)) {
            ajouter('secret', nom, `variable secrète ajoutée, retirée ou modifiée : ${nomVar}`);
          }
        }
      }
    }
    if (EST_YAML_CI.test(nom)) {
      for (const l of [...ajoutees, ...retirees]) {
        if (SECRETS_CI.test(l)) ajouter('secret', nom, `référence à un secret de la CI : ${abreger(l)}`);
      }
    }
    for (const l of ajoutees) {
      if (SECRET_LITTERAL.test(l)) ajouter('secret', nom, 'valeur qui ressemble à un secret en clair');
      for (const m of l.matchAll(REF_ENV_CODE)) {
        const nomVar = m[1] ?? m[2];
        if (NOM_SECRET.test(nomVar) && !retireesTexte.includes(nomVar)) {
          ajouter('secret', nom, `nouvelle référence à une variable secrète : ${nomVar}`);
        }
      }
    }

    // ── 4. Migrations ───────────────────────────────────────────────────────────
    if (EST_SQL.test(nom)) {
      if (f.status === 'removed' || f.status === 'modified' || f.status === 'renamed') {
        ajouter('migration', nom, 'migration existante modifiée ou supprimée (l’historique ne se réécrit pas)');
      }
      for (const l of ajoutees) {
        if (l.trim().startsWith('--')) continue;
        if (SQL_DESTRUCTIF.test(l)) ajouter('migration', nom, `migration destructive : ${abreger(l)}`);
      }
    }

    // ── 5. Le garde-fou lui-même ────────────────────────────────────────────────
    if (AUTOPROTEGES.test(nom)) {
      ajouter(
        'garde-fou',
        nom,
        'ce fichier fait tenir le garde-fou ou la fusion automatique : il ne se modifie pas seul',
      );
    }
  }

  if (casRetires > casAjoutes) {
    ajouter('test', '(PR)', `moins de cas de test qu'avant : ${casRetires} retirés, ${casAjoutes} ajoutés`);
  }
  if (commandesRetirees > commandesAjoutees) {
    ajouter(
      'test',
      '(workflows)',
      `étapes de contrôle de la CI retirées : ${commandesRetirees} retirées, ${commandesAjoutees} ajoutées`,
    );
  }

  return { protege: true, concernes, violations };
}

const TITRES = {
  test: 'Test retiré ou sauté',
  seuil: 'Seuil de qualité desserré',
  secret: 'Référence à un secret',
  migration: 'Migration destructive',
  'garde-fou': 'Fusion automatique ou garde-fou modifié',
  illisible: 'Diff illisible',
};

export function rapport({ concernes, violations }) {
  if (violations.length === 0) {
    return `Garde-fou : vert. ${concernes.length} fichier(s) protégé(s) touché(s), aucune des règles n'a joué.`;
  }
  const lignes = ['Garde-fou : **rouge**, la PR attend Marc.', ''];
  for (const regle of Object.keys(TITRES)) {
    const liste = violations.filter((v) => v.regle === regle);
    if (liste.length === 0) continue;
    lignes.push(`**${TITRES[regle]}**`);
    for (const v of liste.slice(0, 15)) lignes.push(`- \`${v.fichier}\` : ${v.detail}`);
    if (liste.length > 15) lignes.push(`- ... et ${liste.length - 15} autre(s)`);
    lignes.push('');
  }
  lignes.push('Pour lever : corriger la PR, ou la fusionner à la main si c’est voulu.');
  return lignes.join('\n');
}

// ── Entrées/sorties ──────────────────────────────────────────────────────────────

async function main() {
  const { GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, CHEMINS_PROTEGES } = process.env;
  const dry = process.env.DRY_RUN === '1';
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !PR_NUMBER || !CHEMINS_PROTEGES) {
    throw new Error('GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER et CHEMINS_PROTEGES sont obligatoires');
  }
  const API = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  const proteges = new RegExp(CHEMINS_PROTEGES);

  async function api(methode, chemin, corps, accept = 'application/vnd.github+json') {
    const reponse = await fetch(`${API}${chemin}`, {
      method: methode,
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: accept,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'garde-fou',
        ...(corps ? { 'Content-Type': 'application/json' } : {}),
      },
      body: corps ? JSON.stringify(corps) : undefined,
    });
    if (reponse.status === 404 && methode === 'GET') return null;
    if (!reponse.ok) {
      throw new Error(`${methode} ${chemin} : HTTP ${reponse.status} ${await reponse.text()}`);
    }
    return accept.includes('raw') ? reponse.text() : reponse.status === 204 ? null : reponse.json();
  }

  const pr = await api('GET', `/repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}`);
  const depotTete = pr.head.repo?.full_name;
  if (depotTete !== GITHUB_REPOSITORY) {
    throw new Error(`PR venue d'un autre dépôt (${depotTete}) : refusée par prudence`);
  }

  const numero = Number(PR_NUMBER);
  const titreIssue = `Garde-fou : la PR #${numero} attend un geste de Marc`;
  const issues = (await api('GET', `/repos/${GITHUB_REPOSITORY}/issues?state=open&labels=qui:marc&per_page=100`)) ?? [];
  const issueOuverte = issues.find((i) => !i.pull_request && i.title === titreIssue);
  const fermerIssue = async (message) => {
    await api('POST', `/repos/${GITHUB_REPOSITORY}/issues/${issueOuverte.number}/comments`, { body: message });
    await api('PATCH', `/repos/${GITHUB_REPOSITORY}/issues/${issueOuverte.number}`, {
      state: 'closed',
      state_reason: 'completed',
    });
  };

  // PR fermée ou fusionnée : plus rien à attendre, l'issue du geste se referme.
  if (pr.state === 'closed') {
    console.log('Garde-fou : PR fermée, rien à contrôler.');
    if (issueOuverte && !dry) await fermerIssue('PR fermée ou fusionnée : plus rien à faire.');
    return;
  }

  const fichiers = [];
  for (let page = 1; ; page += 1) {
    const lot = await api('GET', `/repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}/files?per_page=100&page=${page}`);
    fichiers.push(...lot);
    if (lot.length < 100) break;
    if (fichiers.length >= 3000) {
      throw new Error('3000 fichiers ou plus : la liste de l’API est tronquée, impossible à garantir');
    }
  }

  const contenu = (ref, chemin) =>
    api(
      'GET',
      `/repos/${GITHUB_REPOSITORY}/contents/${chemin.split('/').map(encodeURIComponent).join('/')}?ref=${ref === 'base' ? pr.base.sha : pr.head.sha}`,
      null,
      'application/vnd.github.raw+json',
    );

  const resultat = await evaluer({ fichiers, proteges, contenu });
  const texte = resultat.protege
    ? rapport(resultat)
    : 'Garde-fou : rien de protégé dans cette PR, rien à contrôler.';
  console.log(texte);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${texte}\n`);
  if (dry) {
    console.log('(DRY_RUN : rien écrit sur GitHub)');
    process.exitCode = resultat.violations.length > 0 ? 1 : 0;
    return;
  }

  // Commentaire de la PR (un seul, mis à jour) et issue `qui:marc` (une seule par PR).
  const commentaires = [];
  for (let page = 1; ; page += 1) {
    const lot = await api('GET', `/repos/${GITHUB_REPOSITORY}/issues/${numero}/comments?per_page=100&page=${page}`);
    commentaires.push(...lot);
    if (lot.length < 100) break;
  }
  const ancien = commentaires.find((c) => c.body?.includes(MARQUEUR));
  const echec = resultat.violations.length > 0;

  if (echec) {
    const corps = `${MARQUEUR}\n${texte}`;
    if (ancien) await api('PATCH', `/repos/${GITHUB_REPOSITORY}/issues/comments/${ancien.id}`, { body: corps });
    else await api('POST', `/repos/${GITHUB_REPOSITORY}/issues/${numero}/comments`, { body: corps });
    if (!issueOuverte) {
      const issue = await api('POST', `/repos/${GITHUB_REPOSITORY}/issues`, {
        title: titreIssue,
        labels: ['qui:marc'],
        body: `La PR #${numero} touche un chemin protégé et le garde-fou la bloque.\n\n${texte}`,
      });
      await api('POST', `/repos/${GITHUB_REPOSITORY}/issues/${issue.number}/comments`, {
        body: `Geste : ouvrir la PR #${numero}, lire le commentaire du garde-fou, puis la fusionner à la main si c’est voulu. Sinon dire au fil de la corriger.`,
      });
    }
  } else {
    if (ancien) {
      await api('PATCH', `/repos/${GITHUB_REPOSITORY}/issues/comments/${ancien.id}`, {
        body: `${MARQUEUR}\nGarde-fou : vert, le blocage est levé.`,
      });
    }
    if (issueOuverte) await fermerIssue('Levé : le garde-fou est vert, plus rien à faire.');
  }
  process.exitCode = echec ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((erreur) => {
    // Échec fermé : une erreur du contrôle n'est jamais un feu vert.
    console.error(`Garde-fou : erreur, la PR attend. ${erreur.message}`);
    process.exitCode = 1;
  });
}
