#!/usr/bin/env node
// Rapport hebdomadaire de vitesse et de qualité (docs/cycle-de-vie-tache.md §12).
//
// Chaque chiffre est calculé sur l'API GitHub : aucun n'est tapé à la main. Ce qu'on ne peut pas mesurer
// est dit « non mesuré » avec sa raison, jamais remplacé par un zéro ni par une estimation :
//   - dépôts privés (CarAI, DriveAI, MemoryAI) : illisibles avec le jeton du job, jusqu'à leur passage en public ;
//   - Vercel : aucun jeton Vercel dans ce dépôt (les retours en arrière et les délais de mise en ligne y vivent) ;
//   - tests instables : aucune source n'enregistre aujourd'hui qu'un test est instable.
//
// Fonctions pures d'un côté (`calculer`, `rendre`), E/S de l'autre (`collecter`, `main`) : les tests n'ont besoin
// d'aucun réseau. Le CLI `gh` prend le jeton du job ; le code ne lit aucun jeton.
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEPOTS = ['.github', 'app-template', 'batchchef-', 'CarAI', 'DriveAI', 'FinanceAI', 'hub-contract', 'Hubperso', 'JobAI', 'MemoryAI'];
const HEURE = 3_600_000;
const JOUR = 24 * HEURE;
const FUSEAU = 'America/Toronto';

// ---------- utilitaires purs ----------

export const mediane = (nombres) => {
  if (nombres.length === 0) return null;
  const t = [...nombres].sort((a, b) => a - b);
  const m = Math.floor(t.length / 2);
  return t.length % 2 ? t[m] : (t[m - 1] + t[m]) / 2;
};

export function duree(ms) {
  if (ms == null) return '—';
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const heures = Math.floor(minutes / 60);
  if (heures < 48) return `${heures} h ${String(minutes % 60).padStart(2, '0')}`;
  return `${Math.floor(heures / 24)} j ${heures % 24} h`;
}

const jourQuebec = (date) => new Intl.DateTimeFormat('sv-SE', { timeZone: FUSEAU }).format(date);
const temps = (iso) => new Date(iso).getTime();
const etiquette = (o, nom) => o.etiquettes.includes(nom);

export const titreRapport = (debutFenetre) => `Rapport de la semaine du ${jourQuebec(debutFenetre)}`;

/** Le premier lundi du mois (heure du Québec) : la revue de la grille s'ajoute au rapport. */
export const estPremierLundi = (maintenant) => {
  const jour = jourQuebec(maintenant);
  const d = new Date(`${jour}T12:00:00Z`);
  return d.getUTCDay() === 1 && d.getUTCDate() <= 7;
};

// ---------- calcul ----------

/** Rouge puis retour au vert, par workflow : { rouge, retour (ms) | null }. */
export function cycleRouge(runs) {
  const parWorkflow = new Map();
  for (const r of runs) parWorkflow.set(r.nom, [...(parWorkflow.get(r.nom) ?? []), r]);
  let rouge = false;
  const retours = [];
  let nonResolue = false;
  for (const liste of parWorkflow.values()) {
    liste.sort((a, b) => temps(a.creeLe) - temps(b.creeLe));
    const echec = liste.find((r) => r.conclusion === 'failure');
    if (!echec) continue;
    rouge = true;
    const vert = liste.find((r) => r.conclusion === 'success' && temps(r.creeLe) > temps(echec.creeLe));
    if (vert) retours.push(temps(vert.finLe ?? vert.creeLe) - temps(echec.creeLe));
    else nonResolue = true;
  }
  return { rouge, retours, nonResolue };
}

const REF_TACHE = /T[âa]che\s*:\s*(?:MoKarade\/[\w.-]+)?#(\d+)|\bCloses #(\d+)/i;

export function calculer({ depots, maintenant }) {
  const debut = maintenant - 7 * JOUR;
  const dansFenetre = (iso) => iso && temps(iso) >= debut && temps(iso) <= maintenant;
  const lisibles = depots.filter((d) => d.lisible);

  // Vitesse
  const acceptees = [];
  for (const d of lisibles) for (const t of d.taches) if (t.acceptee && dansFenetre(t.fermeLe)) acceptees.push({ ...t, depot: d.nom });
  const delaisAcceptation = acceptees.map((t) => temps(t.fermeLe) - temps(t.creeLe));
  const delaisPreuve = acceptees.filter((t) => t.acceptee.prFusionLe).map((t) => temps(t.acceptee.le) - temps(t.acceptee.prFusionLe));
  const parDepot = Object.fromEntries(lisibles.map((d) => [d.nom, acceptees.filter((t) => t.depot === d.nom).length]));
  const parExecutant = { fil: acceptees.filter((t) => !etiquette(t, 'jules')).length, Jules: acceptees.filter((t) => etiquette(t, 'jules')).length };

  // Qualité
  const retours = [];
  let prRouges = 0;
  let nonResolues = 0;
  for (const d of lisibles) {
    for (const pr of d.prs) {
      if (!dansFenetre(pr.majLe) && !dansFenetre(pr.fusionLe)) continue;
      const c = cycleRouge(pr.runs);
      if (!c.rouge) continue;
      prRouges += 1;
      retours.push(...c.retours);
      if (c.nonResolue) nonResolues += 1;
    }
  }
  const comptes = (nom) => lisibles.reduce((n, d) => n + d.signalements.filter((s) => etiquette(s, nom) && dansFenetre(s.creeLe)).length, 0);

  // Santé du backlog
  const ouvertes = lisibles.flatMap((d) => d.ouvertes.map((o) => ({ ...o, depot: d.nom })));
  const bloquees = ouvertes.filter((o) => etiquette(o, 'bloqué') && maintenant - temps(o.majLe) > 7 * JOUR);
  const gestes = ouvertes.filter((o) => etiquette(o, 'qui:marc')).map((o) => ({ depot: o.depot, numero: o.numero, titre: o.titre, age: maintenant - temps(o.creeLe) }));
  const orphelines = ouvertes.filter((o) => etiquette(o, 'niveau:tâche') && !o.parent);
  const nonProuvees = [];
  for (const d of lisibles) {
    for (const pr of d.prs) {
      if (!pr.fusionLe) continue;
      const m = REF_TACHE.exec(pr.corps ?? '');
      const numero = Number(m?.[1] ?? m?.[2]);
      if (numero && d.ouvertes.some((o) => o.numero === numero)) nonProuvees.push({ depot: d.nom, pr: pr.numero, tache: numero, depuis: maintenant - temps(pr.fusionLe) });
    }
  }
  const preuves = ouvertes.flatMap((o) => {
    const m = /\*\*Preuve attendue\*\*\s*:\s*([^\n]+)/.exec(o.corps ?? '');
    return m ? [{ depot: o.depot, numero: o.numero, quand: m[1].trim() }] : [];
  });

  return {
    fenetre: { debut, fin: maintenant },
    illisibles: depots.filter((d) => !d.lisible).map((d) => d.nom),
    vitesse: {
      acceptees: acceptees.length,
      parDepot,
      parExecutant,
      acceptation: { mediane: mediane(delaisAcceptation), max: delaisAcceptation.length ? Math.max(...delaisAcceptation) : null },
      preuve: {
        n: delaisPreuve.length,
        mediane: mediane(delaisPreuve),
        max: delaisPreuve.length ? Math.max(...delaisPreuve) : null,
        dansLHeure: delaisPreuve.length ? delaisPreuve.filter((x) => x <= HEURE).length / delaisPreuve.length : null,
      },
    },
    qualite: {
      prRouges,
      nonResolues,
      retourAuVert: { n: retours.length, mediane: mediane(retours), max: retours.length ? Math.max(...retours) : null },
      incidents: comptes('incident'),
      pannes: comptes('panne'),
      couverture: Object.fromEntries(lisibles.map((d) => [d.nom, d.couverture])),
      conformite: Object.fromEntries(lisibles.map((d) => [d.nom, d.conformite])),
    },
    backlog: { bloquees, gestes, orphelines, nonProuvees, preuves },
  };
}

// ---------- rendu ----------

const lien = (depot, numero) => `${depot}#${numero}`;

export function rendre(r, { premierLundi = false, maintenant = r.fenetre.fin } = {}) {
  const l = [];
  const du = jourQuebec(r.fenetre.debut);
  const au = jourQuebec(r.fenetre.fin);
  l.push(`Période : du ${du} au ${au} (heure du Québec). Chaque chiffre vient de l'API GitHub ; ce qui n'est pas mesuré est dit comme tel.`, '');
  if (r.illisibles.length) l.push(`**Dépôts illisibles** (privés, jeton du job sans accès) : ${r.illisibles.join(', ')}. Leurs chiffres manquent aux totaux.`, '');

  const v = r.vitesse;
  l.push('## Vitesse', '');
  l.push(`- Tâches acceptées : **${v.acceptees}** (fil : ${v.parExecutant.fil}, Jules : ${v.parExecutant.Jules}).`);
  const depots = Object.entries(v.parDepot).filter(([, n]) => n > 0).map(([d, n]) => `${d} ${n}`);
  l.push(`- Par dépôt : ${depots.length ? depots.join(', ') : 'aucune'}.`);
  l.push(`- Création → acceptation : médiane ${duree(v.acceptation.mediane)}, maximum ${duree(v.acceptation.max)}.`);
  l.push(
    v.preuve.n
      ? `- Fusion → « Acceptée » : médiane ${duree(v.preuve.mediane)}, maximum ${duree(v.preuve.max)} ; **${Math.round(v.preuve.dansLHeure * 100)} %** prouvées dans l'heure (sur ${v.preuve.n} tâches dont la PR est citée).`
      : '- Fusion → « Acceptée » : aucune tâche acceptée avec PR citée cette semaine. Le délai entre la mise en ligne Vercel et la preuve n\'est pas mesuré (aucun jeton Vercel).',
  );
  l.push('');

  const q = r.qualite;
  l.push('## Qualité', '');
  l.push(`- PR passées au rouge : **${q.prRouges}**${q.nonResolues ? ` (dont ${q.nonResolues} pas revenue au vert)` : ''} ; retour au vert : médiane ${duree(q.retourAuVert.mediane)}, maximum ${duree(q.retourAuVert.max)} (${q.retourAuVert.n} retours).`);
  l.push(`- Incidents ouverts : **${q.incidents}** ; pannes d'app ouvertes par la surveillance : **${q.pannes}**.`);
  l.push('- Retours en arrière Vercel : non mesuré (aucun jeton Vercel). Tests instables : non mesuré (aucune source ne les enregistre).');
  l.push('', '| Dépôt | Couverture (seuils du cliquet) | Conformité |', '|---|---|---|');
  for (const nom of Object.keys(q.couverture)) {
    const cov = q.couverture[nom];
    const covTexte = cov && Object.keys(cov).length ? Object.entries(cov).map(([k, m]) => `${k} ≥ ${m}`).join(', ') : 'non mesuré';
    const c = q.conformite[nom];
    l.push(`| ${nom} | ${covTexte} | ${c ? `${c.vert} vert · ${c.rouge} rouge · ${c.aRelire} à relire · ${c.sansObjet} sans objet` : 'non mesuré'} |`);
  }
  l.push('');

  const b = r.backlog;
  l.push('## Santé du backlog', '');
  l.push(`- Tâches bloquées depuis plus de 7 jours : **${b.bloquees.length}**${b.bloquees.length ? ` (${b.bloquees.map((o) => lien(o.depot, o.numero)).join(', ')})` : ''}.`);
  l.push(`- Gestes de Marc en attente : **${b.gestes.length}**${b.gestes.length ? ` — ${b.gestes.map((g) => `${lien(g.depot, g.numero)} (${duree(g.age)})`).join(', ')}` : ''}.`);
  l.push(`- Tâches orphelines (sans mission) : **${b.orphelines.length}**${b.orphelines.length ? ` (${b.orphelines.map((o) => lien(o.depot, o.numero)).join(', ')})` : ''}.`);
  l.push(`- Fusionnées mais pas encore prouvées : **${b.nonProuvees.length}**${b.nonProuvees.length ? ` — ${b.nonProuvees.map((n) => `${lien(n.depot, n.tache)} via PR ${n.pr} (${duree(n.depuis)})`).join(', ')}` : ''}.`);
  l.push(`- Preuves programmées : **${b.preuves.length}**${b.preuves.length ? ` — ${b.preuves.map((p) => `${lien(p.depot, p.numero)} : ${p.quand}`).join(' ; ')}` : ''}.`);
  l.push('');

  if (premierLundi) {
    l.push('## Revue de la grille (premier lundi du mois)', '');
    l.push('Lignes de la grille encore rouges, par nombre de dépôts concernés. Ce que les incidents du mois ont appris devient des lignes neuves, proposées en tâches.', '');
    const rouges = Object.entries(q.conformite)
      .flatMap(([nom, c]) => (c?.lignesRouges ?? []).map((n) => [n, nom]))
      .reduce((m, [n, nom]) => m.set(n, [...(m.get(n) ?? []), nom]), new Map());
    if (rouges.size === 0) l.push('Aucune ligne rouge sur les dépôts lisibles.');
    for (const [n, noms] of [...rouges].sort((a, b) => a[0] - b[0])) l.push(`- Ligne ${n} : ${noms.length} dépôt(s) — ${noms.join(', ')}`);
    l.push('');
  }
  return l.join('\n');
}

// ---------- collecte (E/S) ----------

const ghReel = (args) =>
  new Promise((resolve, reject) => {
    execFile('gh', args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(new Error(`gh ${args.slice(0, 2).join(' ')} a échoué : ${String(stderr).trim() || err.message}`), { stderr: String(stderr) }));
      else resolve(stdout);
    });
  });

/** GET paginé : aplatit les pages (tableaux, ou objets portant `cle`). */
export async function lire(gh, chemin, cle) {
  const sortie = await gh(['api', '--paginate', '--slurp', chemin]);
  const pages = JSON.parse(sortie);
  return pages.flatMap((p) => (cle ? p[cle] ?? [] : p));
}

const noms = (o) => (o.labels ?? []).map((x) => (typeof x === 'string' ? x : x.name));

export async function collecterDepot(gh, depot, maintenant, conformiteDe) {
  const R = `repos/MoKarade/${depot}`;
  try {
    await gh(['api', R, '--jq', '.full_name']);
  } catch (err) {
    // Seul « introuvable » (dépôt privé pour ce jeton) rend le dépôt illisible ; toute autre erreur est une vraie panne du rapport.
    if (/HTTP 404|Not Found/i.test(`${err.stderr ?? ''} ${err.message}`)) return { nom: depot, lisible: false };
    throw err;
  }
  const depuis = new Date(maintenant - 30 * JOUR).toISOString();
  const debut = maintenant - 7 * JOUR;
  const recents = (await lire(gh, `${R}/issues?state=all&since=${depuis}&per_page=100`)).filter((i) => !i.pull_request);
  const ouvertes = (await lire(gh, `${R}/issues?state=open&per_page=100`)).filter((i) => !i.pull_request);
  const norm = (i) => ({ numero: i.number, titre: i.title, etiquettes: noms(i), creeLe: i.created_at, majLe: i.updated_at, fermeLe: i.closed_at, parent: Boolean(i.parent_issue_url), corps: i.body ?? '' });

  const taches = [];
  for (const i of recents.filter((x) => x.state === 'closed' && x.state_reason === 'completed' && noms(x).includes('niveau:tâche') && temps(x.closed_at) >= debut)) {
    const commentaires = await lire(gh, `${R}/issues/${i.number}/comments?per_page=100`);
    const accept = commentaires.find((c) => /^\*\*Acceptée\*\*/.test(c.body ?? ''));
    let prFusionLe = null;
    const pr = /PR #(\d+)/.exec(accept?.body ?? '');
    if (pr) {
      try {
        prFusionLe = JSON.parse(await gh(['api', `${R}/pulls/${pr[1]}`, '--jq', '{m: .merged_at}'])).m;
      } catch {
        prFusionLe = null;
      }
    }
    taches.push({ ...norm(i), acceptee: accept ? { le: accept.created_at, prFusionLe } : null });
  }

  const prsBrutes = (await lire(gh, `${R}/pulls?state=all&sort=updated&direction=desc&per_page=40`)).filter((p) => temps(p.updated_at) >= maintenant - 30 * JOUR);
  const prs = [];
  for (const p of prsBrutes) {
    let runs = [];
    if (temps(p.updated_at) >= debut || (p.merged_at && temps(p.merged_at) >= debut)) {
      runs = (await lire(gh, `${R}/actions/runs?branch=${encodeURIComponent(p.head.ref)}&per_page=100`, 'workflow_runs')).map((r) => ({ nom: r.name, conclusion: r.conclusion, creeLe: r.created_at, finLe: r.updated_at }));
    }
    prs.push({ numero: p.number, majLe: p.updated_at, fusionLe: p.merged_at, corps: p.body ?? '', runs });
  }

  let couverture = null;
  try {
    const seuils = JSON.parse(await gh(['api', `${R}/contents/qualite/seuils.json`, '--jq', '.content', '-H', 'Accept: application/vnd.github+json']).then((b64) => Buffer.from(b64, 'base64').toString('utf8')));
    couverture = Object.fromEntries(Object.entries(seuils.portes ?? {}).filter(([k, v]) => /couverture/i.test(k) && typeof v?.min === 'number').map(([k, v]) => [k, v.min]));
  } catch {
    couverture = null;
  }

  return {
    nom: depot,
    lisible: true,
    taches,
    ouvertes: ouvertes.map(norm),
    signalements: recents.map(norm),
    prs,
    couverture,
    conformite: conformiteDe(depot),
  };
}

/** Résumé d'un fichier produit par `conformite.mjs --json` (tableau de lignes { n, etat }), ou null. */
export function resumeConformite(lignes) {
  if (!Array.isArray(lignes)) return null;
  const n = (etat) => lignes.filter((x) => x.etat === etat).length;
  return { vert: n('vert'), rouge: n('rouge'), aRelire: n('non-verifiable'), sansObjet: n('sans-objet'), lignesRouges: lignes.filter((x) => x.etat === 'rouge').map((x) => x.n) };
}

async function main() {
  const env = process.env;
  const maintenant = env.RAPPORT_MAINTENANT ? Date.parse(env.RAPPORT_MAINTENANT) : Date.now();
  const dossierConformite = env.RAPPORT_CONFORMITE_DIR || '';
  const conformiteDe = (depot) => {
    const f = join(dossierConformite, `${depot}.json`);
    if (!dossierConformite || !existsSync(f)) return null;
    try {
      return resumeConformite(JSON.parse(readFileSync(f, 'utf8')));
    } catch {
      return null;
    }
  };
  const depots = [];
  for (const d of DEPOTS) depots.push(await collecterDepot(ghReel, d, maintenant, conformiteDe));
  const rapport = calculer({ depots, maintenant });
  const corps = rendre(rapport, { premierLundi: estPremierLundi(maintenant) });
  const titre = titreRapport(rapport.fenetre.debut);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `# ${titre}\n\n${corps}\n`);
  if (env.RAPPORT_SANS_ISSUE) {
    console.log(`# ${titre}\n\n${corps}`);
    return;
  }
  // Un seul rapport par semaine : relancer le workflow ne duplique pas l'issue.
  const existantes = JSON.parse(await ghReel(['issue', 'list', '--state', 'all', '--search', `"${titre}" in:title`, '--json', 'number,title', '--limit', '20']));
  const deja = existantes.find((i) => i.title === titre);
  if (deja) {
    await ghReel(['issue', 'edit', String(deja.number), '--body', corps]);
    console.log(`Rapport mis à jour : #${deja.number}`);
  } else {
    await ghReel(['label', 'create', 'rapport', '--color', '0E8A16', '--description', 'Rapport hebdomadaire', '--force']);
    const sortie = await ghReel(['issue', 'create', '--title', titre, '--label', 'rapport', '--body', corps]);
    console.log(`Rapport créé : ${sortie.trim()}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
