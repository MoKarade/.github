# installer.ps1 : installe le relevé du Gantt sur le PC de Marc (16/10/2026, fil « Page de suivi »).
# Pourquoi : le relevé tournait dans une machine Claude qui est recyclée sans prévenir ; le relancer coûtait du quota Claude.
# Ici il tourne sur le PC, sans Claude : tâche Windows cachée toutes les 10 min, résultats déposés dans le Drive (dossier _Gantt),
# que la page « Chantier Apps » lit avec le connecteur Google Drive.
# Usage (PowerShell, utilisateur de Marc, pas en administrateur) : powershell -ExecutionPolicy Bypass -File installer.ps1 [-Drive "<chemin du dossier _Gantt>"]
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

# dossier Drive : celui donné, sinon le dossier `_Gantt` EXISTANT sous « Mon disque » / « My Drive » d'un lecteur, à n'importe quelle profondeur (Marc range son Drive :
# « Nouvelle structure 2026\08 · Perso & projets\Projets\… », 21/10/2026). Celui qui porte déjà `etat.json` (écrit par ce relevé) gagne. On ne CRÉE jamais `_Gantt` de soi-même :
# un dossier neuf aurait de nouveaux identifiants et la page, qui lit ces fichiers par nom dans le dossier, ne les retrouverait plus. Plusieurs candidats sans `etat.json` = on s'arrête.
if (-not $Drive) {
    $trouves = @()
    foreach ($l in Get-PSDrive -PSProvider FileSystem) {
        foreach ($n in 'Mon disque', 'My Drive') {
            $p = Join-Path $l.Root $n
            if (Test-Path $p) {
                $trouves += Get-ChildItem -LiteralPath $p -Directory -Recurse -Depth 6 -Filter '_Gantt' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }
            }
        }
    }
    $avec = @($trouves | Where-Object { Test-Path (Join-Path $_ 'etat.json') })
    if ($avec.Count -eq 1) { $Drive = $avec[0] }
    elseif ($avec.Count -eq 0 -and @($trouves).Count -eq 1) { $Drive = $trouves[0] }
    elseif (@($trouves).Count -gt 1) { throw ("Plusieurs dossiers _Gantt trouvés : " + ($trouves -join ' | ') + ' : relancer avec -Drive "<le bon>".') }
}
if (-not $Drive) { throw 'Dossier Google Drive _Gantt introuvable : relancer avec -Drive "<chemin du dossier _Gantt>".' }
if (-not (Test-Path -LiteralPath $Drive)) { New-Item -ItemType Directory -Force $Drive | Out-Null }
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
