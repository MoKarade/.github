import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `scripts/graphe.sh garde-lecture` (hook PreToolUse Read|Glob) sur des fichiers FICTIFS, dans un dossier temporaire : aucun réseau,
// venv absent (repli sur python3). Tâche MoKarade/.github#840.
const SCRIPT = fileURLToPath(new URL('./graphe.sh', import.meta.url));

function garde(entree, fichiers = {}) {
  const racine = mkdtempSync(join(tmpdir(), 'graphe-garde-'));
  try {
    mkdirSync(join(racine, 'scripts'));
    copyFileSync(SCRIPT, join(racine, 'scripts', 'graphe.sh'));
    for (const [nom, contenu] of Object.entries(fichiers)) writeFileSync(join(racine, nom), contenu);
    const corps = typeof entree === 'function' ? entree(racine) : entree;
    const r = spawnSync('bash', [join(racine, 'scripts', 'graphe.sh'), 'garde-lecture'], {
      encoding: 'utf8',
      input: typeof corps === 'string' ? corps : JSON.stringify(corps),
      env: { ...process.env, GRAPHE_VENV: join(racine, 'pas-de-venv') },
    });
    let journal = '';
    try { journal = readFileSync(join(racine, 'graphify-out', 'usage.jsonl'), 'utf8'); } catch { /* journal absent */ }
    return { ...r, journal };
  } finally {
    rmSync(racine, { recursive: true, force: true });
  }
}

const lignes = (n) => Array.from({ length: n }, (_, i) => `const x${i} = ${i};`).join('\n') + '\n';
const lire = (nom, extra = {}) => (racine) => ({ tool_name: 'Read', tool_input: { file_path: join(racine, nom), ...extra } });
const refus = (r) => JSON.parse(r.stdout).hookSpecificOutput;

test('Read entier d’un gros fichier de code : refusé, avec la commande du graphe à utiliser', () => {
  const r = garde(lire('gros.mjs'), { 'gros.mjs': lignes(500) });
  assert.equal(r.status, 0, r.stderr);
  const sortie = refus(r);
  assert.equal(sortie.hookEventName, 'PreToolUse');
  assert.equal(sortie.permissionDecision, 'deny');
  assert.match(sortie.permissionDecisionReason, /scripts\/graphe\.sh explain/);
  assert.match(sortie.permissionDecisionReason, /offset et limit/);
  assert.match(r.journal, /garde-lecture-refus/);
});

test('Read avec limit ou offset : laissé passer, sans sortie', () => {
  for (const extra of [{ limit: 50 }, { offset: 10 }, { offset: 10, limit: 50 }]) {
    const r = garde(lire('gros.mjs', extra), { 'gros.mjs': lignes(500) });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
  }
});

test('Read d’un petit fichier, d’un .md ou d’un verrou : laissé passer', () => {
  const fichiers = { 'petit.mjs': lignes(20), 'LISTE.md': lignes(900), 'package-lock.json': lignes(900), 'bundle.min.js': lignes(900) };
  for (const nom of Object.keys(fichiers)) {
    const r = garde(lire(nom), fichiers);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '', nom);
  }
});

test('Read d’un fichier absent ou hors du dépôt : laissé passer (échec ouvert)', () => {
  assert.equal(garde(lire('absent.mjs')).stdout, '');
  const hors = garde({ tool_name: 'Read', tool_input: { file_path: '/etc/passwd' } });
  assert.equal(hors.status, 0, hors.stderr);
  assert.equal(hors.stdout, '');
});

test('Glob de tout le dépôt : refusé ; Glob ciblé : laissé passer', () => {
  for (const pattern of ['**', '**/*', '**/*.*']) {
    const r = garde({ tool_name: 'Glob', tool_input: { pattern } });
    assert.equal(refus(r).permissionDecision, 'deny', pattern);
  }
  for (const pattern of ['scripts/*.mjs', '**/*.test.mjs', 'docs/**']) {
    assert.equal(garde({ tool_name: 'Glob', tool_input: { pattern } }).stdout, '', pattern);
  }
});

test('entrée illisible, vide ou autre outil : silence et code 0', () => {
  for (const entree of ['pas du json', '', '[]', { tool_name: 'Bash', tool_input: { command: 'ls' } }, { tool_name: 'Read' }]) {
    const r = garde(entree);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '', JSON.stringify(entree));
  }
});
