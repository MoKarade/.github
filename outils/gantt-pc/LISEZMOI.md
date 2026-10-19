# Relevé du Gantt sur le PC de Marc

La page « Chantier Apps » (artifact du projet Apps) affiche le backlog, la file du script et les quotas. Ces données viennent d'un
**relevé** qui interroge GitHub toutes les 10 minutes.

**Pourquoi ici (16/10/2026).** Le relevé tournait dans la machine d'une session Claude. Cette machine est recyclée sans prévenir,
deux fois en 30 minutes le 16/10, et le relevé s'arrêtait avec elle. Le relancer coûtait du quota Claude, ce que Marc refuse. Sur
le PC, le relevé tourne sans Claude.

## Comment ça marche

1. La tâche Windows `Gantt-releve` lance `lancer.ps1` toutes les 10 min, dans une console cachée.
2. `lancer.ps1` met à jour ce dépôt (clone dédié dans `C:\dev\_pc-local\gantt-releve\depot`), copie les `.py` dans `C:\dev\_pc-local\gantt-releve`
   et lance `tour.py`.
3. `tour.py` fait un tour : `fetch.py` (GitHub), `quota.py`, `build.py` (file du script `scripts/prochaine-tache.mjs`), mesure de
   fiabilité (`scripts/verif-fidelite.mjs`, au plus 1×/h, sinon instantané de file seul).
4. Filet (`scripts/filet-pc.mjs`, tâche #196) : si un dépôt reste libre avec une tâche prenable plus de 30 min sans lancement, le tour lance
   `boite-reacteur.yml` d'`app-template` pour réveiller le Coordinateur (le `gh` du PC doit pouvoir lancer ce workflow). Son état est dans
   `filet-pc-etat.json`, sa ligne dans `etat.json`.
   Même script, passage quotidien du Réacteur (tâche #143) : dès 6 h 00 heure du Québec, une fois par jour, il lance `reacteur.yml` dans les dix dépôts
   (`gh workflow run`, le `gh` du PC doit pouvoir lancer des workflows sur les dix dépôts) parce que les `schedule` de GitHub ne sont pas garantis. État :
   `filet-pc-etat-quotidien.json`, ligne « filet quotidien : … » dans `etat.json`.
5. Réponses de Marc (`reponses.py`, 19/10) : dans l'onglet « À toi » de la page, un clic « Fait », une réponse préfaite ou « Fusionner »
   dépose `reponse-<horodatage>.json` dans le même dossier `_Gantt`. Au tour suivant, AVANT le relevé, le PC l'applique avec son `gh` :
   commentaire « **Fait** — Marc… » ou « **Réponse de Marc** : … » et retrait de `qui:marc`, ou fusion squash de la PR ; puis il réveille
   le Coordinateur (`boite-reacteur.yml`). Une réponse préfaite n'est acceptée que si elle figure, mot pour mot, dans la section
   `**Réponses**` de l'issue (une puce par option). Le fichier est supprimé une fois traité ; le résultat va dans
   `reponses-journal.json`, que la page lit. Tests : `python -X utf8 -m unittest test_reponses.py`.
6. Les sorties sont déposées dans le Drive, dossier `_Gantt` : `donnees.json.gz` (lu par la page avec le connecteur Google Drive),
   `prochaines.json`, `fiabilite.json`, `quota.json`, `etat.json` (résultat du dernier tour).

## Installer

```powershell
powershell -ExecutionPolicy Bypass -File installer.ps1            # trouve seul <lecteur>:\Mon disque\_Gantt
powershell -ExecutionPolicy Bypass -File installer.ps1 -Drive "G:\Mon disque\_Gantt"
```

Il faut Python 3, Node, `gh` connecté au compte de Marc (accès aux dépôts privés) et Git. L'installateur vérifie chacun en le
lançant, remplace la tâche si elle existe, et fait un premier tour visible.

Le dossier d'état est `C:\dev\_pc-local\gantt-releve` (option `-Etat`), jamais AppData : lancé depuis l'app Claude, AppData
est redirigé vers un dossier privé que la tâche planifiée ne voit pas, et le relevé restait figé sans erreur (16/10).
Google Drive pour ordinateur ne doit pas être en pause : sinon les fichiers restent sur le PC et la page ne les voit pas.
Python pour Windows n'a pas de base de fuseaux horaires (sans le paquet `tzdata`) : `quota.py` replie alors sur la règle d'heure
d'Amérique du Nord, comme `build.py`. Sans ce repli, il mourait à chaque tour et le Drive n'avait pas de `quota.json` (17/10, .github#188).
Un échec de `quota.py` s'écrit désormais dans `etat.json` (« quota : ÉCHEC … »). Sous 3 500 appels GitHub restants, seules les jauges
Claude et coût API sont relevées (≈ 1 appel) : à froid, toutes les jauges coûtent ≈ 2 900 appels.

## Suivre et arrêter

- Journal : `C:\dev\_pc-local\gantt-releve\tour.log` ; dernier résultat : `_Gantt\etat.json` dans le Drive.
- Arrêter : `Unregister-ScheduledTask -TaskName Gantt-releve -Confirm:$false`.

## Source

Ces fichiers sont la copie de `commun/outils/gantt/` des fichiers du projet (fil « Page de suivi »), sans la page elle-même : sans
`page7.html`, `build.py` ne produit que les données. Un changement du relevé se fait ici, par PR ; le PC le prend au tour suivant.
