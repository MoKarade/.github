# Cycle de vie d'une tâche

> **Ce document fait foi** pour tout le travail fait dans les dépôts de MoKarade : comment il naît,
> qui le prend, comment il est codé, relu, mis en ligne, accepté, défait et audité.
> Décidé par Marc le 15/10/2026 (réponses « 1a 2a 3b 4a 5a 6a 7a 8b 9a 10a 11c 12a », puis « ok pour
> plan », en ajoutant le Gantt, les cartes et la répartition du travail).
> On le change par une PR sur ce dépôt, jamais ailleurs. Une copie qui le contredit a tort.

## 0. En cinq lignes

1. Trois niveaux : **chantier** (objectif de plusieurs semaines) › **mission** (résultat livrable en une semaine au plus) › **tâche** (une PR, une journée au plus, environ 400 lignes modifiées hors tests). Chacun est une issue GitHub.
2. Claude crée le travail. Le Coordinateur tient les chantiers et les missions, et les fils créent et ferment les tâches. Marc décide de la direction : il force une tâche avec `prio:1`.
3. L'ordre suit une règle fixe : d'abord la panne et le rouge, puis la sécurité, puis le standard et les fonctions en alternance. La routine distribue toutes les 2 h, avec au plus un fil et une tâche Jules par dépôt.
4. La CI décide. Chaque PR qui change un écran porte des captures avant/après, prises avec des données fictives. Mergify fusionne.
5. Une tâche est **acceptée** quand trois conditions sont remplies : elle est fusionnée, le déploiement est en ligne, et le « Fini quand » est prouvé en production par un commentaire de preuve. Si le test de fumée échoue, la version précédente revient seule et une PR d'annulation s'ouvre. Un rapport hebdomadaire mesure la vitesse, la qualité et les retours en arrière.

---

## 1. Hiérarchie

| Niveau | Ce que c'est | Taille | Exemple |
|---|---|---|---|
| **Chantier** | Un objectif que Marc reconnaît | Plusieurs semaines | « Standardiser les 9 dépôts » |
| **Mission** | Un résultat livrable et visible | Une semaine au plus | « Sauvegarder chaque nuit les bases Neon » |
| **Tâche** | Une PR | Une journée au plus, environ 400 lignes modifiées (hors tests et fichiers générés) | « Ajouter le test de fumée à BatchChef » |

- Chaque niveau est une issue GitHub portant son étiquette `niveau:chantier`, `niveau:mission` ou `niveau:tâche`.
- Les niveaux sont reliés par **sous-issues**. Une tâche a toujours un parent, mission ou chantier. Une tâche orpheline est un défaut, signalé par le Gantt.
- Un travail qui touche plusieurs dépôts a son chantier et ses missions dans `MoKarade/.github`, et ses tâches dans chaque dépôt concerné, rattachées à la mission commune.
- **Trop gros pour une tâche** (plus de 400 lignes, ou plus d'une journée) : la tâche devient une mission, découpée en tâches.
- Il n'y a pas d'autre niveau. L'étiquette `niveau:plan` est retirée.

## 2. Gabarits des issues

Titre : un verbe et un objet, en mots simples. Le corps suit toujours ces gabarits, dans cet ordre.

**Chantier**
```
**Objectif** : ce qui sera vrai pour Marc à la fin.
**Pourquoi** : le problème de départ.
**Fini quand** : critère vérifiable.
**Source** : demande de Marc (date, fil) ou audit.
```

**Mission**
```
**Résultat** : ce que Marc voit ou peut faire à la fin.
**Fini quand** : critère vérifiable.
**Source** : chantier, demande ou audit.
```

**Tâche**
```
**Avant** : ce que Marc voit aujourd'hui.
**Après** : ce qu'il verra quand c'est fait.
**Fini quand** : critère vérifiable EN PRODUCTION (réponse HTTP, écran, contrôle CI, donnée).
**Source** : ligne, PR, fil ou audit d'où vient la tâche.
**Attend** : #n — raison (seulement si la dépendance est prouvée).
```

Un « Fini quand » non vérifiable (« c'est mieux ») est refusé. On le réécrit avant de prendre la tâche.

## 3. Étiquettes

| Étiquette | Sens | Posée par |
|---|---|---|
| `niveau:chantier` / `niveau:mission` / `niveau:tâche` | Niveau | Celui qui crée l'issue |
| `prio:1` / `prio:2` / `prio:3` | 1 passe devant tout, sauf la panne. Pas d'étiquette = `prio:3` | Marc (`prio:1`), Claude (2 et 3) |
| `en-cours` | Prise par un fil. C'est l'heure de début | Le fil, en la prenant |
| `jules` | Confiée à Jules | La routine |
| `qui:marc` | Attend un geste de Marc, décrit en commentaire | Celui qui découvre le geste |
| `bloqué` | Attend autre chose qu'une tâche, dit en commentaire | Celui qui découvre le blocage |
| `incident` | Panne en production, ou retour en arrière automatique | Le workflow de fumée |
| `hold` (sur une PR) | Mergify ne fusionne pas | Marc ou Claude |

## 4. Qui fait quoi

| Rôle | Fait | Ne fait jamais |
|---|---|---|
| **Marc** | Fixe la direction ; répond aux cartes ; force une tâche (`prio:1`) ; fait les gestes `qui:marc` ; fusionne les PR des chemins protégés, hors exceptions de `.mergify.yml` | Fermer une issue à la main ; valider chaque tâche |
| **Coordinateur** (chat du projet) | Crée et modifie chantiers et missions ; lance les fils ; tient le texte de la routine ; relaie au fil propriétaire | Coder ; modifier les fichiers d'un fil |
| **Fil** (une session par tâche) | Prend une tâche, la livre, prouve l'acceptation ; crée les tâches de sa mission ; ouvre une issue pour un bug trouvé en chemin | Toucher la structure (chantiers, missions) ; prendre une deuxième tâche dans un autre dépôt |
| **Fil PC** | Tout ce qui ne tourne que sur le PC : robot de tests, Drive, NotebookLM, sauvegardes, bascule en public | Agir sur un oui relayé ; le oui de Marc est écrit dans ce fil |
| **Jules** | Les tâches `jules` : simples, un fichier, sans chemin protégé, sans base, sans secret, sans donnée perso | Les chemins protégés ; une tâche sans « Fini quand » |
| **Routine continue** (toutes les 2 h) | Fait le ménage, choisit la tâche suivante, la distribue (§6) | Inventer du travail |
| **CI** | Décide si une PR peut fusionner | |
| **Mergify** | Fusionne en squash une PR verte, hors brouillon, sans `hold`, une à la fois | Fusionner un chemin protégé |

**Qui crée quoi** :
- Claude crée le travail à partir des demandes de Marc, des audits et des bugs trouvés. Tout apparaît dans le Gantt, et Marc corrige la direction quand il le veut.
- Le Coordinateur est seul à créer ou modifier un chantier ou une mission. Un fil qui en a besoin le lui demande.
- Un fil crée les tâches de la mission qu'on lui a confiée, et ferme les siennes.
- Un bug trouvé en chemin devient une issue `niveau:tâche` dans son dépôt, rattachée à la mission la plus proche. Il n'est jamais corrigé dans la PR en cours.

## 5. Ordre (règle fixe)

Pour chaque dépôt, la tâche suivante est la première de cette liste :

1. **Panne ou rouge** : issue `incident`, branche par défaut rouge, PR rouge d'un fil.
2. **`prio:1`** posée par Marc.
3. **Sécurité** : avis npm ou Dependabot de gravité haute, fuite de secret, donnée perso en ligne.
4. **Alternance** : si la dernière tâche lancée ou fermée dans le dépôt venait d'un chantier de standard, on prend une fonction, et inversement. Si un côté n'a rien de prenable, on prend l'autre.
5. **Le reste**, par `prio` croissante, puis par numéro d'issue.

Une tâche n'est **prenable** que si elle remplit cinq conditions :
- elle est ouverte et porte `niveau:tâche` ;
- elle n'a ni `qui:marc`, ni `bloqué`, ni `en-cours`, ni `jules` ;
- toutes les tâches qu'elle attend sont fermées ;
- aucune PR ouverte ne la cite ;
- son « Fini quand » est vérifiable.

## 6. Répartition du travail

**Qui lance** : la routine continue, toutes les 2 h, jour et nuit. Une demande directe de Marc ne l'attend pas : le Coordinateur ouvre le fil tout de suite.

**Capacité** : au plus **un fil** en cours et **une tâche Jules** par dépôt. Un dépôt occupé est sauté.

**Aiguillage** :

| La tâche… | Va à |
|---|---|
| change un seul fichier de texte ou de code simple, sans chemin protégé, base, secret ni donnée perso | **Jules** (étiquette `jules`) |
| demande le PC (robot de tests, Drive, NotebookLM, fichiers locaux) | **Fil PC** |
| demande un compte, un secret, un paiement, une approbation de code owner ou une décision | **Marc** (`qui:marc` + le geste exact en commentaire). Sauf les exceptions que `.mergify.yml` fusionne seul (mises à jour mineures des actions par Dependabot, validées par Marc le 15/10) : rien à faire |
| tout le reste | **Un fil** neuf, brief : « une tâche, une PR, ce document ». **Une tâche = un fil neuf**, jamais une tâche de plus dans un fil existant : chaque appel relit tout le contexte du fil, donc un fil qui s'allonge coûte de plus en plus. Un fil fini est fermé, pas réutilisé |

**Ménage, avant chaque choix**, pour toute issue `en-cours` ou `jules` liée à une PR :

| État de la PR | Action |
|---|---|
| ouverte | rien |
| fusionnée, acceptation prouvée | fermer l'issue avec la preuve |
| fusionnée, preuve absente depuis plus de 24 h | commenter ce qui manque, et la tâche revient en file |
| fermée sans fusion | retirer `en-cours` ou `jules`, commenter, et la tâche revient en file |

Une issue `jules` sans PR depuis 24 h perd l'étiquette et redevient prenable.

**Fichiers partagés** : chaque fichier commun a un seul fil propriétaire. Les autres lui envoient leurs changements par le Coordinateur.

## 7. États d'une tâche

| État | Signal GitHub | Gantt |
|---|---|---|
| À faire | ouverte, aucune étiquette d'état | gris |
| En cours | `en-cours` ou `jules` | bleu, depuis l'heure de l'étiquette |
| En relecture | PR liée ouverte, hors brouillon | bleu rayé |
| Attend Marc | `qui:marc` | orange, filtre « Toi » |
| Bloquée | `bloqué` ou une tâche attendue ouverte | rouge clair |
| Fusionnée, non prouvée | PR fusionnée, issue ouverte | vert clair |
| **Acceptée** | issue fermée `completed` avec un commentaire de preuve | vert, fin à l'heure de fermeture |
| Abandonnée | issue fermée `not_planned` avec la raison | gris barré |

## 8. Coder et livrer

La procédure pas à pas est la compétence `livrer-une-tache`. Elle applique ce document ; en cas d'écart, c'est ce document qui gagne. Les points fixes :

- Branche `claude/<slug>` (Jules : sa branche), PR en **brouillon**, `--base` explicite.
- Gate complet du dépôt en local avant chaque push. Jamais `--force` sur la branche par défaut, jamais `--no-verify`, jamais un test désactivé.
- Corps de PR :
  - les lignes d'attribution ;
  - `Tâche : #n`, ou `Tâche : MoKarade/<dépôt>#n` ;
  - **Avant :** / **Après :** / **Comment :** ;
  - **Fini quand :** ;
  - les captures, si un écran change.
- **Pas de `Closes #n`** : la fusion ne ferme plus l'issue. C'est la preuve d'acceptation qui la ferme (§10).
  *Transition* : tant que le Gantt ne relie pas encore une PR par `Tâche : #n`, la PR garde `Closes #n`. Le commentaire de preuve est alors posté juste après la fusion, et l'issue est rouverte si la preuve échoue. La bascule est annoncée dans le fil « Standardisation des projets ».
- Taille : environ 400 lignes modifiées au plus, hors tests et fichiers générés. Au-delà, on découpe.
- Commit et titre préfixés selon le dépôt : `feat:`, `fix:`, `docs:`… ou `[ID]`.
- Doc touchée mise à jour dans la même PR.

### Captures d'écran (toute PR qui change un écran)

- Le workflow commun `captures` lance l'app sur les machines GitHub, **avec les données fictives des tests uniquement**, jamais la production. Il photographie chaque page touchée avant (sur la branche par défaut) et après (sur la PR).
- Les images sont rangées dans la branche `captures` du dépôt, sous `pr-<n>/`, et la PR reçoit un commentaire avec les deux images côte à côte. Ce commentaire est mis à jour à chaque push.
- L'historique reste dans la branche `captures`. Les fichiers temporaires d'Actions ne servent pas : ils disparaissent après 90 jours au plus.
- Une capture qui montre une donnée réelle est un incident de données perso : on retire l'image et on corrige la fixture.

## 9. Relecture

- **La CI décide.** Tous les contrôles requis sont verts, sinon pas de fusion. Une PR rouge est la priorité de son fil.
- **Sécurité et données perso** : un commentaire de relecture qui les touche est toujours traité avant la sortie du brouillon. Le fil corrige ce qui est vrai et dans le périmètre, et répond en une ligne au reste.
- **Marc** fusionne lui-même les chemins protégés : `.github/`, `scripts/hooks/`, `qualite/`, `vercel.json`, `drizzle/`, `.env*`, plus les extras de chaque `.mergify.yml`. Le fil le lui dit une fois, avec le lien, quand la PR est verte.

## 10. Mise en ligne et acceptation

1. La CI est verte : le fil sort la PR du brouillon, et Mergify fusionne.
2. Le fil vérifie qu'un déploiement de production existe et est `READY` **sur le commit fusionné**. S'il n'y en a pas, il fait un nouveau push, jamais « Redeploy ».
3. Le test de fumée commun tourne (§11).
4. Le fil prouve le « Fini quand » **en production** : réponse HTTP, page, contrôle ou donnée.
5. Le fil écrit le **commentaire de preuve** sur l'issue, puis la ferme `completed` :
   ```
   **Acceptée** — PR #p fusionnée (<sha court>), déploiement READY (<id>), preuve : <ce qui a été vérifié et le résultat>.
   ```
6. Cas d'une PR qui ne change rien de servi (doc, CI) : la preuve est le contrôle ou le fichier lui-même, et le commentaire le dit.

Le Gantt marque une tâche **acceptée** seulement si l'issue est fermée avec ce commentaire. Sans commentaire, la pastille la signale.

## 11. Retour en arrière (automatique)

Le workflow commun `fumee` tourne après chaque déploiement de production. Il contrôle `/api/sante`, le summary du hub et la page de connexion.

- **Fumée verte** : rien.
- **Fumée rouge**, dans cet ordre :
  1. le workflow remet en ligne le déploiement de production précédent (retour en arrière Vercel) ;
  2. il refait la fumée sur la version remise, et le dit ;
  3. il ouvre une PR d'annulation (revert) du commit fautif, hors brouillon, que Mergify fusionne quand elle est verte ;
  4. il ouvre une issue `incident` dans le dépôt, liée à la tâche d'origine, qui repasse « à faire ».
- La routine voit l'incident (priorité 1 du §5) et lance un fil, qui trouve la cause et refait la tâche proprement.
- Marc est prévenu par une ligne dans le chat du projet, envoyée par le Coordinateur au passage suivant de la routine.

## 12. Audit régulier

**Chaque lundi**, le workflow `rapport-hebdo` ouvre une issue dans `MoKarade/.github`, intitulée « Rapport de la semaine du AAAA-MM-JJ ». Tous les chiffres sont lus sur GitHub et Vercel, aucun n'est tapé à la main. Il mesure :
- **la vitesse** :
  - le délai entre la création d'une tâche et son acceptation (médiane et maximum) ;
  - les tâches acceptées, par dépôt et par exécutant (fil, Jules) ;
- **la qualité** :
  - les PR passées au rouge et le temps pour revenir au vert ;
  - les retours en arrière et les incidents ;
  - les tests instables ;
  - la couverture, par dépôt ;
  - la grille de conformité, en lignes vertes par dépôt ;
- **la santé du backlog** :
  - les tâches bloquées depuis plus de 7 jours ;
  - les gestes de Marc en attente, avec leur âge ;
  - les orphelines ;
  - les tâches fusionnées mais pas encore prouvées.

**Le premier lundi du mois**, la même issue porte aussi la revue de la grille de conformité. Ce que les incidents du mois ont appris devient des lignes neuves, proposées en tâches.

## 13. Gantt

Le Gantt montre l'état réel du travail. Il ne contient **rien de tapé à la main**. Il relit GitHub toutes les heures, et la page relit ses données toutes les 5 minutes.

**Ce qu'il montre** :
- Les trois niveaux, repliables : chantier › mission › tâche. Une tâche dont le parent vit dans un autre dépôt s'affiche sous ce parent, précédée du nom de son app.
- Pour chaque tâche, une barre colorée selon son état (§7), de l'heure de début à l'heure d'acceptation.
- **La fiche d'une tâche**, au clic, toujours dans ce format :
  - titre, dépôt et numéro ;
  - état et exécutant (fil, Jules, Marc) ;
  - Avant / Après / Fini quand ;
  - début, fin et durée ;
  - liens vers l'issue, la PR et le commentaire de preuve ;
  - dépendances.
- Le filtre « Toi », qui montre les seules issues `qui:marc`, avec le geste exact.
- L'heure du relevé et son âge, en rouge au-delà de 2 h.

**Ce qu'il vérifie** (la pastille, qui signale sans rien corriger) :
- **Format et structure** :
  - une issue sans niveau, ou avec `niveau:plan` ;
  - une tâche orpheline ;
  - un corps qui ne suit pas le gabarit de son niveau (§2) ;
  - une dépendance inconnue ou un cycle.
- **Liens et preuves** :
  - une PR de tâche sans `Tâche : #n` ;
  - une tâche fermée `completed` sans commentaire de preuve ;
  - une tâche fusionnée mais non prouvée depuis plus de 24 h.
- **Délais** :
  - une tâche `en-cours` sans PR depuis 24 h ;
  - une `jules` sans PR depuis 24 h ;
  - une tâche bloquée depuis plus de 7 jours ;
  - une PR de tâche de plus de 400 lignes (hors tests).
- **Autres** :
  - un incident ouvert ;
  - un dépôt qui a plus d'un fil en cours.

Le fil « Vue personnalisée du projet » possède les outils du Gantt. Cette section est leur cahier des charges.

## 14. Cartes de décision (questions à Marc)

Une question à Marc prend toujours la forme d'une **carte**, jamais d'une question perdue dans un long message.

- **Une décision par carte.** La question tient en une douzaine de mots, verbe d'abord, avec les mots de Marc.
- **2 à 4 options**, chacune en un ou deux mots, avec sa conséquence en une phrase.
- **Une recommandation**, avec sa raison et un label de confiance.
- **Le travail continue** sur l'option recommandée pendant l'attente, sauf si le pas est irréversible : suppression, bascule en public, migration destructive, secret, dépense. Dans ce cas, la carte le dit et on attend.
- **Plusieurs questions de cadrage** : un seul lot numéroté (« 1a 2b 3c… »), une recommandation par question, déposé en fichier quand il dépasse 15 lignes.
- **La réponse est consignée** dans l'issue concernée, en commentaire : « Décision de Marc (AAAA-MM-JJ HH:MM UTC) : … ». Pour le chantier, elle va dans le plan.
- **Un geste de Marc** n'est pas une carte : c'est une issue `qui:marc` avec les étapes exactes. Le fil le dit une fois, et le Gantt le montre dans « Toi ».

## 15. Qui applique ce document

| Mécanisme | Applique |
|---|---|
| Compétence `livrer-une-tache` | §8 à §10, pour chaque fil |
| Routine continue | §5, §6 |
| Gantt et sa pastille | §7, §13 |
| Workflows communs de ce dépôt (`captures`, `fumee`, `rapport-hebdo`) | §8, §11, §12 |
| Instructions du projet (résumé du §0) | tout, pour chaque session |

Ce qui n'est pas encore branché est suivi en tâches sous le chantier « Standardiser les tâches », dans ce dépôt.
