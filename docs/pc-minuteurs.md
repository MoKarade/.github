# Les minuteurs Windows du PC

Tâche .github#777 (mission #703, phase 4), demande de Marc du 28/10/2026 : « RIEN AVEC TIMER, TOUT ÉVÉNEMENTS ». Relevé en lecture seule du 29/10/2026 à 01:41Z, fait par le fil PC : rien n'a été modifié, lancé ni désactivé. Les chiffres viennent du PC (`schtasks /query /v`, lecture des scripts, `gh api rate_limit` avant et après les deux recherches des scripts) ; ce qui n'a pas été mesuré est dit.

## Le tableau

Les six tâches sont « Ready », dernier résultat 0. Aucune n'utilise de jeton nommé : tout passe par la CLI `gh`, avec le jeton du trousseau de l'utilisateur du PC.

| Tâche | Minuteur | Lit | Écrit | Appels GitHub (mesurés) | Décision proposée |
|---|---|---|---|---|---|
| Carnet questions (`file_carnet.py`) | 10 min | `gh search issues --label carnet --state open` | Un commentaire puis la fermeture par question ouverte ; la réponse vient de NotebookLM (profil Chrome du PC) | À vide : 1 recherche (bucket `search`), 0 `core`, 0 écriture | Gardée avec minuteur, ou événement par l'écouteur du PC (voir plus bas) |
| Gemini-demandes (`gemini_demandes.py`) | 10 min | 2 recherches (issues étiquetées `gemini`, PR ouvertes depuis moins de 24 h) | Avis, étiquettes `gemini:fait` / `gemini:echec`, incidents | À vide : 2 recherches, 0 `core`. Avec une demande : événements, diff et fichiers de la PR (`core`, plusieurs appels) | Gardée avec minuteur, ou événement par l'écouteur du PC |
| NotebookLM sync (`sync_notebooklm.py`) | 15 min | Git local de chaque dépôt (Repomix) | Un fichier Markdown par dépôt dans le dossier Drive pour ordinateur | Aucun | Gardée : ne parle pas à GitHub, écrit dans Drive depuis le PC |
| NotebookLM connexion (`garder_connexion.py`) | 15 min | Le profil Chrome dédié | `storage_state.json`, `etat-connexion.json`, journal | Aucun | Gardée : garder une session ouverte est un geste du temps, pas d'un événement |
| Carnet dépôts directs (`carnet_direct.py --tous`) | 2 h | `git fetch` / `ls-tree` / `show` de .github, app-template, claude-config | Sources NotebookLM (dernier passage : 22 ajoutées, 17 retirées) et fichiers d'état locaux | 0 tant que les trois clones existent (`gh repo view` et `gh repo clone` seulement s'il en manque un) | Gardée, ou événement « push sur la branche par défaut » par l'écouteur du PC |
| Quota-Claude (`quota_claude.py`) | 1 h | `claude -p "/usage"` (aucun appel au modèle) | Le corps de l'issue .github#45 | 1 `gh issue edit` par heure (bucket `graphql`) | Gardée : la mesure du quota Claude n'émet aucun événement GitHub |

## Ce que le relevé change

- **Aucune des six ne touche le bucket REST `core` à vide** (recherches et `graphql` seulement). Elles n'expliquent donc pas les 437 appels en 5,5 minutes hors tour mesurés le 28/10/2026 ni les environ 100 appels `core` hors tour. La cause de ces appels reste à trouver dans la mesure de #741 (`sonde_rest.py`). Les mesurer ici n'a pas été possible plus finement : le tour du relevé court en parallèle et fausse un avant/après, et ces scripts n'utilisent pas `ghcache.py`, donc aucun journal ne les compte.
- **« Remplacer par un événement » n'est pas possible tel quel pour ces six** : GitHub ne peut pas lancer une tâche du PC (le PC n'écoute rien, aucune entrée vers lui). Deux voies réelles :
  1. Déplacer la tâche dans un workflow GitHub Actions déclenché par l'événement : impossible ici, car chacune dépend de quelque chose qui n'existe que sur le PC (profil Chrome de NotebookLM, dossier Drive, Gemini local, clones locaux).
  2. Un écouteur permanent sur le PC qui reçoit l'événement et lance le script. Le chantier de la boîte « preuve PC » (.github#807 et #808) pose déjà une écoute du PC ; elle pourrait servir à Carnet questions, Gemini-demandes et Carnet dépôts directs. [Supposition] à confirmer avec le fil qui livre #808 : l'écoute tient-elle en permanence, et à quel coût ?
- **Ne pas baisser la fréquence pour masquer le coût** (règle de la tâche) : un minuteur plus large ne rend pas la tâche événementielle ; il ne se décide qu'avec la carte de Marc.

## Décision attendue de Marc

Garder ou non ces minuteurs contredit « rien avec minuteur » : la décision est posée à Marc en carte (une question, trois options, une recommandation). Tant qu'il n'a pas répondu, rien n'est retiré ni converti sur le PC. Les tâches retirées ou converties le seront une par une par le fil PC, avec le coût avant et après notés ici.

## Mesure de la baisse hors tour

Le critère « moins de 100 appels REST par heure hors tour du relevé » se mesure avec `sonde_rest.py` sur 1 h (tâche #741). Valeur à noter ici après la décision de Marc : _non mesurée à la date de ce fichier_.
