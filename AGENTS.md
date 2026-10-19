# AGENTS.md : consignes permanentes pour les agents (Jules)

Ce fichier dit comment travailler ici. `CLAUDE.md` fait foi pour le métier (garde-fous, données, sécurité) : lis les deux. Mis en place par MoKarade/.github#76.

## Périmètre
- L'issue est ta seule consigne. Si elle liste des « Fichiers permis », ne touche à AUCUN autre fichier, même pour « bien faire ». Si la tâche exige davantage, arrête-toi et écris-le dans la PR au lieu d'élargir.
- Une issue, une PR, un seul objectif. Aucun refactor ni renommage qui n'est pas demandé. Si l'issue offre un « OU », prends la première branche et seulement elle.
- Une tâche tient en cinq fichiers et environ 400 lignes de diff au plus. Si elle exige davantage, arrête-toi et écris-le dans la PR.

## Interdits
- Chemins protégés : `scripts/`, `surveillance/`, `.mergify.yml`. Les workflows de `.github/` ne se modifient que si l'issue les liste dans « Fichiers permis » (jamais `garde-fou*.yml`, la relecture IA, `CODEOWNERS`) ; aucune référence `secrets.` ni permission élargie.
- Secrets, jetons, clés, authentification, droits d'accès, migrations de base (y compris une simple référence `secrets.X` ou une variable d'environnement secrète).
- Toute donnée personnelle de Marc (adresse, montant réel, nom de tiers) dans le code, les tests, la doc ou le texte de la PR : données fictives seulement.
- Désactiver, sauter ou affaiblir un test, un seuil ou un contrôle.
- Dépendances : `package.json` et le fichier de verrouillage ne changent que si l'issue le demande, pour une mise à jour mineure ou un correctif, avec `npm audit --omit=dev` à 0 dans la PR ; jamais de version majeure, jamais `--force`, jamais un plancher redescendu.
- Ce dépôt sert tous les autres : une phrase fausse dans `docs/` se propage partout. Vérifie chaque chemin et chaque nom que tu cites.

## Français
- Code, commentaires, docs, commits et PR en français. Ne traduis rien, ne « corrige » aucun mot français existant, accents compris, hors des lignes que l'issue te demande de changer.
- Relis ton diff avant de livrer : aucun mot français existant ne doit devenir anglais ni perdre un accent.
- Un fichier `.md` existant de plus de 150 lignes se modifie, mais seulement aux lignes visées, jamais en réécriture complète. Les mots français ont été abîmés par le passé (accepté devenu accepted, espacé devenu espaced, dédié devenu dedicated, appliquant devenu applying) : écris et relis en FRANÇAIS, compare ton diff ligne à ligne, et ne touche à aucun mot français existant hors de la ligne demandée.

## Livrer
- Branche par défaut : `main`. PR vers `main`, en brouillon si tu peux.
- Titre `type: verbe et objet en français` (`docs:`, `test:`, `fix:`, `chore:`). Corps : Avant / Après / Comment.
- Une ligne `Tâche : #<numéro de l'issue>` (ou `Tâche : MoKarade/<dépôt>#n`). N'écris jamais `Fixes`, `Closes` ni `Resolves` : la tâche se ferme seulement par la preuve « Acceptée » posée par Claude.
- Avant de livrer, lance : `node --test scripts/`. Montre dans la PR la sortie de la commande du « Fini quand » de l'issue.
- Une PR qui change un écran porte des captures avant/après prises avec des données fictives, laisse verts les tests de thème (couleurs en variables, cibles de 44 px) et ne change ni le comportement ni les textes au-delà de la demande.
