import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { controlerGrapheEnPlace } from './graphe-en-place.mjs';

// Contrôle « le graphe de code reste en place » (tâche MoKarade/.github#841) sur des dépôts FICTIFS : aucun réseau.
const SCRIPT = `#!/usr/bin/env bash\n${'# ligne de remplissage\n'.repeat(120)}`;
const SETTINGS = JSON.stringify({
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: '[ -f "$CLAUDE_PROJECT_DIR/scripts/graphe.sh" ] && bash "$CLAUDE_PROJECT_DIR/scripts/graphe.sh" session || true' }] }],
    PreToolUse: [{ matcher: 'Bash|Grep', hooks: [{ type: 'command', command: 'bash "$CLAUDE_PROJECT_DIR/scripts/graphe.sh" hook-guard search || true' }] }],
  },
});
const MCP = JSON.stringify({ mcpServers: { graphify: { command: 'bash', args: ['scripts/graphe.sh', 'serve'] } } });
const CONFORME = { 'scripts/graphe.sh': SCRIPT, '.claude/settings.json': SETTINGS, '.mcp.json': MCP };

const controler = (fichiers) => controlerGrapheEnPlace({ lire: (chemin) => fichiers[chemin] ?? null });
const sans = (cle, extra = {}) => ({ ...CONFORME, [cle]: undefined, ...extra });

test('dépôt conforme : aucune erreur', () => {
  assert.deepEqual(controler(CONFORME), []);
});

test('sans scripts/graphe.sh : le manque est nommé', () => {
  const m = controler(sans('scripts/graphe.sh'));
  assert.equal(m.length, 1);
  assert.match(m[0], /scripts\/graphe\.sh absent/);
});

test('scripts/graphe.sh vidé ou tronqué (moins de 2 Ko) : nommé', () => {
  const m = controler({ ...CONFORME, 'scripts/graphe.sh': '#!/usr/bin/env bash\n' });
  assert.equal(m.length, 1);
  assert.match(m[0], /trop petit/);
});

test('sans hook SessionStart : nommé, et PreToolUse reste accepté', () => {
  const s = JSON.stringify({ hooks: { PreToolUse: JSON.parse(SETTINGS).hooks.PreToolUse } });
  const m = controler({ ...CONFORME, '.claude/settings.json': s });
  assert.equal(m.length, 1);
  assert.match(m[0], /SessionStart/);
});

test('sans hook PreToolUse vers graphe.sh : nommé (un hook PreToolUse étranger ne compte pas)', () => {
  const s = JSON.stringify({ hooks: { SessionStart: JSON.parse(SETTINGS).hooks.SessionStart, PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo autre' }] }] } });
  const m = controler({ ...CONFORME, '.claude/settings.json': s });
  assert.equal(m.length, 1);
  assert.match(m[0], /PreToolUse/);
});

test('sans serveur MCP graphify, ou serveur qui ne lance pas graphe.sh serve : nommé', () => {
  const m1 = controler({ ...CONFORME, '.mcp.json': JSON.stringify({ mcpServers: {} }) });
  assert.match(m1.join('|'), /serveur graphify absent/);
  const m2 = controler({ ...CONFORME, '.mcp.json': JSON.stringify({ mcpServers: { graphify: { command: 'echo', args: ['rien'] } } }) });
  assert.match(m2.join('|'), /ne lance pas/);
});

test('fichiers absents : chaque manque nommé, trois erreurs', () => {
  const m = controler({});
  assert.equal(m.length, 3);
  assert.match(m.join('|'), /graphe\.sh absent.*settings\.json absent.*\.mcp\.json absent/);
});

test('JSON invalide ou qui n’est pas un objet : compte comme manque, jamais d’exception', () => {
  for (const mauvais of ['{tronq', '[]', 'null', '3', '']) {
    const m = controler({ ...CONFORME, '.claude/settings.json': mauvais, '.mcp.json': mauvais });
    assert.equal(m.length, 2, JSON.stringify(mauvais));
    assert.match(m.join('|'), /illisible/);
  }
});

test('hooks mal formés (pas de tableau, pas de commande texte) : manque, pas d’exception', () => {
  const s = JSON.stringify({ hooks: { SessionStart: 'oups', PreToolUse: [{ hooks: [{ command: 3 }, null] }, null] } });
  const m = controler({ ...CONFORME, '.claude/settings.json': s });
  assert.equal(m.length, 2);
});

// La ligne de commande : code de sortie et annotation selon CONFORMITE_BLOQUANT, sur un dossier temporaire.
function lancer(fichiers, bloquant) {
  const dossier = mkdtempSync(join(tmpdir(), 'graphe-en-place-'));
  try {
    for (const [chemin, contenu] of Object.entries(fichiers)) {
      if (contenu === undefined) continue;
      mkdirSync(dirname(join(dossier, chemin)), { recursive: true });
      writeFileSync(join(dossier, chemin), contenu);
    }
    const module = fileURLToPath(new URL('./graphe-en-place.mjs', import.meta.url));
    return spawnSync('node', [module, dossier], { encoding: 'utf8', env: { ...process.env, CONFORMITE_BLOQUANT: String(bloquant) } });
  } finally {
    rmSync(dossier, { recursive: true, force: true });
  }
}

test('ligne de commande : conforme = code 0 ; manque + bloquant = code 1 et ::error ; manque non bloquant = code 0 et ::warning', () => {
  const ok = lancer(CONFORME, true);
  assert.equal(ok.status, 0, ok.stderr);
  const rouge = lancer(sans('.mcp.json'), true);
  assert.equal(rouge.status, 1);
  assert.match(rouge.stdout, /::error title=Graphe de code absent::.*\.mcp\.json absent/);
  const tableau = lancer(sans('.mcp.json'), false);
  assert.equal(tableau.status, 0);
  assert.match(tableau.stdout, /::warning title=Graphe de code absent::/);
});
