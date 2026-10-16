# lancer.ps1 : un tour du relevé du Gantt sur le PC de Marc. Lancé toutes les 10 min par la tâche Windows « Gantt-releve »
# (installer.ps1), dans une console cachée (conhost --headless), comme les autres tâches du PC.
# 1. met à jour le code depuis MoKarade/.github (clone dédié, jamais celui où Marc travaille)
# 2. copie le code dans le dossier d'état (%LOCALAPPDATA%\Gantt) et lance tour.py, qui dépose les résultats dans le Drive
param([Parameter(Mandatory = $true)][string]$Drive)
$ErrorActionPreference = 'Continue'
$Etat = Join-Path $env:LOCALAPPDATA 'Gantt'
$Depot = Join-Path $Etat 'depot'
$Journal = Join-Path $Etat 'tour.log'
New-Item -ItemType Directory -Force $Etat | Out-Null
# journal borné : on garde les 2 000 dernières lignes
if ((Test-Path $Journal) -and (Get-Item $Journal).Length -gt 1MB) { Get-Content $Journal -Tail 2000 | Set-Content "$Journal.tmp" -Encoding utf8; Move-Item "$Journal.tmp" $Journal -Force }
git -C $Depot pull --ff-only --quiet 2>&1 | Out-Null
Copy-Item (Join-Path $Depot 'outils\gantt-pc\*.py') $Etat -Force
$py = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $py) { $py = (Get-Command py -ErrorAction SilentlyContinue).Source }
"$(Get-Date -Format s) tour" | Add-Content $Journal -Encoding utf8
& $py -X utf8 (Join-Path $Etat 'tour.py') --drive $Drive 2>&1 | Add-Content $Journal -Encoding utf8
exit $LASTEXITCODE
