#!/usr/bin/env bash
# Graphe de code LOCAL du dépôt (graphifyy, AST Tree-sitter) : 0 jeton, 0 clé, 0 réseau hors installation du paquet.
# Usage : scripts/graphe.sh [update | query "<question>" | affected "<symbole>" | path "A" "B" | explain "<symbole>" | god-nodes
#                            | wiki | serve | session | hook-guard search|read]
# `session` (hook SessionStart), `hook-guard` (hooks PreToolUse) et `serve` (.mcp.json) sont appelés par Claude Code.
# Détail, limites et mesure : docs/claude/12-graphe-code.md. Sortie dans graphify-out/ (ignoré par git, jamais committé).
set -euo pipefail

VERSION="0.9.93" # épinglée : le paquet sort une version presque chaque jour
racine="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$racine" # toujours depuis la racine : un chemin absolu serait écrit dans graphify-out/.graphify_root
venv="${GRAPHE_VENV:-${XDG_CACHE_HOME:-$HOME/.cache}/graphe-venv-$VERSION}"
export GRAPHIFY_BACKEND=none # coupe tout backend LLM : `label` et `cluster-only` se replieraient sur `claude -p` (quota Claude)

pret() { [ -x "$venv/bin/graphify" ] && "$venv/bin/python" -c 'import mcp' 2>/dev/null; }
# Verrou = dossier créé atomiquement (mkdir) ; périmé au-delà de N minutes (processus tué) : retiré.
perime() { find "$1" -maxdepth 0 -mmin "+$2" -exec rmdir {} + 2>/dev/null || true; }
installer() {
  pret && return 0
  mkdir -p "$(dirname "$venv")" || return 1
  local verrou_inst="$venv.installation.lock" attente=0 rc=0
  # `serve` (MCP) et `session` (SessionStart) démarrent ensemble : un seul installe, l'autre attend le résultat.
  until mkdir "$verrou_inst" 2>/dev/null; do
    pret && return 0
    perime "$verrou_inst" 10
    attente=$((attente + 1))
    [ "$attente" -le 180 ] || { echo "graphe : installation concurrente trop longue" >&2; return 1; }
    sleep 1
  done
  # [sql] : sans lui, les migrations .sql donnent 0 nœud ; [mcp] : serveur MCP (.mcp.json)
  { python3 -m venv "$venv" && "$venv/bin/pip" install --quiet "graphifyy[sql,mcp]==$VERSION"; } || rc=$?
  rmdir "$verrou_inst" 2>/dev/null || true
  return "$rc"
}
construire() { installer && "$venv/bin/graphify" update . && "$venv/bin/graphify" export wiki; }

commande="${1:-update}"
[ "$#" -gt 0 ] && shift
case "$commande" in
  update) installer; exec "$venv/bin/graphify" update . "$@" ;;
  wiki) installer; exec "$venv/bin/graphify" export wiki "$@" ;;
  query | affected | path | explain | god-nodes) installer; exec "$venv/bin/graphify" "$commande" "$@" ;;
  serve)
    installer
    [ -f graphify-out/graph.json ] || "$venv/bin/graphify" update . >&2
    exec "$venv/bin/python" -m graphify.serve graphify-out/graph.json
    ;;
  session)
    # SessionStart : rend `graphify` utilisable dans la session, puis construit en arrière-plan (jamais bloquant, jamais en erreur).
    if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
      printf 'export PATH="%s/bin:$PATH"\nexport GRAPHIFY_BACKEND=none\n' "$venv" >> "$CLAUDE_ENV_FILE"
    fi
    # Verrou et journal dans le cache de l'utilisateur (pas de chemin prévisible dans /tmp).
    etat="${XDG_CACHE_HOME:-$HOME/.cache}/graphe"
    mkdir -p "$etat"
    verrou="$etat/$(printf '%s' "$racine" | cksum | cut -d' ' -f1).lock"
    perime "$verrou" 30
    if mkdir "$verrou" 2>/dev/null; then
      # `|| true` : un échec de construction ne doit pas laisser le verrou en place (set -e sauterait le rmdir).
      ( construire || true; rmdir "$verrou" 2>/dev/null || true ) >"${verrou%.lock}.log" 2>&1 </dev/null &
      disown 2>/dev/null || true
    fi
    exit 0
    ;;
  hook-guard)
    # PreToolUse : silencieux (échec ouvert) tant que le paquet ou le graphe manque.
    [ -x "$venv/bin/graphify" ] && [ -f graphify-out/graph.json ] || exit 0
    "$venv/bin/graphify" hook-guard "$@" || true
    exit 0
    ;;
  *) echo "usage : scripts/graphe.sh [update | query | affected | path | explain | god-nodes | wiki | serve | session | hook-guard]" >&2; exit 2 ;;
esac
