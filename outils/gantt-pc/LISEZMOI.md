# Relevé du Gantt sur le PC de Marc

La page « Chantier Apps » (artifact du projet Apps) affiche le backlog, la file du script et les quotas. Ces données viennent d'un
**relevé** qui interroge GitHub toutes les 10 minutes.

**Pourquoi ici (16/10/2026).** Le relevé tournait dans la machine d'une session Claude. Cette machine est recyclée sans prévenir,
deux fois en 30 minutes le 16/10, et le relevé s'arrêtait avec elle. Le relancer coûtait du quota Claude, ce que Marc refuse. Sur
le PC, le relevé tourne sans Claude.

## Comment ça marche

1. La tâche Windows `Gantt-releve` lance `lancer.ps1` toutes les 10 min, dans une console cachée.
2. `lancer.ps1` met à jour ce dépôt (clone dédié dans `%LOCALAPPDATA%\Gantt\depot`), copie les `.py` dans `%LOCALAPPDATA%\Gantt`
   et lance `tour.py`.
3. `tour.py` fait un tour : `fetch.py` (GitHub), `quota.py`, `build.py` (file du script `scripts/prochaine-tache.mjs`), mesure de
   fiabilité (`scripts/verif-fidelite.mjs`, au plus 1×/h, sinon instantané de file seul).
4. Les sorties sont déposées dans le Drive, dossier `_Gantt` : `donnees.json.gz` (lu par la page avec le connecteur Google Drive),
   `prochaines.json`, `fiabilite.json`, `quota.json`, `etat.json` (résultat du dernier tour).

## Installer

```powershell
powershell -ExecutionPolicy Bypass -File installer.ps1            # trouve seul <lecteur>:\Mon disque\_Gantt
powershell -ExecutionPolicy Bypass -File installer.ps1 -Drive "G:\Mon disque\_Gantt"
```

Il faut Python 3, Node, `gh` connecté au compte de Marc (accès aux dépôts privés) et Git. L'installateur vérifie chacun en le
lançant, remplace la tâche si elle existe, et fait un premier tour visible.

## Suivre et arrêter

- Journal : `%LOCALAPPDATA%\Gantt\tour.log` ; dernier résultat : `_Gantt\etat.json` dans le Drive.
- Arrêter : `Unregister-ScheduledTask -TaskName Gantt-releve -Confirm:$false`.

## Source

Ces fichiers sont la copie de `commun/outils/gantt/` des fichiers du projet (fil « Page de suivi »), sans la page elle-même : sans
`page7.html`, `build.py` ne produit que les données. Un changement du relevé se fait ici, par PR ; le PC le prend au tour suivant.
