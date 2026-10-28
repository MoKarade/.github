# Gabarit de tâche : Migration de {{app}} vers le modèle {{nouveau}}

**Avant** : L'application {{app}} utilise le modèle {{ancien}} (famille {{famille}}).

**Après** : L'application {{app}} utilise le modèle {{nouveau}} (famille {{famille}}). L'ancien modèle {{ancien}} est retiré du code, des tarifs actifs, des tests et des docs.

**Fini quand** : `npm run test` (ou la commande de tests du dépôt) vert sur le commit fusionné.

**À faire** :
1. Identifier toutes les occurrences de {{ancien}} dans le dépôt.
2. Mettre à jour la configuration et le code pour remplacer {{ancien}} par {{nouveau}}.
3. Adapter le code selon les contraintes de la section « À surveiller ».
4. Mettre à jour les grilles tarifaires et les tests.
5. Conserver uniquement la table de prix en lecture seule nécessaire aux anciens compteurs.

**À ne pas faire** :
- Ne modifier aucun autre fichier.
- Ne pas inventer de changement cassant absent de la liste ci-dessus.
- Aucun secret.
- Aucune donnée personnelle.

**À surveiller** :
- temperature, top_p, top_k sont refusés (erreur 400) ; budget_tokens refusé, pensée adaptative seulement ;
- la pensée est activée par défaut et comptée dans max_tokens : lire les blocs de réponse par type, jamais par position ;
- Sonnet 5.5 et Opus 5.5 refusent tool_choice « any » / « tool » et thinking: disabled (Sonnet 5.5 accepte between_tools) ; Haiku 5.5 accepte disabled à effort ≤ high ;
- le préremplissage de la réponse (prefill) est refusé ;
- les blocs de pensée se renvoient tels quels, l'historique ne se fait qu'en ajout ;
- nouveau tokenizer (+30 % de jetons pour Haiku 5.5) : revoir max_tokens et les coûts estimés ;
- un refus est possible (stop_reason: refusal) : le code doit le traiter, pas l'avaler ;
- tableaux de prix indexés par préfixe : claude-sonnet-5 capte claude-sonnet-5-5 (piège) ; mettre le préfixe le plus long d'abord ;
- supprimer l'ancien identifiant du code, des tarifs, des tests et des docs, SAUF une table de prix en lecture seule qui sert à relire d'anciens compteurs (dire laquelle dans la PR) ;
- prix à reprendre de la page officielle du jour, avec la date de relevé (au 2026-10-28 : Haiku 5.5 0,10/0,50 $, Sonnet 5.5 2/10 $, Opus 5.5 4/20 $ par million de jetons, lecture du cache ×0,05).

**Vérifier** : npm run test (ou la commande de tests du dépôt) vert sur le commit fusionné.

**Fichiers permis** (« à déterminer par recherche de {{ancien}} dans le dépôt ») :
- Fichiers contenant la chaîne {{ancien}}.

**Source** : Migration de {{app}} de {{ancien}} vers {{nouveau}} (famille {{famille}}).
