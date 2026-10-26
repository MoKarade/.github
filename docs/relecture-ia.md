# Relecture IA des PR sur chemins protégés

Choix de Marc du 16/10/2026 (carte « Action Claude ») : il ne fusionne plus de PR à la main. Ce document dit ce que fait la relecture, ce qu'elle ne fait jamais, et les deux secrets à poser.

## Pourquoi
Le blocage principal n'était pas le Garde-fou mais la règle « avis du code owner » de 4 rulesets (décochée par Marc le 16/10, 14 h 22 UTC). Il restait les PR dont le Garde-fou est rouge : cette nuit-là, 9 PR, dont 6 pour une simple ligne `secrets.X` dans un workflow.

## Comment ça marche
1. `relecture-ia.yml` est lancé par le Réacteur à chaque PR fusionnée, CI rouge ou tâche fermée (`scripts/reveil-reacteur.mjs`, tâche #148), quand le Garde-fou d'une PR finit en échec (type `garde_fou_rouge` du Réacteur, dans les dix dépôts : leur `reacteur.yml` écoute `workflow_run: [CI, Garde-fou]`, tâches #626 et #633), par un filet quotidien (`47 9 * * *`, qui a remplacé la planification toutes les 10 minutes le 26/10/2026) et à la demande (« Run workflow »). Elle n'écoute pas elle-même `workflow_run` : le Garde-fou n'accepte un verdict que d'une exécution de `main` lancée par `schedule` ou `workflow_dispatch`. `preparer` cherche, dans les dix dépôts, les PR ouvertes (pas brouillon, branche du dépôt) dont le Garde-fou est rouge et qui n'ont pas encore de verdict de la relecture sur leur commit.
2. Il refait le calcul du Garde-fou (`evaluer`, même code). Si une seule violation n'est pas dans la liste levable ci-dessous, la PR est ignorée : elle reste à Marc.
3. Sinon, l'IA (Claude, `--tools ""` : aucun outil, aucun jeton GitHub, hors du dépôt) reçoit le diff des fichiers concernés et répond une ligne JSON : `approuve` ou `refuse`, avec une raison. Au moindre doute, elle refuse ; une réponse illisible est un refus.
4. `publier` commente la PR et, si l'IA approuve, rejoue le Garde-fou. La première ligne du commentaire est le verdict lu par la machine (`<!-- relecture-ia sha=… decision=… run=… -->`). Le Garde-fou le lit (commentaire de `MoKarade`, pour le commit exact de la PR, avec une exécution de `relecture-ia.yml` sur `main` de ce dépôt), passe au vert, ferme l'éventuelle issue `qui:marc` ; Mergify fusionne si le reste est vert.
5. Un nouveau commit change le SHA : l'avis ne vaut plus, la PR est relue.

Tant que l'IA n'a pas rendu d'avis, le Garde-fou est rouge « en attente de la relecture » et n'ouvre PAS d'issue `qui:marc` ; il l'ouvre seulement si l'IA refuse.

## Ce que l'IA peut lever (`scripts/relecture-regles.mjs`, seule liste)
- référence à un secret de la CI (`secrets.X`) ou à une variable secrète lue sans repli dans un chemin protégé (lire une variable dans le code d'une app n'est plus une violation : tâche #199) ;
- moins de cas de test qu'avant, étapes de contrôle retirées de la CI.

## Ce qui reste à Marc, quoi que dise l'IA
Test sauté ou supprimé, CI affaiblie (`continue-on-error`, `|| true`), seuil de qualité desserré, valeur de secret en clair, `.env`, réglage gitleaks, migration destructive ou réécrite, diff illisible ou trop gros (plus de 30 000 caractères), et le Garde-fou, la relecture, `.mergify.yml` et CODEOWNERS eux-mêmes (sans cela une PR pourrait s'approuver seule).

## Limites connues
- [Probable] Le jeton d'abonnement (`claude setup-token`) sert à l'usage CI ; si Anthropic en change les conditions, la relecture s'arrête et le job devient rouge (aucune PR n'est approuvée par défaut).
- L'avis est celui d'un modèle : une injection de prompt dans le diff est possible. Défenses : balise aléatoire, consigne de refuser toute phrase qui s'adresse au relecteur, aucun outil, liste levable courte, et le verdict ne vaut que pour le commit relu.
- Latence : quelques minutes après la fin du Garde-fou (le Réacteur doit avoir `garde_fou_rouge` dans le `reacteur.yml` du dépôt ; sinon, jusqu'à la prochaine PR fusionnée, CI rouge ou tâche fermée, ou au filet quotidien). Au plus 5 PR par passe.
- Le verdict est un commentaire posé avec le jeton de Marc (compte `MoKarade`). Limite connue : toute session qui commente sous ce compte peut écrire un faux verdict qui cite une vraie exécution de `relecture-ia.yml` ; la vérification de l'exécution écarte un commentaire quelconque, pas cette fraude volontaire. Choisi parce que le jeton du Garde-fou lit les commentaires dans les dix dépôts, privés compris, mais pas les statuts de commit (droit de plus à ajouter dans dix fichiers protégés).

## Les deux secrets (à poser une fois, dépôt MoKarade/.github, Settings > Secrets and variables > Actions)
- `CLAUDE_CODE_OAUTH_TOKEN` : sur le PC, `claude setup-token`, copier le jeton. Pas de facturation en plus : c'est l'abonnement.
- `RELECTURE_PAT` : jeton GitHub « fine-grained », propriétaire `MoKarade`, les 10 dépôts, droits : Actions (lecture et écriture), Pull requests (lecture et écriture), Contents (lecture seule). Rien d'autre : ni Checks, ni Commit statuses. Durée : la plus longue permise ; à renouveler à l'échéance (le job devient rouge sinon).
Jamais par le chat.

## Pannes et noms réservés
- Une erreur de lecture sur une PR ou un dépôt (droit manquant, panne GitHub) n'arrête pas les autres : elle est notée, aucun avis n'est posé pour cette PR, et la dernière étape du job devient rouge avec la liste.
- Le Garde-fou est lu par l'API des exécutions de workflow (droit Actions), pas par celle des contrôles : aucun droit « Checks » à donner au jeton.
- Tout workflow dont le nom de fichier contient `garde-fou` ou `relecture` est traité comme le garde-fou lui-même : jamais levé par l'IA, fusion de Marc.

## La file de Mergify
Quand la PR est en retard sur `main`, Mergify la teste sur une copie : une PR brouillon `mergify/merge-queue/…`, titre « merge queue: checking #N … », nouveau commit. Le Garde-fou y rejoue les mêmes règles, mais la relecture ne relit jamais un brouillon. Le Garde-fou accepte donc la copie seulement si ses fichiers et ses lignes modifiées sont EXACTEMENT ceux de la PR d'origine (ouverte, hors brouillon) ET si la relecture a approuvé le commit actuel de cette PR d'origine (`relectureDeLaFile`). Tout écart : rouge, la PR attend Marc. Constaté le 16/10/2026 sur app-template#76/#83 (copie sortie de la file faute d'avis).

## Un refus prévient Marc
`publier` rejoue le Garde-fou aussi après un refus : il reste rouge et ouvre l'issue `qui:marc`. Sans cela, une PR refusée attendrait sans que personne le sache.

## Avant de modifier le workflow
Lancer `actionlint` sur `relecture-ia.yml` : un workflow invalide ne s'exécute pas et n'affiche qu'une exécution « push » à zéro tâche (cas du 16/10/2026 : `runner.temp` n'existe pas dans `env:` du job).

## Essai
« Run workflow » sur `relecture-ia.yml` : sans PR à relire, la passe dit « 0 PR à relire ». Une PR rouge pour une ligne `secrets.X` sert de cas réel.
