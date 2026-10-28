#!/usr/bin/env bash
# Classe B : installe l'app du commit fusionné, la lance avec les données fictives des tests, attend qu'elle réponde, lit ses pages
# (scripts/preuve-page.mjs lire), puis l'arrête. Appelé par .github/workflows/preuve-page.yml.
#   usage : preuve-page-lancer.sh <dossier-du-dépôt>
# Tout vient de l'environnement posé par le workflow (PREUVE_*) ; les commandes sont celles de l'appelant (comme captures-cote.sh).
set -euo pipefail

dossier="$1"
journal="$(mktemp)"

cd "$dossier/${PREUVE_RACINE:-.}"
bash -c "$PREUVE_INSTALLATION"

# Nouvelle session : l'arrêt vise tout le groupe de processus (le serveur lance souvent des enfants).
setsid bash -c "$PREUVE_DEMARRAGE" >"$journal" 2>&1 &
pid=$!
arreter() {
  kill -- "-$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}
trap arreter EXIT

pret=""
for _ in $(seq 1 "${PREUVE_ATTENTE:-60}"); do
  if curl -s -o /dev/null --max-time 2 "$PREUVE_URL"; then
    pret=1
    break
  fi
  sleep 1
done
if [ -z "$pret" ]; then
  echo "::warning title=Preuve de page::l'app ne répond pas sur ${PREUVE_URL} après ${PREUVE_ATTENTE:-60} s ($(basename "$dossier"))"
  tail -n 20 "$journal" || true
  exit 1
fi

node "$GITHUB_WORKSPACE/.preuve/scripts/preuve-page.mjs" lire "$PREUVE_URL"
