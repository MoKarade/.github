# Gabarit d'issue « prête pour Jules »

Pour qui : Claude, quand il rédige une issue à confier à Jules (étiquette `jules`). Jules lit **le corps** de l'issue, jamais les commentaires. Les règles qui ne changent pas (français, chemins protégés, `Tâche : #n`, pas de `Fixes`) sont déjà dans le `AGENTS.md` de chaque dépôt : ne les répète pas, ne contredis pas.

Mise en place : MoKarade/.github#76. Proposition d'origine : `commun/plans/2026-10-16_jules-a-plein-regime.md`.

**Automatique** : une issue qui porte l'étiquette `faisable-jules` et dont le corps respecte ce gabarit (sections non vides, deux fichiers au plus, aucun chemin de la liste « à garder pour Claude » ci-dessous) est confiée à Jules par le filet du PC, sans Claude, dès que son dépôt est libre ; règles exactes dans `docs/cycle-de-vie-tache.md` §5 quater et `scripts/jules-auto.mjs`. Une issue au gabarit est donc prête à partir seule : pose `faisable-jules` en la rédigeant.

## Gabarit à copier dans le corps de l'issue

```
**Avant** : <ce qui est vrai aujourd'hui, une ou deux phrases, avec le chemin du fichier>

**Après** : <ce qui doit être vrai, observable>

**Fini quand** : <une commande à lancer ou un comptage à montrer, avec le résultat attendu>

**Fichiers permis** (aucun autre) :
- `chemin/exact/un.ext`
- `chemin/exact/deux.ext`

**À faire, dans cet ordre** :
1. <étape précise>
2. <étape précise>

**À ne pas faire** : <le débordement le plus probable, nommé>

**Vérifier** : <commande de test ciblée>

**Source** : <BACKLOG.md:Lnn, ADR, ou issue parente>

**À citer dans la PR** : `Tâche : #<numéro de CETTE issue>` ; sujet de commit : `<préfixe permis>: <type>: <verbe et objet>`
```

## Règles de rédaction

1. Un seul objectif. Pas de « OU » : Jules fait alors les deux (constat Hubperso#146).
2. Des chemins exacts, vérifiés (Grep ou carnet NotebookLM `carnet`), jamais devinés.
3. Un « Fini quand » qu'un script peut contrôler ; sinon la tâche n'est pas prête.
4. Une tâche tient en deux fichiers au plus et environ 150 lignes de diff ; au-delà, on découpe.
5. Aucune donnée personnelle dans l'issue (dépôts publics). Exemples et jeux d'essai fictifs.
6. Écrire en toutes lettres le numéro de l'issue et le préfixe de commit permis : Jules copie sinon l'ID de la ligne « Source » (constat Hubperso#147 : `[H-25]` et `Tâche : #25`). Hubperso : `HORS-BACKLOG:` tant que `BACKLOG.md` n'est pas un fichier permis.

## Tâches qui conviennent à Jules

Tests unitaires d'une fonction pure existante ; test de liens ou de présence de fichiers ; doc courte (un fichier de moins de 150 lignes ou une section ciblée) ; commentaire de code manquant ; remplacement mécanique d'un terme sur une liste fermée de fichiers ; ajout d'un cas dans un tableau de données de test.

## Tâches à garder pour Claude

Chemin protégé, base de données, migration, authentification, secret, dépendances, moteur DriveAI, contrat, `BACKLOG.md` / `HANDOVER.md` / autre long `.md` à réécrire (Jules y abîme des mots français, voir Hubperso#197), tout ce qui change un écran sans captures, tout ce qui demande un choix de conception.

## Après la PR de Jules

Claude relit le diff dans les minutes qui suivent (Mergify fusionne en 3 min quand tout est vert) : fichiers touchés ⊆ « Fichiers permis », aucun mot français devenu anglais, pas de `Fixes`. Si la doc est touchée, poser `hold` avant de relire. La preuve « Acceptée » est posée par Claude sur l'issue. Si l'issue se ferme quand même à la fusion (un `Fixes #n` s'est glissé dans la PR), le garde-fou de preuve (`docs/cycle-de-vie-tache.md` §10 bis) la rouvre dans la minute avec l'étiquette `preuve-manquante` : ce n'est pas un incident, la preuve reste due. Une preuve écrite par Jules n'est jamais acceptée.
