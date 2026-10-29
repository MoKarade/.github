// Le graphe de code doit rester en place dans chaque dépôt (tâche MoKarade/.github#841, mission #839, demande de Marc 29/10/2026) :
// `scripts/graphe.sh`, les hooks graphe de `.claude/settings.json` et le serveur MCP `graphify` de `.mcp.json`.
// Fonction pure (`controlerGrapheEnPlace`) : aucune lecture de disque ni de réseau, aucun jeton. Chaque manque est nommé.
// Appelé par `.github/workflows/conformite.yml` sur le dépôt appelant (le script vient de ce dépôt, jamais de l'appelant).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const TAILLE_MINI_OCTETS = 2000;
const SCRIPT = 'scripts/graphe.sh';

const json = (texte) => {
  try {
    const v = JSON.parse(texte);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
};

// Toutes les commandes déclarées pour un événement de hook (`hooks.<evenement>[].hooks[].command`), quelle que soit la forme.
const commandes = (settings, evenement) => {
  const groupes = settings?.hooks?.[evenement];
  if (!Array.isArray(groupes)) return [];
  return groupes.flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks : [])).map((h) => h?.command).filter((c) => typeof c === 'string');
};

export function controlerGrapheEnPlace({ lire }) {
  const manques = [];

  const script = lire(SCRIPT);
  if (script == null) manques.push(`${SCRIPT} absent`);
  else if (Buffer.byteLength(script, 'utf8') < TAILLE_MINI_OCTETS) manques.push(`${SCRIPT} trop petit (moins de ${TAILLE_MINI_OCTETS} octets : vidé ou tronqué)`);

  const brut = lire('.claude/settings.json');
  const settings = brut == null ? undefined : json(brut);
  if (brut == null) manques.push('.claude/settings.json absent (hooks du graphe)');
  else if (settings === undefined) manques.push('.claude/settings.json illisible (JSON invalide)');
  else {
    if (!commandes(settings, 'SessionStart').some((c) => c.includes(SCRIPT))) manques.push(`.claude/settings.json : hook SessionStart vers ${SCRIPT} absent`);
    if (!commandes(settings, 'PreToolUse').some((c) => c.includes(SCRIPT))) manques.push(`.claude/settings.json : hook PreToolUse vers ${SCRIPT} absent`);
  }

  const mcpBrut = lire('.mcp.json');
  const mcp = mcpBrut == null ? undefined : json(mcpBrut);
  if (mcpBrut == null) manques.push('.mcp.json absent (serveur MCP graphify)');
  else if (mcp === undefined) manques.push('.mcp.json illisible (JSON invalide)');
  else {
    const serveur = mcp.mcpServers?.graphify;
    const lancement = [serveur?.command, ...(Array.isArray(serveur?.args) ? serveur.args : [])].filter((x) => typeof x === 'string').join(' ');
    if (!serveur) manques.push('.mcp.json : serveur graphify absent');
    else if (!lancement.includes(SCRIPT) || !/\bserve\b/.test(lancement)) manques.push(`.mcp.json : le serveur graphify ne lance pas « ${SCRIPT} serve »`);
  }

  return manques;
}

function main() {
  const dossier = process.argv[2] || '.';
  const lire = (chemin) => {
    try {
      return readFileSync(join(dossier, chemin), 'utf8');
    } catch {
      return null;
    }
  };
  const manques = controlerGrapheEnPlace({ lire });
  if (!manques.length) {
    console.log('Graphe de code en place : scripts/graphe.sh, hooks et serveur MCP présents.');
    return;
  }
  for (const m of manques) console.log(`::${process.env.CONFORMITE_BLOQUANT === 'true' ? 'error' : 'warning'} title=Graphe de code absent::${m}`);
  if (process.env.CONFORMITE_BLOQUANT === 'true') process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
