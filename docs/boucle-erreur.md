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
