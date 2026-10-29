# Boucle d'erreurs : un échec de pilotage devient une issue

Demande de Marc (28/10/2026) : « rien ne se perd, aucun oubli, aucune erreur inconnue, tout dans les graphes de chantier, tout à jour tout le temps ». Mission MoKarade/.github#703, tâche #714.

## Le principe

Un workflow de pilotage (Réacteur, relecture IA, commentaire tâche liée, surveillance, rapport hebdomadaire) peut échouer sans que personne le voie : la ligne rouge reste dans Actions. `signaler-echec.yml` écoute la FIN de ces workflows (événement `workflow_run`, aucun minuteur) et appelle `scripts/boucle-erreur.mjs` :

| Fin du workflow | Ce qui se passe |
| --- | --- |
| Premier échec (`failure`, `timed_out`) | Une issue `boucle:erreur` s'ouvre : « Échec : <workflow> dans <dépôt> ». Corps : lien du run, commit, job et étape en échec. |
| Échec suivant, issue encore ouverte | Un commentaire sur cette issue. Jamais une seconde issue pour le même couple (dépôt, workflow). |
| Succès suivant | Un commentaire puis l'issue est fermée. |
| Annulé, ignoré, neutre | Rien. |

L'issue est une issue ordinaire : la page Chantier la lit comme n'importe quelle autre (une barre de plus), sans code de plus.

## Ce qui ne s'y trouve jamais

- Aucun journal : seulement le nom du job et de l'étape en échec. Tout texte passe par `nettoyer` (jetons GitHub, `Bearer`, `password=…`, longues chaînes hexadécimales ou base64 remplacés par `[retiré]`, une seule ligne, 160 caractères au plus).
- Aucun secret, aucun cron, aucune ligne `secrets.` : le workflow utilise `github.token`.
- Le signalement ne se signale pas lui-même, et un signalement qui échoue n'est qu'un avertissement (`::warning::`) : le run d'origine reste rouge dans Actions, rien n'est caché.

## Dans les autres dépôts

Le fichier est réutilisable (`workflow_call`). L'issue s'ouvre dans le dépôt où l'échec a eu lieu, avec le jeton de ce dépôt (un jeton ne peut pas écrire dans un autre). L'appel dans les dix autres dépôts vient avec la tâche qui retire les crons du Réacteur (MoKarade/.github#712).

## Vérifier

`node --test scripts/boucle-erreur.test.mjs` (contrôle « Tests de la boucle d'erreurs »). En production : un workflow d'essai qui échoue ouvre l'issue en moins de 2 minutes ; son succès suivant la referme.

## Le guetteur de silence (tâche #720)

Un échec qui s'exécute laisse une trace ; un ARRÊT complet (Réacteur en panne, réveils perdus, Actions indisponible) n'en laisse aucune. Décision de Marc (29/10/2026, 15:06Z) : UptimeRobot est payant, le guetteur tourne **sur le PC** (exception voulue à « rien ne s'active sur le tour du PC », elle reste quand #718 éteint le tour). Limite dite à Marc : **PC éteint, aucune alerte**.

| Ce qu'il voit | Ce qui se passe |
| --- | --- |
| Aucun run terminé (succès ou échec) du Réacteur de `.github` depuis plus de 2 h (`SILENCE_MAX_H`) | Une issue `boucle:erreur` « Silence : le Réacteur de .github ne traite plus rien » s'ouvre, une seule par silence. |
| Un run récent alors que l'issue est ouverte | Un commentaire de reprise, puis l'issue est fermée. |
| L'API GitHub échoue ou répond n'importe quoi | « Guetteur aveugle » dans le journal du PC. Jamais une alerte de silence : on ne sait pas. |
| Jeton `gh` absent | Rien, le tour n'échoue pas. |

L'état vit dans GitHub (l'issue ouverte), pas sur le PC : un redémarrage ne double pas l'alerte. Un run « skipped » ne compte pas (l'issue d'alerte lance elle-même le Réacteur, qui s'ignore). Aucun secret écrit, aucune ligne `secrets.`, aucun cron GitHub : le jeton vient de `gh auth token` sur le PC.

Code : `scripts/guetteur-silence.mjs` (tests : `node --test scripts/guetteur-silence.test.mjs`, contrôle « Tests du guetteur de silence »). Lanceur Windows : `outils/gantt-pc/guetteur.ps1`, tâche « Guetteur-silence » toutes les 15 min en `conhost.exe --headless` (installation : `outils/gantt-pc/LISEZMOI.md`).
