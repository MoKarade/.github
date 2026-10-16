#!/usr/bin/env bash
# Un côté des captures (« avant » ou « après ») : installe l'app, la lance avec les données fictives des tests,
# attend qu'elle réponde, la photographie, puis l'arrête. Appelé deux fois par .github/workflows/captures.yml.
#   usage : captures-cote.sh <dossier-du-dépôt> <dossier-de-sortie>
# Tout vient de l'environnement posé par le workflow (CAPTURES_*) ; les commandes sont celles de l'appelant.
set -euo pipefail

dossier="$1"
sortie="$2"
journal="$(mktemp)"

cd "$dossier/${CAPTURES_RACINE:-.}"
bash -c "$CAPTURES_INSTALLATION"

# Nouvelle session : l'arrêt vise tout le groupe de processus (le serveur lance souvent des enfants).
setsid bash -c "$CAPTURES_DEMARRAGE" >"$journal" 2>&1 &
pid=$!
arreter() {
  kill -- "-$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}
trap arreter EXIT

pret=""
for _ in $(seq 1 "${CAPTURES_ATTENTE:-60}"); do
  if curl -s -o /dev/null --max-time 2 "$CAPTURES_URL"; then
    pret=1
    break
  fi
  sleep 1
done
if [ -z "$pret" ]; then
  echo "::error title=Captures::l'app ne répond pas sur ${CAPTURES_URL} après ${CAPTURES_ATTENTE:-60} s ($(basename "$dossier"))"
  tail -n 20 "$journal" || true
  exit 1
fi

node "$GITHUB_WORKSPACE/.captures/scripts/captures.mjs" capturer "$CAPTURES_URL" "$sortie"
