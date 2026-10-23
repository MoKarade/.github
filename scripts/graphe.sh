#!/usr/bin/env bash
# Graphe de code LOCAL du dépôt (graphifyy, AST Tree-sitter) : 0 jeton, 0 clé, 0 réseau hors installation du paquet.
# Usage : scripts/graphe.sh [update | query "<question>" | affected "<symbole>" | path "A" "B" | explain "<symbole>" | god-nodes
#                            | wiki | serve | session | hook-guard search|read | usage]
# `affected` remonte 1 niveau par défaut ; `--depth 2` (ou plus) pour le rayon d'impact complet.
# `session` (hook SessionStart), `hook-guard` (hooks PreToolUse) et `serve` (.mcp.json) sont appelés par Claude Code.
# `usage` résume graphify-out/usage.jsonl, le journal LOCAL des appels (jamais les arguments).
# Détail, limites et mesure : docs/claude/12-graphe-code.md. Sortie dans graphify-out/ (ignoré par git, jamais committé).
set -euo pipefail

VERSION="0.9.93" # épinglée : le paquet sort une version presque chaque jour
racine="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$racine" # toujours depuis la racine : un chemin absolu serait écrit dans graphify-out/.graphify_root
venv="${GRAPHE_VENV:-${XDG_CACHE_HOME:-$HOME/.cache}/graphe-venv-$VERSION}"
export GRAPHIFY_BACKEND=none # coupe tout backend LLM : `label` et `cluster-only` se replieraient sur `claude -p` (quota Claude)

# find_spec, pas `import mcp` : importer le paquet coûtait ~850 ms à CHAQUE appel (mesuré le 22/10/2026), find_spec ~20 ms.
pret() { [ -x "$venv/bin/graphify" ] && "$venv/bin/python" -c 'import importlib.util, sys; sys.exit(importlib.util.find_spec("mcp") is None)' 2>/dev/null; }
maintenant_ms() {
  if [ -n "${EPOCHREALTIME:-}" ]; then local s="${EPOCHREALTIME/[.,]/}"; echo "${s:0:13}"; else echo $(($(date +%s) * 1000)); fi
}
# Journal d'usage LOCAL : une ligne JSON par appel (heure en secondes, commande, durée, caractères de sortie, branche).
# Jamais les arguments (un texte de requête peut contenir n'importe quoi). Un échec d'écriture est ignoré.
journal() { # $1 commande, $2 durée en ms, $3 caractères de sortie
  {
    local branche
    branche="$(git rev-parse --abbrev-ref HEAD 2>/dev/null | tr -cd 'A-Za-z0-9/._-')" || branche=""
    mkdir -p graphify-out
    printf '{"t":%s,"cmd":"%s","ms":%s,"car":%s,"branche":"%s"}\n' "${EPOCHSECONDS:-$(date +%s)}" "$1" "$2" "$3" "$branche" >> graphify-out/usage.jsonl
  } 2>/dev/null || true
}
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
  query | affected | path | explain | god-nodes)
    installer
    # 1 niveau par défaut : la profondeur 2 de graphify divise par 2 à 3 la sortie en moins (mesure du 22/10/2026).
    if [ "$commande" = affected ]; then
      case " $* " in *" --depth"*) ;; *) set -- "$@" --depth 1 ;; esac
    fi
    debut="$(maintenant_ms)"; err="$(mktemp)"; rc=0
    sortie="$("$venv/bin/graphify" "$commande" "$@" 2>"$err")" || rc=$?
    printf '%s\n' "$sortie"
    cat "$err" >&2; rm -f "$err"
    journal "$commande" "$(($(maintenant_ms) - debut))" "${#sortie}"
    exit "$rc"
    ;;
  usage)
    [ -f graphify-out/usage.jsonl ] || { echo "graphe : aucun usage enregistré (graphify-out/usage.jsonl)"; exit 0; }
    python="$venv/bin/python"; [ -x "$python" ] || python="python3"
    exec "$python" -I -c '
import collections, datetime, json, statistics, sys
n, ms, car, br, ts = collections.Counter(), collections.defaultdict(list), collections.Counter(), collections.Counter(), []
for ligne in open(sys.argv[1], encoding="utf8", errors="replace"):
    try:
        d = json.loads(ligne)
    except ValueError:
        continue
    if not isinstance(d, dict):
        continue
    c = str(d.get("cmd", "?"))
    n[c] += 1; ms[c].append(d.get("ms") or 0); car[c] += d.get("car") or 0; br[str(d.get("branche") or "?")] += 1; ts.append(d.get("t") or 0)
if not ts:  # journal vide ou sans ligne valide : min() lèverait ValueError
    print("graphe : aucun usage valide (%s)" % sys.argv[1])
    sys.exit(0)
f = lambda t: datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
print("Usage du graphe : %d appels, du %s au %s" % (sum(n.values()), f(min(ts)), f(max(ts))))
for c in sorted(n):
    if c.startswith("hook-"):
        print("  %-14s %5d passages du hook (recherches ou lectures brutes vues)" % (c, n[c]))
    else:
        print("  %-14s %5d appels, %8d caractères rendus, durée médiane %d ms" % (c, n[c], car[c], statistics.median(ms[c])))
graphe = sum(v for k, v in n.items() if not k.startswith("hook-"))
brut = sum(v for k, v in n.items() if k.startswith("hook-"))
print("Requêtes au graphe : %d ; recherches ou lectures brutes passées par les hooks : %d" % (graphe, brut))
print("Branches : " + ", ".join("%s (%d)" % kv for kv in br.most_common(5)))
' graphify-out/usage.jsonl
    ;;
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
    journal "hook-${1:-garde}" 0 0
    exit 0
    ;;
  *) echo "usage : scripts/graphe.sh [update | query | affected | path | explain | god-nodes | wiki | serve | session | hook-guard | usage]" >&2; exit 2 ;;
esac
