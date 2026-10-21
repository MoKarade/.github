# Graphe de code local (graphifyy) : hooks, wiki et MCP

**Statut : déployé le 21/10/2026 (choix de Marc : runbook complet), tâche MoKarade/.github#336, modèle du pilote app-template (#323).** Le graphe est construit à chaque démarrage de session, sans jeton, et interrogé avant de lire ou grepper des fichiers.

## Ce qui est posé
- `scripts/graphe.sh` : seul point d'entrée (version épinglée `graphifyy[sql,mcp]==0.9.93`, venv dans `~/.cache`, `GRAPHIFY_BACKEND=none`). `update`, `query "<question>"`, `affected "<symbole>"`, `path "A" "B"`, `explain "<symbole>"`, `god-nodes`, `wiki`, `serve`, `session`, `hook-guard`.
- `.claude/settings.json` : hook `SessionStart` (rend `graphify` utilisable dans la session via `CLAUDE_ENV_FILE`, puis construit le graphe ET le wiki EN ARRIÈRE-PLAN, sans jamais bloquer ni échouer) ; hooks `PreToolUse` sur `Bash|Grep` et `Read|Glob` (rappel « interroge le graphe d'abord », silencieux tant que le graphe n'existe pas ; échec ouvert).
- `.mcp.json` : serveur MCP `graphify` en stdio (`query_graph`, `get_node`, `get_neighbors`, `get_community`, `god_nodes`, `graph_stats`, `shortest_path`, `list_prs`, `get_pr_impact`, `triage_prs`), à approuver à la première ouverture.
- `graphify-out/` (graphe, rapport, wiki, cache) : généré, JAMAIS committé. Le wiki (`graphify-out/wiki/index.md`) sert de plan de navigation.
- Un pointeur d'une ligne dans `README.md` (ce dépôt n'a pas de `CLAUDE.md` ; `AGENTS.md` reste réservé aux consignes de Jules). Pas les 11 lignes de l'installeur officiel.

## Règles (chacune vient d'un constat)
- **0 jeton, 0 clé** : `update` est local (Tree-sitter), sans appel réseau ni LLM ; le paquet ne contacte le réseau que pour `add`, `clone` et les commandes LLM. [Certain, code lu et `strace`]
- **Jamais `label` ni `cluster-only` sans `GRAPHIFY_BACKEND=none`** : sans clé API ils se replient sur `claude -p` et consomment le quota Claude. [Certain]
- **N'utilise PAS l'installeur officiel** (`graphify claude install`, `graphify hook install`, skill `/graphify`) : il réécrit `CLAUDE.md`, pose des hooks vers un chemin absolu et la skill lance des sous-agents LLM. Tout passe par `scripts/graphe.sh`. [Certain]
- **`graphify-out/` jamais versionné** : les commentaires `TODO:`/`NOTE:`/`FIXME:` et les docstrings y sont copiés (80 caractères, e-mails compris) ; `graph.html` charge unpkg. Dépôt public : aucune donnée perso dans un commentaire de code. [Certain]
- **Toujours depuis la racine** : `graphify update /chemin/absolu` écrit ce chemin dans `.graphify_root`. [Certain]
- **Version épinglée** : le paquet sort presque une version par jour ; monter la version = relancer la mesure ci-dessous. Sans l'extra `[sql]`, les migrations `.sql` donnent 0 nœud. [Certain]
- **Les hooks de dépôt ne tirent que si la session démarre DANS le dépôt** (constat du 18/10/2026 : un fil du projet lancé depuis `/home/user` ne charge pas `.claude/settings.json`). [Probable] Dans ce cas il reste `scripts/graphe.sh` à la main.
- **Le rappel injecté dit « MANDATORY »** : c'est le texte du paquet, posé par NOTRE hook ; il coûte ~110 jetons par `Grep`/`Bash` quand le graphe existe.

## Ce que ça apporte, ce que ça n'apporte pas (mesure BatchChef, 21/10/2026, 290 fichiers)
- Le « 61,6x » de `graphify benchmark` compare à la lecture de TOUT le dépôt, ce que personne ne fait. Contre `grep` + lecture du fichier utile, sur 4 questions à symbole connu : 12,3 k jetons contre 12,0 k (requête + extrait), aucun gain net ; la requête ramène des nœuds génériques. [Certain pour ces 4 questions, n = 4]
- Ce que `grep` ne donne pas : `affected "X"` rend les importeurs transitifs ET les documents qui citent X, avec fichier:ligne. [Certain]
- Les chiffres du document source (71,5x, -80 %, 76 % LongMemEval) viennent du fournisseur, sur d'autres corpus. [Probable]

## Page visuelle lisible (tâche MoKarade/.github#371, 21/10/2026)
- `graph.html` complet (fait par `graphify update`) est illisible : 25 à 40 % de nœuds de documents, des titres de doc en tête des « god nodes », 1 à 7 k nœuds. Il reste utile pour les requêtes, pas pour regarder.
- `scripts/graphe-page.py GRAPH_JSON SORTIE.html [--max-noeuds 400] [--titre …]` produit une vue par FICHIER : code des dossiers sources seulement (sans tests, générés, dépendances, config, docs, fichiers isolés), un lien = au moins un appel ou import entre deux fichiers, couleur = dossier, panneau sous le graphe sur téléphone. Local, 0 jeton, 0 réseau ; interprète : celui du venv de `graphe.sh` (`~/.cache/graphe-venv-<version>/bin/python`).
- Mesure du 21/10/2026 sur les 9 dépôts clonés (fichiers sur la page / poids du HTML) : app-template 20 (34 Ko), DriveAI 53 (75 Ko), Hubperso 98 (115 Ko), batchchef 135 (142 Ko), MemoryAI 159 (217 Ko), CarAI 170 (199 Ko), JobAI 214 (252 Ko), FinanceAI 400 plafonné (680 Ko ; 623 fichiers reliés avant plafond), hub-contract 2. Avant : 0,2 à 2,6 Mo. [Certain, mesuré]
- Rendu vérifié en Chromium sans tête à 1280 et 390 px (JobAI, CarAI) ; le panneau passe sous le graphe à moins de 700 px. Le moteur `.gs` de DriveAI n'est pas dans cette page (second graphe, `graphe.sh moteur`).
- `graph.html` charge `vis-network` depuis unpkg : une page publiée doit le servir ou l'accepter. Les requêtes (`query`, `affected`) gardent le graphe complet.

## Retour arrière
Supprimer `.claude/settings.json` (ou ses trois blocs), `.mcp.json`, `scripts/graphe.sh`, `.graphifyignore`, les deux lignes de `.gitignore` et la ligne de `CLAUDE.md`. Rien d'autre n'a été modifié.

Évaluation : commun/plans/2026-10-21_graphify-analyse.md. Mesure à refaire sur 10 questions réelles après un jour d'usage.
