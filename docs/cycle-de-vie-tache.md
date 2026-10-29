# Cycle de vie d'une tâche

> Une page, la version courte. L'ancien texte complet (574 lignes, avec ses « § n ») est conservé dans
> [`docs/archive/cycle-de-vie-tache-2026-10-29.md`](archive/cycle-de-vie-tache-2026-10-29.md) ; il ne décrit plus l'état réel.
> On change cette page par une PR sur ce dépôt. Une copie qui la contredit a tort.

## 1. La chaîne, en 7 étapes

1. **Une issue de tâche** (étiquette `niveau:tâche`, rattachée à une mission). Son corps suit le gabarit : **Avant** (ce que Marc voit aujourd'hui), **Après** (ce qu'il verra), **Fini quand** (critère vérifiable en production), **Fichiers touchés** (puces de chemins entre `backticks`, facultatif), **Source** (d'où vient la tâche), **Attend** (`aucune`, ou `#n — raison` ; la ligne existe toujours).
2. **Un fil ou l'agent prend une tâche ouverte** et pose l'étiquette `en-cours`. Une tâche, une PR (environ 400 lignes modifiées au plus, hors tests et fichiers générés).
3. **Branche `claude/<slug>` et PR en brouillon**, base explicite. Le corps de la PR contient `Tâche : #n` (ou `Tâche : MoKarade/<dépôt>#n`), puis **Avant / Après / Comment / Fini quand**. Jamais `Closes`, `Fixes` ni `Resolves` : la fusion ne ferme pas la tâche, seule la preuve la ferme. Une PR qui ne cite aucune tâche ouverte met le Garde-fou au rouge.
4. **La CI et le Garde-fou** doivent être verts. La PR sort alors du brouillon.
5. **Mergify fusionne en squash** une PR verte, hors brouillon, sans `hold`. Les chemins protégés (`.github/`, `scripts/hooks/`, `qualite/`, `vercel.json`, `drizzle/`, `.env*`) passent aussi quand le Garde-fou est vert. Les cas réservés à Marc sont au point 3.
6. **Mise en ligne vérifiée** : un déploiement de production `READY` existe sur le bon commit (celui qui a été fusionné). S'il n'y en a pas, on refait un push, jamais « Redeploy ». Si la PR ne change rien de servi (docs, tests, CI), il n'y a pas de déploiement à vérifier.
7. **Commentaire de preuve « Acceptée », puis fermeture** (`completed`), au plus 1 h après la mise en ligne. La preuve est la vérification du « Fini quand » faite sur le commit fusionné, avec son résultat. Une fusion, une CI verte seule ou un doute avoué (`[Probable]`, « pas lu », « non testé ») ne sont pas une preuve.

Si une tâche est fermée sans preuve valide, le Garde-fou de preuve la rouvre avec l'étiquette `preuve-manquante`.

## 2. Le commentaire de preuve (lu par une machine)

Le commentaire commence par `**Acceptée**` en gras, tel quel (« **Acceptée.** » ou « Acceptée » sans gras ne sont pas reconnus) :

```
**Acceptée** — PR #p fusionnée (<sha court>), déploiement READY (<id>), preuve : <ce qui a été vérifié et le résultat>.
```

- PR sans rien de servi : `sans déploiement : <raison>` à la place du déploiement.
- Tâche sans code : `sans PR` à la place de `PR #p`.
- La ligne `preuve : …` fait 40 caractères au moins (60 pour `sans PR`).
- La PR citée est fusionnée, l'empreinte est le début de celle du commit fusionné, et le commentaire est postérieur à la fusion.
- Il est écrit par une personne de confiance du dépôt (propriétaire, membre ou collaborateur) ou par Claude, jamais par Jules. Seule exception : l'acceptation automatique de `scripts/acceptation-auto.mjs`, qui porte `<!-- acceptation-auto -->`.
- Si la PR change du code servi : un déploiement de production réussi existe sur le commit fusionné ou sur un commit qui le contient.
- Pour vérifier le format avant de fermer : écrire le commentaire sur la tâche encore ouverte ; `preuve-commentaire.yml` répond « serait acceptée » ou « serait refusée » avec les motifs, sans rien fermer.

## 3. Ce qui reste à Marc

Le Garde-fou devient rouge, la PR attend, et une issue `qui:marc` s'ouvre avec le geste. Marc fusionne à la main si c'est voulu, sinon le fil corrige. Cas concernés :

- un test retiré ou sauté, ou une étape de test de la CI affaiblie ;
- un seuil de `qualite/` baissé, ou le mécanisme du cliquet modifié ;
- un secret (référence ajoutée ou modifiée) ;
- une migration destructive, ou une migration existante réécrite ;
- une modification du Garde-fou lui-même (workflow ou script), de `.mergify.yml` ou de `CODEOWNERS`.

Il n'existe aucune étiquette pour contourner le Garde-fou.

## 4. Preuve différée et abandon

- **Preuve différée** : quand la preuve dépend d'un événement (un cron, une échéance), on essaie d'abord de le déclencher soi-même. Sinon, le fil remplace `en-cours` par `preuve-attendue` et écrit `**Preuve attendue** : AAAA-MM-JJ HH:MM (heure du Québec) — événement`. La tâche reste ouverte et n'est pas finie tant que la preuve n'est pas posée.
- **Abandon** : une tâche fermée `not_planned` porte un commentaire `**Abandonnée** — <raison 20+ car.>`. Sans lui, elle est rouverte.

## 5. Place immobile

Une tâche `en-cours` sans aucune PR ouverte depuis 3 h reçoit un commentaire de signalement (marqueur `<!-- place-immobile -->`). Une heure après, si personne n'a répondu et qu'aucune PR n'est apparue, `en-cours` est retiré et `bloqué` posé, avec la raison. L'issue n'est jamais fermée : le fil du dépôt décide. Ne bougent jamais : une tâche `preuve-attendue`, `qui:marc` ou `jules`, une tâche citée par une PR ouverte (dans n'importe quel dépôt), une tâche qui attend un relevé ou un déploiement (commentaire de moins de 24 h), ni une tâche dont la lecture a échoué. Détail : [places-immobiles.md](places-immobiles.md).

## 6. Voie courte : EN MISE EN PLACE, pas en service

Une étiquette `go` lancera `claude-code-action` dans la CI du dépôt de l'app. **Ce n'est pas en service** : aucun script ni workflow de ce dépôt ne l'utilise encore, et rien d'autre dans cette page n'en dépend. Tant que ce n'est pas annoncé comme en service, la chaîne du point 1 est la seule voie.

## 7. Où est le reste

L'ancien texte complet (hiérarchie chantier › mission › tâche, ordre de la file, classes de preuve A/B/C, acceptation automatique, frein de quota, retour en arrière, Gantt, cartes de décision, heures) est dans [`docs/archive/cycle-de-vie-tache-2026-10-29.md`](archive/cycle-de-vie-tache-2026-10-29.md). Les renvois « § n » des scripts visent cette archive. Quand l'archive et le code se contredisent, c'est le code (`scripts/`) qui dit vrai.
