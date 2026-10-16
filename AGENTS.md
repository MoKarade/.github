# AGENTS.md : consignes permanentes pour les agents (Jules)

Ce fichier dit comment travailler ici. `CLAUDE.md` fait foi pour le métier (garde-fous, données, sécurité) : lis les deux. Mis en place par MoKarade/.github#76.

## Périmètre
- L'issue est ta seule consigne. Si elle liste des « Fichiers permis », ne touche à AUCUN autre fichier, même pour « bien faire ». Si la tâche exige davantage, arrête-toi et écris-le dans la PR au lieu d'élargir.
- Une issue, une PR, un seul objectif. Aucun refactor, renommage ni changement de dépendance qui n'est pas demandé. Si l'issue offre un « OU », prends la première branche et seulement elle.

## Interdits
- Chemins protégés : `.github/`, `scripts/`, `surveillance/`, `.mergify.yml`.
- Secrets, jetons, clés, authentification, droits d'accès, migrations de base.
- Toute donnée personnelle de Marc (adresse, montant réel, nom de tiers) dans le code, les tests, la doc ou le texte de la PR : données fictives seulement.
- Désactiver, sauter ou affaiblir un test, un seuil ou un contrôle.
- Modifier `package.json` ou le fichier de verrouillage des dépendances, sauf si l'issue le demande.
- Ce dépôt sert tous les autres : une phrase fausse dans `docs/` se propage partout. Vérifie chaque chemin et chaque nom que tu cites.

## Français
- Code, commentaires, docs, commits et PR en français. Ne traduis rien, ne « corrige » aucun mot français existant, accents compris, hors des lignes que l'issue te demande de changer.
- Relis ton diff avant de livrer : aucun mot français existant ne doit devenir anglais ni perdre un accent.
- Un fichier `.md` existant de plus de 150 lignes : modifie seulement les lignes visées, jamais de réécriture complète. Si la tâche t'y oblige, arrête-toi et dis-le.

## Livrer
- Branche par défaut : `main`. PR vers `main`, en brouillon si tu peux.
- Titre `type: verbe et objet en français` (`docs:`, `test:`, `fix:`, `chore:`). Corps : Avant / Après / Comment.
- Une ligne `Tâche : #<numéro de l'issue>` (ou `Tâche : MoKarade/<dépôt>#n`). N'écris jamais `Fixes`, `Closes` ni `Resolves` : la tâche se ferme seulement par la preuve « Acceptée » posée par Claude.
- Avant de livrer, lance : `node --test scripts/`. Montre dans la PR la sortie de la commande du « Fini quand » de l'issue.
- Une PR qui change un écran porte des captures avant/après prises avec des données fictives.
