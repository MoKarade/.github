# installer.ps1 : installe le relevé du Gantt sur le PC de Marc (16/10/2026, fil « Page de suivi »).
# Pourquoi : le relevé tournait dans une machine Claude qui est recyclée sans prévenir ; le relancer coûtait du quota Claude.
# Ici il tourne sur le PC, sans Claude : tâche Windows cachée toutes les 10 min, résultats déposés dans le Drive (dossier _Gantt),
# que la page « Chantier Apps » lit avec le connecteur Google Drive.
# Usage (PowerShell, utilisateur de Marc, pas en administrateur) : powershell -ExecutionPolicy Bypass -File installer.ps1 [-Drive "G:\Mon disque\_Gantt"]
# Relancer le script est sans risque : il remplace la tâche et met le code à jour.
param([string]$Drive = '', [string]$Etat = 'C:\dev\_pc-local\gantt-releve')
# 'Continue' : sous PowerShell 5.1, une ligne écrite sur stderr par un programme (git, gh) deviendrait une erreur fatale en 'Stop'
$ErrorActionPreference = 'Continue'
function Verifier($nom, $cmd, $versionArg) {
    # on LANCE l'outil : sous Windows, « python » peut être le raccourci du Microsoft Store, présent mais inutilisable
    # sortie lue EN ENTIER avant de garder la 1re ligne : « | Select-Object -First 1 » arrête le programme en cours de route,
    # et $LASTEXITCODE n'est alors pas 0 : Node et Git sortaient « MANQUE » alors qu'ils marchent (PC de Marc, 16/10)
    $sortie = & $cmd $versionArg 2>&1
    $code = $LASTEXITCODE
    $v = $sortie | Select-Object -First 1
    if ($code -eq 0 -and $v) { Write-Host "OK   $nom : $v" } else { Write-Host "MANQUE $nom ($cmd)"; $script:manque = $true }
}
$manque = $false
Verifier 'Python' 'python' '--version'; Verifier 'Node' 'node' '--version'; Verifier 'GitHub CLI' 'gh' '--version'; Verifier 'Git' 'git' '--version'
if ($manque) { throw 'Outil manquant : installer ce qui est marqué MANQUE, puis relancer.' }
gh api user --jq .login 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) { throw "gh n'est pas connecté : lancer « gh auth login » puis relancer." }

# dossier Drive : celui donné, sinon <lecteur>:\Mon disque\_Gantt (ou My Drive) sur le premier lecteur qui l'a
if (-not $Drive) {
    foreach ($l in Get-PSDrive -PSProvider FileSystem) {
        foreach ($n in 'Mon disque', 'My Drive') {
            $p = Join-Path $l.Root $n
            if (Test-Path $p) { $Drive = Join-Path $p '_Gantt'; break }
        }
        if ($Drive) { break }
    }
}
if (-not $Drive) { throw 'Dossier Google Drive introuvable : relancer avec -Drive "<lecteur>:\Mon disque\_Gantt".' }
New-Item -ItemType Directory -Force $Drive | Out-Null
Write-Host "OK   Drive : $Drive"

# Dossier d'état hors de AppData : lancé depuis l'app Claude (paquet Windows), AppData est redirigé vers un dossier privé
# du paquet, que la tâche planifiée ne voit pas ; le relevé restait figé sans erreur (PC de Marc, 16/10).
$Depot = Join-Path $Etat 'depot'
New-Item -ItemType Directory -Force $Etat | Out-Null
if (Test-Path (Join-Path $Depot '.git')) { git -C $Depot pull --ff-only --quiet 2>&1 | Out-Host }
else { git clone --quiet --depth 1 https://github.com/MoKarade/.github.git $Depot 2>&1 | Out-Host }
if (-not (Test-Path (Join-Path $Depot 'outils\gantt-pc\tour.py'))) { throw "Code introuvable dans $Depot (clone ou mise à jour en échec)." }
Write-Host "OK   code : $Depot"

$lanceur = Join-Path $Depot 'outils\gantt-pc\lancer.ps1'
$arg = "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$lanceur`" -Drive `"$Drive`" -Etat `"$Etat`""
$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument $arg
$declencheur = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 10)
$reglages = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 25) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'Gantt-releve' -Action $action -Trigger $declencheur -Settings $reglages `
    -Description 'Relevé du Gantt (page Chantier Apps) toutes les 10 min, sans Claude. Voir MoKarade/.github outils/gantt-pc.' -Force | Out-Null
Write-Host 'OK   tâche Gantt-releve : toutes les 10 min, premier tour dans 1 min'
# premier tour tout de suite, visible, pour voir une erreur éventuelle maintenant plutôt que dans le journal
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $lanceur -Drive $Drive -Etat $Etat
Get-Content (Join-Path $Etat 'tour.log') -Tail 3 | Out-Host
Write-Host "Journal : $(Join-Path $Etat 'tour.log')   ·   État : $(Join-Path $Drive 'etat.json')"
