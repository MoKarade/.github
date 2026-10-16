# Relecture IA des PR sur chemins protégés

Choix de Marc du 16/10/2026 (carte « Action Claude ») : il ne fusionne plus de PR à la main. Ce document dit ce que fait la relecture, ce qu'elle ne fait jamais, et les deux secrets à poser.

## Pourquoi
Le blocage principal n'était pas le Garde-fou mais la règle « avis du code owner » de 4 rulesets (décochée par Marc le 16/10, 14 h 22 UTC). Il restait les PR dont le Garde-fou est rouge : cette nuit-là, 9 PR, dont 6 pour une simple ligne `secrets.X` dans un workflow.

## Comment ça marche
1. `relecture-ia.yml` passe toutes les 10 minutes (et à la demande : « Run workflow »). `preparer` cherche, dans les dix dépôts, les PR ouvertes (pas brouillon, branche du dépôt) dont le Garde-fou est rouge et qui n'ont pas encore de statut « Relecture IA » sur leur commit.
2. Il refait le calcul du Garde-fou (`evaluer`, même code). Si une seule violation n'est pas dans la liste levable ci-dessous, la PR est ignorée : elle reste à Marc.
3. Sinon, l'IA (Claude, `--tools ""` : aucun outil, aucun jeton GitHub, hors du dépôt) reçoit le diff des fichiers concernés et répond une ligne JSON : `approuve` ou `refuse`, avec une raison. Au moindre doute, elle refuse ; une réponse illisible est un refus.
4. `publier` pose le statut « Relecture IA » sur le commit, commente la PR et, si l'IA approuve, rejoue le Garde-fou. Le Garde-fou lit le statut (il doit venir de `MoKarade` ET pointer vers une exécution de `relecture-ia.yml` sur `main` de ce dépôt), passe au vert, ferme l'éventuelle issue `qui:marc` ; Mergify fusionne si le reste est vert.
5. Un nouveau commit change le SHA : l'avis ne vaut plus, la PR est relue.

Tant que l'IA n'a pas rendu d'avis, le Garde-fou est rouge « en attente de la relecture » et n'ouvre PAS d'issue `qui:marc` ; il l'ouvre seulement si l'IA refuse.

## Ce que l'IA peut lever (`scripts/relecture-regles.mjs`, seule liste)
- référence à un secret de la CI (`secrets.X`) ou à une variable secrète lue dans le code ;
- moins de cas de test qu'avant, étapes de contrôle retirées de la CI.

## Ce qui reste à Marc, quoi que dise l'IA
Test sauté ou supprimé, CI affaiblie (`continue-on-error`, `|| true`), seuil de qualité desserré, valeur de secret en clair, `.env`, réglage gitleaks, migration destructive ou réécrite, diff illisible ou trop gros (plus de 30 000 caractères), et le Garde-fou, la relecture, `.mergify.yml` et CODEOWNERS eux-mêmes (sans cela une PR pourrait s'approuver seule).

## Limites connues
- [Probable] Le jeton d'abonnement (`claude setup-token`) sert à l'usage CI ; si Anthropic en change les conditions, la relecture s'arrête et le job devient rouge (aucune PR n'est approuvée par défaut).
- L'avis est celui d'un modèle : une injection de prompt dans le diff est possible. Défenses : balise aléatoire, consigne de refuser toute phrase qui s'adresse au relecteur, aucun outil, liste levable courte, et le statut ne vaut que pour le commit relu.
- Latence : jusqu'à 10 minutes après le Garde-fou rouge. Au plus 5 PR par passe.
- Le statut est posé avec le jeton de Marc (compte `MoKarade`) : quiconque détient ce jeton pourrait poser un statut ; d'où la vérification de l'exécution `relecture-ia.yml`, qu'on ne peut pas fabriquer à la main.

## Les deux secrets (à poser une fois, dépôt MoKarade/.github, Settings > Secrets and variables > Actions)
- `CLAUDE_CODE_OAUTH_TOKEN` : sur le PC, `claude setup-token`, copier le jeton. Pas de facturation en plus : c'est l'abonnement.
- `RELECTURE_PAT` : jeton GitHub « fine-grained », propriétaire `MoKarade`, les 10 dépôts, droits : Actions (lecture et écriture), Commit statuses (lecture et écriture), Pull requests (lecture et écriture), Contents (lecture seule). Durée : la plus longue permise ; à renouveler à l'échéance (le job devient rouge sinon).
Jamais par le chat.

## Avant de modifier le workflow
Lancer `actionlint` sur `relecture-ia.yml` : un workflow invalide ne s'exécute pas et n'affiche qu'une exécution « push » à zéro tâche (cas du 16/10/2026 : `runner.temp` n'existe pas dans `env:` du job).

## Essai
« Run workflow » sur `relecture-ia.yml` : sans PR à relire, la passe dit « 0 PR à relire ». Une PR rouge pour une ligne `secrets.X` sert de cas réel.
