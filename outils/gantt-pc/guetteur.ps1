# guetteur.ps1 : un tour du guetteur de silence sur le PC de Marc (tâche MoKarade/.github#720, docs/boucle-erreur.md).
# Lancé toutes les 15 min par la tâche Windows « Guetteur-silence », dans une console cachée (conhost --headless), jamais au premier plan.
# Il lit le clone dédié du relevé du Gantt (mis à jour par lancer.ps1), prend le jeton de `gh` (aucun secret écrit ni dans le dépôt ni sur disque)
# et lance scripts/guetteur-silence.mjs. Seuil de silence : 2 h, réglable par la variable SILENCE_MAX_H de la tâche.
param([string]$Etat = 'C:\dev\_pc-local\gantt-releve')
$ErrorActionPreference = 'Continue'
$Depot = Join-Path $Etat 'depot'
$Journal = Join-Path $Etat 'guetteur.log'
New-Item -ItemType Directory -Force $Etat | Out-Null
# journal borné : on garde les 500 dernières lignes
if ((Test-Path $Journal) -and (Get-Item $Journal).Length -gt 256KB) { Get-Content $Journal -Tail 500 | Set-Content "$Journal.tmp" -Encoding utf8; Move-Item "$Journal.tmp" $Journal -Force }
$jeton = (gh auth token 2>$null | Out-String).Trim()
if (-not $jeton) { "$(Get-Date -Format s) guetteur : jeton gh absent, rien à faire" | Add-Content $Journal -Encoding utf8; exit 0 }
$env:GUETTEUR_TOKEN = $jeton
$sortie = (node (Join-Path $Depot 'scripts\guetteur-silence.mjs') 2>&1 | Out-String).Trim()
"$(Get-Date -Format s) $sortie" | Add-Content $Journal -Encoding utf8
exit 0
