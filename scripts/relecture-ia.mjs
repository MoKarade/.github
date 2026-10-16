#!/usr/bin/env node
// Relecture IA des PR dont le Garde-fou est rouge pour une raison que le jugement peut trancher
// (choix de Marc, 16/10/2026, carte « Action Claude »). Trois commandes, lancées dans cet ordre par
// .github/workflows/relecture-ia.yml (le jeton Claude et le jeton GitHub ne sont JAMAIS dans la
// même étape : l'IA n'a aucun outil et aucun jeton GitHub, elle lit un texte et répond une ligne) :
//   preparer : parcourt les PR ouvertes des dix dépôts, écrit un dossier JSON par PR à relire ;
//   consigne <dossier.json> : écrit sur la sortie la consigne à remettre à l'IA ;
//   publier  : lit les réponses, pose le statut « Relecture IA » sur le commit, commente la PR et,
//              si l'IA approuve, rejoue le Garde-fou (qui lit le statut, voir garde-fou.mjs).
// Ce que l'IA peut lever est écrit dans relecture-regles.mjs, et seulement là.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluer } from './garde-fou.mjs';
import {
  CONTEXTE,
  composerConsigne,
  composerDossier,
  fichiersAlire,
  lireVerdict,
  toutesSurmontables,
} from './relecture-regles.mjs';

export const DEPOTS = [
  '.github',
  'app-template',
  'batchchef-',
  'CarAI',
  'DriveAI',
  'FinanceAI',
  'hub-contract',
  'Hubperso',
  'JobAI',
  'MemoryAI',
];
const PROPRIETAIRE = 'MoKarade';
const MAX_PAR_PASSE = 5; // une passe ne relit jamais plus de PR que cela : les autres attendent dix minutes
export const MARQUEUR = '<!-- relecture-ia -->';

/** Lit les chemins protégés du dépôt dans son propre garde-fou.yml (une seule source de vérité). */
export function lireProteges(yaml) {
  const m = /CHEMINS_PROTEGES:\s*'((?:[^']|'')*)'/.exec(yaml ?? '');
  return m ? new RegExp(m[1].replaceAll("''", "'")) : null;
}

/**
 * Garde-fou rouge sur ce commit ? Prend la dernière exécution du workflow garde-fou.yml (l'API des
 * exécutions demande le droit Actions, déjà accordé ; celle des contrôles demanderait « Checks »).
 */
export function gardeFouRouge(executions) {
  const derniere = [...(executions ?? [])].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
  return derniere?.status === 'completed' && derniere.conclusion === 'failure';
}

// ── Entrées/sorties ──────────────────────────────────────────────────────────────

function client(jeton) {
  return async function api(methode, chemin, corps, accept = 'application/vnd.github+json') {
    const reponse = await fetch(`https://api.github.com${chemin}`, {
      method: methode,
      headers: {
        Authorization: `Bearer ${jeton}`,
        Accept: accept,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'relecture-ia',
        ...(corps ? { 'Content-Type': 'application/json' } : {}),
      },
      body: corps ? JSON.stringify(corps) : undefined,
    });
    if (reponse.status === 404 && methode === 'GET') return null;
    if (!reponse.ok) throw new Error(`${methode} ${chemin} : HTTP ${reponse.status} ${await reponse.text()}`);
    if (accept.includes('raw')) return reponse.text();
    return reponse.status === 204 ? null : reponse.json();
  };
}

async function pages(api, chemin) {
  const tout = [];
  for (let page = 1; page <= 30; page += 1) {
    const lot = await api('GET', `${chemin}${chemin.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const liste = Array.isArray(lot) ? lot : (lot?.check_runs ?? []);
    tout.push(...liste);
    if (liste.length < 100) break;
  }
  return tout;
}

async function preparer() {
  const { GH_PAT, DOSSIERS } = process.env;
  if (!GH_PAT || !DOSSIERS) throw new Error('GH_PAT et DOSSIERS sont obligatoires (secret RELECTURE_PAT posé ?)');
  const api = client(GH_PAT);
  mkdirSync(DOSSIERS, { recursive: true });
  let ecrits = 0;
  const erreurs = [];

  for (const nom of DEPOTS) {
    const depot = `${PROPRIETAIRE}/${nom}`;
    let proteges = null;
    let ouvertes = [];
    try {
      const yaml = await api('GET', `/repos/${depot}/contents/.github/workflows/garde-fou.yml`, null, 'application/vnd.github.raw+json');
      proteges = lireProteges(yaml);
      if (proteges) ouvertes = await pages(api, `/repos/${depot}/pulls?state=open`);
    } catch (erreur) {
      console.error(`${depot} : erreur. ${erreur.message}`);
      erreurs.push(depot);
      continue;
    }
    if (!proteges) {
      console.log(`${depot} : pas de CHEMINS_PROTEGES lisible dans garde-fou.yml, ignoré`);
      continue;
    }
    for (const pr of ouvertes) {
      // Une erreur sur une PR (droit manquant, panne) ne bloque ni les autres PR ni les autres dépôts :
      // elle est notée, et la dernière étape du job la fait remonter en rouge. Pas de dossier = pas d'avis.
      try {
        if (pr.draft || pr.head.repo?.full_name !== depot) continue; // brouillon ou venue d'ailleurs : jamais relue
        const sha = pr.head.sha;
        const lot = await api('GET', `/repos/${depot}/actions/workflows/garde-fou.yml/runs?head_sha=${sha}&per_page=10`);
        if (!gardeFouRouge(lot?.workflow_runs)) continue;
        const statuts = (await api('GET', `/repos/${depot}/commits/${sha}/statuses?per_page=100`)) ?? [];
        if (statuts.some((s) => s.context === CONTEXTE)) continue; // déjà jugée sur ce commit
        if (ecrits >= MAX_PAR_PASSE) continue;

        const fichiers = await pages(api, `/repos/${depot}/pulls/${pr.number}/files`);
        const contenu = (ref, chemin) =>
          api(
            'GET',
            `/repos/${depot}/contents/${chemin.split('/').map(encodeURIComponent).join('/')}?ref=${ref === 'base' ? pr.base.sha : sha}`,
            null,
            'application/vnd.github.raw+json',
          );
        const { violations } = await evaluer({ fichiers, proteges, contenu });
        if (!toutesSurmontables(violations)) {
          console.log(`${depot}#${pr.number} : relève de Marc (une violation que l'IA ne peut pas lever), ignorée`);
          continue;
        }
        const dossier = composerDossier({
          depot,
          numero: pr.number,
          sha,
          titre: pr.title,
          corps: pr.body,
          violations,
          fichiers: fichiersAlire(violations, fichiers),
        });
        if (!dossier) {
          console.log(`${depot}#${pr.number} : diff absent ou trop gros pour être relu en entier, ignorée`);
          continue;
        }
        writeFileSync(join(DOSSIERS, `${nom}__${pr.number}.json`), JSON.stringify(dossier));
        ecrits += 1;
        console.log(`${depot}#${pr.number} : à relire (${violations.length} violation(s) levable(s))`);
      } catch (erreur) {
        console.error(`${depot}#${pr.number} : erreur. ${erreur.message}`);
        erreurs.push(`${depot}#${pr.number}`);
      }
    }
  }
  writeFileSync(join(DOSSIERS, 'erreurs.txt'), erreurs.join('\n'));
  console.log(`${ecrits} PR à relire`);
}

function consigne(fichier) {
  const dossier = JSON.parse(readFileSync(fichier, 'utf8'));
  process.stdout.write(composerConsigne(dossier, `donnee-${randomBytes(8).toString('hex')}`));
}

async function publier() {
  const { GH_PAT, DOSSIERS, VERDICTS, GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  if (!GH_PAT || !DOSSIERS || !VERDICTS || !GITHUB_RUN_ID) {
    throw new Error('GH_PAT, DOSSIERS, VERDICTS et GITHUB_RUN_ID sont obligatoires');
  }
  const api = client(GH_PAT);
  const urlExecution = `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
  let sansReponse = 0;

  for (const nomFichier of readdirSync(DOSSIERS).filter((f) => f.endsWith('.json'))) {
    const dossier = JSON.parse(readFileSync(join(DOSSIERS, nomFichier), 'utf8'));
    let texte = null;
    try {
      texte = readFileSync(join(VERDICTS, nomFichier.replace(/\.json$/, '.txt')), 'utf8');
    } catch {
      texte = null;
    }
    const verdict = lireVerdict(texte);
    if (!verdict) {
      // Pas de réponse (jeton expiré, panne) : aucun statut, la prochaine passe réessaie, et ce
      // job devient rouge pour que Marc le voie.
      console.error(`${dossier.depot}#${dossier.numero} : aucune réponse de la relecture`);
      sansReponse += 1;
      continue;
    }
    const approuve = verdict.decision === 'approuve';
    await api('POST', `/repos/${dossier.depot}/statuses/${dossier.sha}`, {
      state: approuve ? 'success' : 'failure',
      context: CONTEXTE,
      description: (approuve ? 'Approuvé : ' : 'Refusé : ').concat(verdict.raison).slice(0, 140),
      target_url: urlExecution,
    });
    await api('POST', `/repos/${dossier.depot}/issues/${dossier.numero}/comments`, {
      body: `${MARQUEUR}\n**Relecture IA : ${approuve ? 'approuvée' : 'refusée'}** (commit \`${dossier.sha.slice(0, 7)}\`)\n\n${verdict.raison}\n\n${
        approuve
          ? 'Le Garde-fou est rejoué ; Mergify fusionne ensuite si le reste est vert.'
          : 'La PR attend Marc.'
      }\n\n[Exécution](${urlExecution})`,
    });
    console.log(`${dossier.depot}#${dossier.numero} : ${verdict.decision}`);

    if (approuve) {
      // Rejouer le Garde-fou du commit : il lira le statut et passera au vert.
      const lot = await api('GET', `/repos/${dossier.depot}/actions/workflows/garde-fou.yml/runs?head_sha=${dossier.sha}&per_page=5`);
      const run = lot?.workflow_runs?.[0];
      if (!run) throw new Error(`${dossier.depot}#${dossier.numero} : aucune exécution du Garde-fou à rejouer`);
      await api('POST', `/repos/${dossier.depot}/actions/runs/${run.id}/rerun`);
    }
  }
  let erreurs = '';
  try {
    erreurs = readFileSync(join(DOSSIERS, 'erreurs.txt'), 'utf8').trim();
  } catch {
    erreurs = '';
  }
  if (erreurs) throw new Error(`PR non relues à cause d'une erreur de lecture : ${erreurs.replaceAll('\n', ', ')}`);
  if (sansReponse > 0) throw new Error(`${sansReponse} PR sans réponse de la relecture`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [commande, argument] = process.argv.slice(2);
  const suite =
    commande === 'preparer' ? preparer() : commande === 'consigne' ? consigne(argument) : commande === 'publier' ? publier() : null;
  if (!suite && commande !== 'consigne') {
    console.error('usage : relecture-ia.mjs preparer | consigne <dossier.json> | publier');
    process.exitCode = 2;
  } else {
    Promise.resolve(suite).catch((erreur) => {
      // Échec fermé : une erreur n'est jamais un feu vert.
      console.error(`Relecture IA : erreur. ${erreur.message}`);
      process.exitCode = 1;
    });
  }
}
