import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `scripts/graphe.sh usage` sur des journaux FICTIFS, dans un dossier temporaire : aucun réseau, aucun paquet installé
// (venv absent, donc repli sur python3). Tâche MoKarade/.github#503.
const SCRIPT = fileURLToPath(new URL('./graphe.sh', import.meta.url));

function usage(journal) {
  const racine = mkdtempSync(join(tmpdir(), 'graphe-usage-'));
  try {
    mkdirSync(join(racine, 'scripts'));
    mkdirSync(join(racine, 'graphify-out'));
    copyFileSync(SCRIPT, join(racine, 'scripts', 'graphe.sh'));
    if (journal !== null) writeFileSync(join(racine, 'graphify-out', 'usage.jsonl'), journal);
    return spawnSync('bash', [join(racine, 'scripts', 'graphe.sh'), 'usage'], {
      encoding: 'utf8',
      env: { ...process.env, GRAPHE_VENV: join(racine, 'pas-de-venv') },
    });
  } finally {
    rmSync(racine, { recursive: true, force: true });
  }
}

test('journal vide : « aucun usage valide », code 0', () => {
  const r = usage('');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /aucun usage valide/);
});

test('journal sans ligne valide (texte, JSON tronqué, JSON qui n’est pas un objet) : code 0', () => {
  const r = usage('pas du json\n{tronq\n3\n[1]\n');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /aucun usage valide/);
});

test('journal absent : message inchangé, code 0', () => {
  const r = usage(null);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /aucun usage enregistré/);
});

test('journal valide : le résumé compte les appels et ignore les lignes invalides', () => {
  const r = usage('{"t":1761200000,"cmd":"query","ms":12,"car":40,"branche":"main"}\nligne cassée\n{"t":1761200060,"cmd":"hook-search","ms":0,"car":0,"branche":"main"}\n');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Usage du graphe : 2 appels/);
  assert.match(r.stdout, /Requêtes au graphe : 1 ; recherches ou lectures brutes passées par les hooks : 1/);
  assert.doesNotMatch(r.stdout, /aucun usage valide/);
});
