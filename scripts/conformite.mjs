// Grille de conformité des dépôts, appelée par .github/workflows/conformite.yml (workflow commun).
// La grille (15 lignes) est celle du plan de standardisation du 15/10/2026 : `docs/conformite.md` la décrit
// ligne par ligne, avec ce que chaque contrôle lit. Aucune dépendance : Node 24.
//
// Quatre états, jamais un faux vert :
//   vert            tous les sous-contrôles passent.
//   rouge           un sous-contrôle échoue (la cause est dite).
//   sans-objet      la ligne ne concerne pas ce dépôt (une bibliothèque n'a ni Vercel ni Sentry).
//   non-verifiable  la CI ne peut pas lire l'information (réglage réservé aux administrateurs, sauvegarde
//                   qui vit sur le PC) : à relire à la main, jamais déclaré vert.
//
// Fonctions pures d'un côté (`evaluer`, une photo du dépôt en entrée), E/S de l'autre (`main`).
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const TITRES = {
  1: 'Dépôt public, branche par défaut protégée',
  2: 'CI sur machines GitHub, timeouts, aucun paths: exigé',
  3: 'Gate : typecheck, lint, tests, build',
  4: 'Couverture mesurée, cliquet',
  5: 'Fumée après chaque déploiement de production',
  6: 'Sécurité : audit, Dependabot, secrets, CodeQL, OSV',
  7: 'Versions : Next 16, React 19, TS 5.9 strict, Node 24, vitest 5, zod 4, contrat à jour',
  8: 'Vercel : production seule, aucune préversion',
  9: 'Sentry, /api/sante, surveillance',
  10: 'Base : migrations au démarrage, sauvegarde',
  11: 'Docs : CLAUDE.md ≤ 60 lignes, HANDOVER, adr, BACKLOG réduit, COMPTE-RENDU',
  12: 'Socle visuel : variables, clair/sombre',
  13: 'Actions GitHub épinglées par SHA',
  14: 'Aucun cron Vercel plus fréquent que par jour',
  15: 'Commits et titres de PR préfixés',
};

const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const PREFIXE_COMMIT = /^(?:(?:feat|fix|docs|refactor|chore|test|ci|perf|build|style|revert)(?:\([^)]+\))?!?: |\[[^\]]+\] |HORS-BACKLOG: )/i;
const FUSION = /^Merge (?:pull request|branch)\b/;
const MACHINE_GITHUB = /ubuntu-|macos-|windows-/;

const ok = (texte) => ({ ok: true, texte });
const ko = (texte) => ({ ok: false, texte });
const inconnu = (texte) => ({ ok: null, texte });

/** Une ligne de la grille : des sous-contrôles → un état. */
const ligne = (n, sous) => {
  const etat = sous.some((s) => s.ok === false) ? 'rouge' : sous.some((s) => s.ok === null) ? 'non-verifiable' : 'vert';
  return { n, titre: TITRES[n], etat, details: sous };
};
const sansObjet = (n, raison) => ({ n, titre: TITRES[n], etat: 'sans-objet', details: [{ ok: null, texte: raison }] });

const json = (texte) => {
  if (texte == null) return undefined;
  try {
    return JSON.parse(texte);
  } catch {
    try {
      // tsconfig : commentaires et virgules finales tolérés.
      return JSON.parse(texte.replace(/(^|[\s,{[])\/\/[^\n]*$/gm, '$1').replace(/,(\s*[}\]])/g, '$1'));
    } catch {
      return undefined;
    }
  }
};

/** Chemins des scripts du dépôt qu'une commande lance avec `node` (`node scripts/x.mjs && next build` → ['scripts/x.mjs']), sans `./` ni sortie du dossier. */
export function scriptsAppeles(commande) {
  const chemins = [];
  for (const m of String(commande).matchAll(/\bnode\s+(?:--?[\w=.-]+\s+)*(\S+\.[cm]?[jt]s)\b/g)) {
    const chemin = m[1].replace(/^\.\//, '');
    if (!chemin.startsWith('/') && !chemin.split('/').includes('..') && !chemins.includes(chemin)) chemins.push(chemin);
  }
  return chemins;
}

/** Découpe un workflow en jobs (blocs à 2 espaces sous `jobs:`) : [{ nom, bloc }]. */
/**
 * Sombre seul VOULU : `color-scheme: dark` déclaré à la racine (`:root`, `html` ou `body`) d'une règle de premier
 * niveau. Une règle dans un `@media`, ou sur un composant (`.terminal { color-scheme: dark }`), ne compte pas : le
 * thème sombre d'une app qui garde un mode clair se prouve par `prefers-color-scheme` ou `data-theme`, pas par ceci.
 */
export function sombreSeulDeclare(css) {
  const texte = String(css ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
  let profondeur = 0;
  let debut = 0;
  let prelude = '';
  for (let i = 0; i < texte.length; i++) {
    const c = texte[i];
    if (c === '{') {
      if (profondeur === 0) prelude = texte.slice(debut, i).trim();
      profondeur++;
      debut = i + 1;
    } else if (c === '}') {
      profondeur = Math.max(0, profondeur - 1);
      if (profondeur === 0) {
        const corps = texte.slice(debut, i);
        const racine = prelude.split(',').every((sel) => /^(?::root|html|body)$/.test(sel.trim()));
        if (racine && /(^|[;\s])color-scheme\s*:\s*dark\s*(;|$)/.test(corps)) return true;
        debut = i + 1;
      }
    }
  }
  return false;
}

export function jobsDe(texte) {
  const debut = texte.search(/^jobs:\s*$/m);
  if (debut < 0) return [];
  const lignes = texte.slice(debut).split('\n').slice(1);
  const jobs = [];
  for (const l of lignes) {
    const m = l.match(/^ {2}([A-Za-z0-9_-]+):\s*(?:#.*)?$/);
    if (m) jobs.push({ nom: m[1], bloc: '' });
    else if (jobs.length) jobs[jobs.length - 1].bloc += `${l}\n`;
  }
  return jobs;
}

/** Les cinq champs d'un cron : « une fois par jour au plus » = minute ET heure fixes. */
export function cronQuotidien(expr) {
  const [minute, heure] = String(expr).trim().split(/\s+/);
  return /^\d+$/.test(minute ?? '') && /^\d+$/.test(heure ?? '');
}

const majeure = (v) => Number.parseInt(String(v ?? '').replace(/^[^\d]*/, ''), 10);
const mineure = (v) => Number.parseInt(String(v ?? '').split('.')[1], 10);

/**
 * @param {object} ctx photo du dépôt :
 *   fichiers: string[] (chemins relatifs à la racine du dépôt) · lire(chemin) → string|null
 *   racine: dossier de l'app ('.' ou 'web') · depot: { nom, prive, branche, securite } | null
 *   protection: { protegee, verifs } | null · tagContrat: string|null · commits: [{ message, parents }]|null
 *   titrePr: string|null
 */
export function evaluer(ctx) {
  const { fichiers, lire, racine = '.', depot, protection, tagContrat, commits, titrePr, surveilles = [] } = ctx;
  const sous = (chemin) => (racine === '.' ? chemin : `${racine}/${chemin}`);
  const existe = (chemin) => fichiers.includes(chemin);
  const pkg = json(lire(sous('package.json')));
  const verrou = json(lire(sous('package-lock.json')));
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const workflows = fichiers.filter((f) => WORKFLOW.test(f));
  const textes = workflows.map((f) => ({ f, t: lire(f) ?? '' }));
  const tousWorkflows = textes.map((x) => x.t).join('\n');
  const vercel = json(lire(sous('vercel.json')));
  const estApp = Boolean(deps.next || deps.vite || deps.react) || vercel !== undefined;
  const aBase = Boolean(deps['drizzle-orm'] || deps['@neondatabase/serverless'] || deps.pg || deps.postgres);
  const resultats = [];

  // 1. Public + branche protégée
  {
    const s = [];
    if (depot?.prive === undefined || depot?.prive === null) s.push(inconnu('visibilité illisible (API)'));
    else s.push(depot.prive ? ko('dépôt privé') : ok('dépôt public'));
    if (!protection) s.push(inconnu('protection de la branche illisible (API)'));
    else if (!protection.protegee) s.push(ko(`branche ${depot?.branche ?? 'par défaut'} non protégée`));
    else if (!protection.verifs?.length) s.push(ko('branche protégée mais sans contrôle exigé'));
    else s.push(ok(`branche protégée, ${protection.verifs.length} contrôle(s) exigé(s)`));
    resultats.push(ligne(1, s));
  }

  // 2. CI : machines GitHub, timeouts, pas de paths:
  {
    const s = [];
    if (!workflows.length) s.push(ko('aucun workflow'));
    const horsGithub = [];
    const sansTimeout = [];
    const avecPaths = [];
    for (const { f, t } of textes) {
      for (const m of t.matchAll(/^\s*runs-on:\s*(.+)$/gm)) {
        if (!MACHINE_GITHUB.test(m[1])) horsGithub.push(f);
      }
      for (const j of jobsDe(t)) {
        if (!/^ {4}(?:timeout-minutes|uses):/m.test(j.bloc)) sansTimeout.push(`${f.split('/').pop()}:${j.nom}`);
      }
      const entete = t.slice(0, t.search(/^jobs:\s*$/m) < 0 ? t.length : t.search(/^jobs:\s*$/m));
      if (/^\s*pull_request\b/m.test(entete) && /^\s+paths(?:-ignore)?:/m.test(entete)) avecPaths.push(f);
    }
    if (workflows.length) {
      s.push(horsGithub.length ? ko(`runs-on sans machine GitHub : ${[...new Set(horsGithub)].join(', ')}`) : ok('toutes les machines sont GitHub'));
      s.push(sansTimeout.length ? ko(`job sans timeout-minutes : ${sansTimeout.join(', ')}`) : ok('timeout-minutes sur chaque job'));
      s.push(avecPaths.length ? ko(`paths: sur un déclencheur de PR : ${avecPaths.join(', ')}`) : ok('aucun paths: sur les PR'));
    }
    resultats.push(ligne(2, s));
  }

  // 3. Gate
  {
    const s = [];
    if (!pkg) s.push(ko('package.json introuvable'));
    else {
      for (const nom of ['typecheck', 'lint', 'test', 'build']) {
        if (!pkg.scripts?.[nom]) s.push(ko(`script « ${nom} » absent de package.json`));
        else {
          const lance = nom === 'test' ? /npm (?:run )?test\b/.test(tousWorkflows) : new RegExp(`npm run ${nom}\\b`).test(tousWorkflows);
          s.push(lance ? ok(`« ${nom} » existe et la CI le lance`) : ko(`« ${nom} » existe mais aucun workflow ne le lance`));
        }
      }
    }
    resultats.push(ligne(3, s));
  }

  // 4. Couverture au cliquet
  {
    const seuils = json(lire(existe(sous('qualite/seuils.json')) ? sous('qualite/seuils.json') : 'qualite/seuils.json'));
    const cles = Object.keys(seuils?.portes ?? {}).filter((k) => k.startsWith('couverture.'));
    resultats.push(ligne(4, [cles.length ? ok(`seuils de couverture au cliquet : ${cles.join(', ')}`) : ko('aucun seuil « couverture.* » dans qualite/seuils.json')]));
  }

  // 5. Fumée
  if (!estApp) resultats.push(sansObjet(5, 'pas une app déployée'));
  else {
    const appelle = /MoKarade\/\.github\/\.github\/workflows\/fumee\.yml@/.test(tousWorkflows);
    resultats.push(ligne(5, [appelle ? ok('appelle fumee.yml') : ko('n’appelle pas le workflow commun fumee.yml')]));
  }

  // 6. Sécurité
  {
    const s = [];
    const commun = /MoKarade\/\.github\/\.github\/workflows\/securite\.yml@/.test(tousWorkflows);
    if (commun) s.push(ok('appelle securite.yml (gitleaks, OSV-Scanner, CodeQL)'));
    else {
      for (const [nom, motif] of [['gitleaks', /gitleaks/i], ['CodeQL', /codeql/i], ['OSV-Scanner', /osv-scanner/i]]) {
        const autre = nom === 'CodeQL' && /semgrep/i.test(tousWorkflows) ? ' (Semgrep est présent, mais la grille demande CodeQL)' : '';
        s.push(motif.test(tousWorkflows) ? ok(`${nom} présent`) : ko(`${nom} absent des workflows${autre}`));
      }
    }
    s.push(existe('.github/dependabot.yml') ? ok('Dependabot configuré') : ko('.github/dependabot.yml absent'));
    s.push(/npm audit\b/.test(tousWorkflows) ? ok('npm audit lancé en CI') : ko('aucun « npm audit » en CI'));
    const sa = depot?.securite;
    if (!sa) s.push(inconnu('scan de secrets et protection au push : réglage réservé aux administrateurs, à relire à la main'));
    else {
      s.push(sa.secret_scanning?.status === 'enabled' ? ok('scan de secrets activé') : ko('scan de secrets désactivé'));
      s.push(sa.secret_scanning_push_protection?.status === 'enabled' ? ok('protection au push activée') : ko('protection au push désactivée'));
    }
    resultats.push(ligne(6, s));
  }

  // 7. Versions
  {
    const s = [];
    const installee = (nom) => verrou?.packages?.[`node_modules/${nom}`]?.version ?? null;
    const exige = (nom, min, libelle = nom) => {
      if (!deps[nom]) return null;
      const v = installee(nom) ?? deps[nom];
      return majeure(v) >= min ? ok(`${libelle} ${v}`) : ko(`${libelle} ${v} (attendu ≥ ${min})`);
    };
    for (const [nom, min] of [['next', 16], ['react', 19], ['vitest', 5], ['zod', 4]]) {
      const r = exige(nom, min);
      if (r) s.push(r);
    }
    if (deps.typescript) {
      const v = installee('typescript') ?? deps.typescript;
      s.push(majeure(v) > 5 || (majeure(v) === 5 && mineure(v) >= 9) ? ok(`typescript ${v}`) : ko(`typescript ${v} (attendu ≥ 5.9)`));
      const ts = json(lire(sous('tsconfig.json')));
      if (ts === undefined) s.push(inconnu('tsconfig.json illisible'));
      else s.push(ts.compilerOptions?.strict === true ? ok('TypeScript strict') : ko('tsconfig sans "strict": true'));
    }
    const nvmrc = (lire(sous('.nvmrc')) ?? lire('.nvmrc') ?? '').trim();
    const moteur = pkg?.engines?.node;
    if (nvmrc || moteur) s.push(majeure(nvmrc) === 24 || /24/.test(moteur ?? '') ? ok(`Node ${nvmrc || moteur}`) : ko(`Node ${nvmrc || moteur} (attendu 24)`));
    else if (estApp || pkg) s.push(ko('version de Node non déclarée (.nvmrc ou engines)'));
    const contrat = deps['@mokarade/hub-contract'];
    if (contrat) {
      const tag = String(contrat).match(/#(v[\d.]+)$/)?.[1];
      if (!tagContrat) s.push(inconnu(`contrat hub ${tag ?? contrat} : dernier tag illisible (API)`));
      else s.push(tag === tagContrat ? ok(`contrat hub ${tag} (dernier tag)`) : ko(`contrat hub ${tag ?? contrat}, dernier tag ${tagContrat}`));
    }
    resultats.push(s.length ? ligne(7, s) : sansObjet(7, 'aucune dépendance suivie'));
  }

  // 8. Vercel production seule
  if (!estApp) resultats.push(sansObjet(8, 'pas une app déployée'));
  else if (vercel === undefined) resultats.push(ligne(8, [ko('vercel.json absent ou illisible')]));
  else {
    const de = vercel.git?.deploymentEnabled;
    const branche = depot?.branche ?? 'main';
    if (!de || typeof de !== 'object') resultats.push(ligne(8, [ko('git.deploymentEnabled absent : les préversions se déploient')]));
    else {
      const autres = Object.entries(de).filter(([k]) => k !== branche && de[k] !== false);
      resultats.push(
        ligne(8, [
          de[branche] === true ? ok(`seule « ${branche} » se déploie`) : ko(`« ${branche} » non explicitement activée`),
          autres.length ? ko(`branches encore déployées : ${autres.map(([k]) => k).join(', ')}`) : ok('aucune autre branche déployée'),
          de['*'] === false || de['**'] === false ? ok('le motif générique est désactivé') : ko('aucun motif générique « * » désactivé : une nouvelle branche se déploierait'),
        ]),
      );
    }
  }

  // 9. Sentry, santé, surveillance
  if (!estApp) resultats.push(sansObjet(9, 'pas une app déployée'));
  else {
    // Next.js : app/api/sante/route.* ; app Vite (FinanceAI) : fonction Vercel api/sante.[cm]?[jt]s à la racine
    const sante = fichiers.some((f) => /(^|\/)app\/api\/sante\/route\.[cm]?[jt]sx?$/.test(f) || /^api\/sante\.[cm]?[jt]s$/.test(f));
    resultats.push(
      ligne(9, [
        Object.keys(deps).some((d) => d.startsWith('@sentry/')) ? ok('Sentry en dépendance') : ko('aucune dépendance @sentry/*'),
        sante ? ok('route /api/sante présente') : ko('route /api/sante absente'),
        surveilles.some((nom) => nom.toLowerCase() === String(depot.nom ?? '').toLowerCase())
          ? ok('figure dans la surveillance')
          : ko('absent de surveillance/apps.json de MoKarade/.github (ou route /api/sante pas encore branchée)'),
      ]),
    );
  }

  // 10. Base
  if (!aBase) resultats.push(sansObjet(10, 'pas de base de données'));
  else {
    const vb = pkg?.scripts?.['vercel-build'] ?? '';
    // vercel-build peut déléguer à un script du dépôt (`node scripts/vercel-build.mjs`) : db:migrate s'y cherche aussi.
    const delegues = scriptsAppeles(vb);
    const dansDelegue = delegues.some((chemin) => /db:migrate/.test(lire(sous(chemin)) ?? ''));
    const migre = fichiers.some((f) => /(^|\/)lib\/migrations\.[jt]s$/.test(f)) || /db:migrate/.test(vb) || dansDelegue;
    const raison = delegues.length ? `ni lib/migrations.ts ni db:migrate dans vercel-build (ni dans ${delegues.join(', ')})` : 'ni lib/migrations.ts ni db:migrate dans vercel-build';
    resultats.push(ligne(10, [migre ? ok('migrations automatiques') : ko(raison), inconnu('sauvegarde de la nuit : elle vit sur le PC, à relire à la main')]));
  }

  // 11. Docs
  {
    const s = [];
    const claude = lire('CLAUDE.md');
    if (claude == null) s.push(ko('CLAUDE.md absent'));
    else {
      const n = claude.replace(/\n$/, '').split('\n').length;
      s.push(n <= 60 ? ok(`CLAUDE.md : ${n} lignes`) : ko(`CLAUDE.md : ${n} lignes (60 au plus)`));
    }
    s.push(existe('HANDOVER.md') ? ok('HANDOVER.md présent') : ko('HANDOVER.md absent'));
    s.push(fichiers.some((f) => f.startsWith('docs/adr/')) ? ok('docs/adr/ présent') : ko('docs/adr/ absent'));
    const backlog = lire('BACKLOG.md');
    if (backlog == null) s.push(ko('BACKLOG.md absent (il doit renvoyer aux issues)'));
    else {
      const n = backlog.replace(/\n$/, '').split('\n').length;
      s.push(n <= 20 && /issues/i.test(backlog) ? ok('BACKLOG.md réduit au renvoi vers les issues') : ko(`BACKLOG.md : ${n} lignes${/issues/i.test(backlog) ? '' : ', sans renvoi vers les issues'} (20 au plus, et un renvoi vers les issues)`));
    }
    s.push(existe('docs/COMPTE-RENDU.md') ? ok('docs/COMPTE-RENDU.md présent') : ko('docs/COMPTE-RENDU.md absent'));
    resultats.push(ligne(11, s));
  }

  // 12. Socle visuel
  {
    const css = lire(sous('app/globals.css'));
    if (!estApp || css == null) resultats.push(sansObjet(12, 'pas d’écran'));
    else {
      resultats.push(
        ligne(12, [
          /--[\w-]+\s*:/.test(css) ? ok('couleurs en variables CSS') : ko('aucune variable CSS dans globals.css'),
          /prefers-color-scheme\s*:\s*dark|data-theme/.test(css)
            ? ok('thème sombre prévu')
            : sombreSeulDeclare(css)
              ? ok('sombre seul voulu (color-scheme: dark à la racine)')
              : ko('aucun thème sombre dans globals.css (ni sombre seul déclaré par color-scheme: dark à la racine)'),
          fichiers.some((f) => /(^|\/)tests\/theme\.test\.[jt]sx?$/.test(f)) ? ok('verrou tests/theme.test') : ko('verrou tests/theme.test absent'),
        ]),
      );
    }
  }

  // 13. Actions épinglées par SHA (l'appel d'un workflow commun de MoKarade/.github reste en @main, voulu)
  {
    const mal = [];
    for (const { f, t } of textes) {
      for (const m of t.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)) {
        const ref = m[1];
        if (ref.startsWith('./') || ref.startsWith('docker://')) continue;
        if (/^MoKarade\/\.github\/\.github\/workflows\/[^@]+@main$/.test(ref)) continue;
        if (!/@[0-9a-f]{40}$/.test(ref)) mal.push(`${f.split('/').pop()} : ${ref}`);
      }
    }
    resultats.push(ligne(13, [mal.length ? ko(`non épinglées : ${mal.slice(0, 6).join(' ; ')}${mal.length > 6 ? ` (+${mal.length - 6})` : ''}`) : ok('toutes les actions sont épinglées par SHA')]));
  }

  // 14. Crons
  if (vercel === undefined) resultats.push(sansObjet(14, 'pas de vercel.json'));
  else {
    const crons = Array.isArray(vercel.crons) ? vercel.crons : [];
    const trop = crons.filter((c) => !cronQuotidien(c.schedule));
    resultats.push(ligne(14, [trop.length ? ko(`cron plus fréquent que par jour : ${trop.map((c) => c.schedule).join(', ')}`) : ok(crons.length ? 'crons au plus quotidiens' : 'aucun cron Vercel')]));
  }

  // 15. Préfixes
  {
    const s = [];
    if (!commits) s.push(inconnu('historique illisible (API)'));
    else {
      const recents = commits.filter((c) => c.parents <= 1 && !FUSION.test(c.message)).slice(0, 10);
      const faux = recents.filter((c) => !PREFIXE_COMMIT.test(c.message));
      s.push(faux.length ? ko(`${faux.length} commit(s) sans préfixe parmi les ${recents.length} derniers : « ${faux[0].message.slice(0, 60)} »`) : ok(`${recents.length} derniers commits préfixés`));
    }
    if (titrePr != null) s.push(PREFIXE_COMMIT.test(titrePr) ? ok('titre de la PR préfixé') : ko(`titre de PR sans préfixe : « ${titrePr.slice(0, 60)} »`));
    resultats.push(ligne(15, s));
  }

  return resultats;
}

const ICONE = { vert: 'vert', rouge: 'ROUGE', 'sans-objet': 'sans objet', 'non-verifiable': 'à relire' };

export function tableau(resultats, depot) {
  const compte = (e) => resultats.filter((r) => r.etat === e).length;
  const lignes = resultats.map((r) => {
    const faits = r.details
      .filter((d) => d.ok !== true)
      .map((d) => d.texte)
      .join(' ; ');
    return `| ${r.n} | ${r.titre} | ${ICONE[r.etat]} | ${r.etat === 'vert' ? '' : faits} |`;
  });
  return [
    `### Conformité de ${depot}`,
    '',
    `${compte('vert')} vert · ${compte('rouge')} rouge · ${compte('non-verifiable')} à relire · ${compte('sans-objet')} sans objet`,
    '',
    '| # | Ligne de la grille | État | Détail |',
    '|---|---|---|---|',
    ...lignes,
    '',
  ].join('\n');
}

// ── Entrées / sorties ────────────────────────────────────────────────────────────────────────────────
function lireApi(chemin) {
  const jeton = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  try {
    if (jeton) {
      const sortie = execFileSync('curl', ['-sS', '-f', '-H', `authorization: Bearer ${jeton}`, '-H', 'accept: application/vnd.github+json', `https://api.github.com/${chemin}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return JSON.parse(sortie);
    }
    return JSON.parse(execFileSync('gh', ['api', chemin], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return null;
  }
}

/** Dépôts sondés par la surveillance : la liste vit dans MoKarade/.github (surveillance/apps.json), à côté de ce script. */
function surveillees() {
  try {
    const apps = JSON.parse(readFileSync(new URL('../surveillance/apps.json', import.meta.url), 'utf8'));
    return apps.filter((a) => a.sante && a.depot).map((a) => a.depot);
  } catch {
    return [];
  }
}

export function contexteDepuisDisque(dossier, nomDepot, env = process.env) {
  const fichiers = execFileSync('git', ['-C', dossier, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const lire = (chemin) => {
    try {
      return readFileSync(join(dossier, chemin), 'utf8');
    } catch {
      return null;
    }
  };
  const infos = lireApi(`repos/${nomDepot}`);
  const branche = infos?.default_branch ?? env.CONFORMITE_BRANCHE ?? 'main';
  const prot = lireApi(`repos/${nomDepot}/branches/${branche}`);
  const regles = lireApi(`repos/${nomDepot}/rules/branches/${branche}`);
  const tags = lireApi('repos/MoKarade/hub-contract/tags');
  const lesCommits = lireApi(`repos/${nomDepot}/commits?sha=${branche}&per_page=30`);
  const verifs = [
    ...(prot?.protection?.required_status_checks?.contexts ?? []),
    ...(Array.isArray(regles) ? regles.filter((r) => r.type === 'required_status_checks') : []),
  ];
  return {
    fichiers,
    lire,
    surveilles: surveillees(),
    racine: env.CONFORMITE_RACINE || '.',
    depot: infos ? { nom: nomDepot, prive: infos.private, branche, securite: infos.security_and_analysis ?? null } : { nom: nomDepot, branche },
    protection: prot ? { protegee: Boolean(prot.protected) || (Array.isArray(regles) && regles.length > 0), verifs } : null,
    tagContrat: Array.isArray(tags) ? (tags.map((t) => t.name).filter((n) => /^v\d+\.\d+\.\d+$/.test(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1) ?? null) : null,
    commits: Array.isArray(lesCommits) ? lesCommits.map((c) => ({ message: c.commit.message.split('\n')[0], parents: c.parents.length })) : null,
    titrePr: env.CONFORMITE_TITRE_PR || null,
  };
}

function main() {
  const dossier = process.argv[2] || '.';
  const nomDepot = process.argv[3] || process.env.GITHUB_REPOSITORY;
  if (!nomDepot) {
    console.error('Usage : conformite.mjs <dossier> <proprietaire/depot>   (ou GITHUB_REPOSITORY)');
    process.exit(2);
  }
  const resultats = evaluer(contexteDepuisDisque(dossier, nomDepot));
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(resultats, null, 2));
    return;
  }
  const texte = tableau(resultats, nomDepot);
  console.log(texte);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${texte}\n`);
  const rouges = resultats.filter((r) => r.etat === 'rouge');
  for (const r of rouges) console.log(`::warning title=Conformité ligne ${r.n}::${r.titre}`);
  if (process.env.CONFORMITE_BLOQUANT === 'true' && rouges.length) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
