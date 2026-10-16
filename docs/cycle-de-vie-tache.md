# Cycle de vie d'une tâche

> **Ce document fait foi** pour tout le travail fait dans les dépôts de MoKarade : comment il naît,
> qui le prend, comment il est codé, relu, mis en ligne, accepté, défait et audité.
> Décidé par Marc le 15/10/2026 (réponses « 1a 2a 3b 4a 5a 6a 7a 8b 9a 10a 11c 12a », puis « ok pour
> plan », en ajoutant le Gantt, les cartes et la répartition du travail).
> On le change par une PR sur ce dépôt, jamais ailleurs. Une copie qui le contredit a tort.

## 0. En cinq lignes

1. Trois niveaux : **chantier** (objectif de plusieurs semaines) › **mission** (résultat livrable en une semaine au plus) › **tâche** (une PR, une journée au plus, environ 400 lignes modifiées hors tests). Chacun est une issue GitHub.
2. Claude crée le travail. Le Coordinateur tient les chantiers et les missions, et les fils créent et ferment les tâches. Marc décide de la direction : il force une tâche avec `prio:1`.
3. L'ordre suit une règle fixe, calculée par un script (§5) : d'abord la panne, le rouge et la preuve due, puis `prio:1`, puis la sécurité, puis le chantier en cours jusqu'au bout, puis le standard et les fonctions en alternance. Les événements GitHub réveillent le Coordinateur (§6), un filet quotidien vérifie le reste, avec au plus un fil et une tâche Jules par dépôt.
4. La CI décide. Chaque PR qui change un écran porte des captures avant/après, prises avec des données fictives. Mergify fusionne.
5. Une tâche est **acceptée** quand trois conditions sont remplies : elle est fusionnée, le déploiement est en ligne, et le « Fini quand » est prouvé en production par un commentaire de preuve, **posé dans l'heure qui suit la mise en ligne** (§10). Si le test de fumée échoue, la version précédente revient seule et une PR d'annulation s'ouvre. Un rapport hebdomadaire mesure la vitesse, la qualité et les retours en arrière. **Sans cette preuve, une tâche n'est jamais finie** : un garde-fou rouvre toute tâche fermée sans preuve valide (§10 bis), et une preuve qui dépend d'un événement ou d'un geste de Marc laisse la tâche ouverte, étiquetée `preuve-attendue`, jamais comptée comme finie (§10).

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
**Fini quand** : critère vérifiable EN PRODUCTION (réponse HTTP, écran, contrôle CI, donnée), **prouvable dans l'heure** qui suit la mise en ligne.
**Source** : ligne, PR, fil ou audit d'où vient la tâche.
**Attend** : #n — raison (seulement si la dépendance est prouvée).
**Preuve attendue** : AAAA-MM-JJ HH:MM (heure du Québec) — événement (seulement si la preuve dépend d'un événement, voir §10).
```

Un « Fini quand » non vérifiable (« c'est mieux ») est refusé. Un « Fini quand » qui dépend d'un événement lent (un cron, une échéance) est refusé tel quel : on le réécrit pour qu'il soit prouvable dans l'heure, ou on applique la règle du §10. On le réécrit avant de prendre la tâche.

## 3. Étiquettes

| Étiquette | Sens | Posée par |
|---|---|---|
| `niveau:chantier` / `niveau:mission` / `niveau:tâche` | Niveau | Celui qui crée l'issue |
| `prio:1` / `prio:2` / `prio:3` | 1 passe devant tout, sauf la panne. Pas d'étiquette = `prio:3` | Marc (`prio:1`), Claude (2 et 3) |
| `en-cours` | Prise par un fil. C'est l'heure de début | Le fil, en la prenant ; sinon le balayage « tâche liée », dans les 10 minutes de l'ouverture de la PR qui cite la tâche (§8) |
| `jules` | Confiée à Jules | La routine |
| `qui:marc` | Attend un geste de Marc, décrit en commentaire | Celui qui découvre le geste |
| `bloqué` | Attend autre chose qu'une tâche, dit en commentaire | Celui qui découvre le blocage |
| `preuve-attendue` | PR fusionnée, mais la preuve n'est pas possible tout de suite (événement futur, geste de Marc). La tâche reste **ouverte et non finie** ; elle ne bloque pas le dépôt (§10) | Le fil, en remplaçant `en-cours` |
| `preuve-manquante` | Tâche fermée sans preuve valide, rouverte par le garde-fou (§10 bis) | Le garde-fou de preuve |
| `incident` | Panne en production, ou retour en arrière automatique | Le workflow de fumée |
| `chantier:standard` / `chantier:fonction` (sur un chantier) | Type du chantier, pour l'alternance (§5) | Le Coordinateur, à la création du chantier |
| `essai` | Issue créée par un essai ; fermée `not_planned` par l'essai lui-même ; ignorée par le Gantt et par le garde-fou de preuve (§13) | Le test qui la crée |
| `hold` (sur une PR) | Mergify ne fusionne pas | Marc ou Claude |

## 4. Qui fait quoi

| Rôle | Fait | Ne fait jamais |
|---|---|---|
| **Marc** | Fixe la direction ; répond aux cartes ; force une tâche (`prio:1`) ; fait les gestes `qui:marc` (dont fusionner à la main une PR que le garde-fou a bloquée) | Fermer une issue à la main ; valider chaque tâche |
| **Coordinateur** (chat du projet) | Crée et modifie chantiers et missions ; lance les fils ; tient le texte de la routine ; relaie au fil propriétaire | Coder ; modifier les fichiers d'un fil |
| **Fil** (une session par tâche) | Prend une tâche, la livre, prouve l'acceptation ; crée les tâches de sa mission ; ouvre une issue pour un bug trouvé en chemin | Toucher la structure (chantiers, missions) ; prendre une deuxième tâche dans un autre dépôt |
| **Fil PC** | Tout ce qui ne tourne que sur le PC : robot de tests, Drive, NotebookLM, sauvegardes, bascule en public | Agir sur un oui relayé ; le oui de Marc est écrit dans ce fil |
| **Jules** | Les tâches `jules` : simples, un fichier, sans chemin protégé, sans base, sans secret, sans donnée perso | Les chemins protégés (le garde-fou les permettrait, mais une tâche simple n'en a pas besoin) ; une tâche sans « Fini quand » |
| **Routine continue** (une fois par jour à 6 h, et au réveil par la boîte) | Fait le ménage, choisit la tâche suivante, la distribue (§6) | Inventer du travail |
| **Réacteur** (workflow commun `reveil-reacteur.yml`, sans IA) | Relance une fois un échec de charge du robot de tests, signale « D libre » ou « preuve à poser » en réveillant le Coordinateur, et fait chaque jour le filet de 6 h (§6). Les PR en retard sont tenues à jour par la file de Mergify | Résoudre un conflit, fusionner, poser « Acceptée », nommer une tâche suivante |
| **CI** | Décide si une PR peut fusionner | |
| **Mergify** | Fusionne en squash une PR verte, hors brouillon, sans `hold`, une à la fois ; les chemins protégés aussi, quand le contrôle « Garde-fou » est vert (§9) | Fusionner une PR dont le garde-fou est rouge |

**Qui crée quoi** :
- Claude crée le travail à partir des demandes de Marc, des audits et des bugs trouvés. Tout apparaît dans le Gantt, et Marc corrige la direction quand il le veut.
- Le Coordinateur est seul à créer ou modifier un chantier ou une mission. Un fil qui en a besoin le lui demande.
- Un fil crée les tâches de la mission qu'on lui a confiée, et ferme les siennes.
- Un bug trouvé en chemin devient une issue `niveau:tâche` dans son dépôt, rattachée à la mission la plus proche. Il n'est jamais corrigé dans la PR en cours.

## 5. Ordre (règle fixe)

**La file est calculée par UN script** : `scripts/prochaine-tache.mjs` (ce dépôt) lit le relevé du Gantt et écrit `prochaines.json` : pour chaque dépôt, son état (`libre`, `occupe`, `incident`, `rien`), la tâche suivante, la file complète et la raison de chaque tâche écartée. Le Gantt l'affiche, la routine continue le lit. Ce texte décrit ce que le script calcule ; en cas de divergence, on corrige le script (et ses tests), jamais une routine ni une page.

Pour chaque dépôt, la tâche suivante est la première de cette liste :

1. **Panne, rouge ou preuve due** : issue `incident` (le dépôt passe alors à l'état `incident`), branche par défaut rouge, PR rouge d'un fil, tâche `preuve-manquante` (fermée sans preuve, rouverte), ou PR fusionnée dont la tâche n'est pas acceptée : la preuve est due avant tout travail neuf.
2. **`prio:1`** posée par Marc.
3. **Sécurité** : avis npm ou Dependabot de gravité haute, fuite de secret, donnée perso en ligne (le script ne lit que l'étiquette `sécurité` ; les avis sont à vérifier par l'appelant).
4. **Le chantier en cours jusqu'au bout** (décision de Marc, 16/10/2026) : la prochaine tâche prenable de la même mission que la dernière tâche lancée ou fermée dans le dépôt, sinon du même chantier.
5. **Alternance** (décision 16b) : seulement quand ce chantier n'a plus rien de prenable : si la dernière tâche venait d'un chantier `chantier:standard`, on prend un chantier `chantier:fonction`, et inversement ; si un côté n'a rien de prenable, l'autre.
6. **Le reste**, par `prio` croissante, puis par numéro d'issue.

Chaque chantier porte `chantier:standard` (socle, CI, conformité, sécurité, dépendances, tests, contrat, gabarit, outillage) ou `chantier:fonction` (ce que Marc voit ou utilise). Sans cette étiquette, l'alternance n'est pas calculable et le script le signale dans `alertes` en nommant le chantier. Le script remonte de la tâche jusqu'au premier ancêtre de niveau chantier (quatre sauts au plus) ; une tâche dont les missions n'ont aucun chantier au-dessus (mission commune à plusieurs dépôts) n'alterne pas et ne déclenche pas l'alerte : il n'y a rien à étiqueter.

**Avant de lancer**, l'agent revérifie en direct la tâche choisie (ouverte, sans `en-cours`, sans PR ouverte) : `prochaines.json` peut dater de 40 minutes.

Une tâche n'est **prenable** que si elle remplit cinq conditions :
- elle est ouverte et porte `niveau:tâche` ;
- elle n'a ni `qui:marc`, ni `bloqué`, ni `en-cours`, ni `jules`, ni `preuve-attendue` (livrée, il ne reste que la preuve) ;
- toutes les tâches qu'elle attend sont fermées ;
- aucune PR ouverte ne la cite ;
- son « Fini quand » est vérifiable, et prouvable dans l'heure ou couvert par une preuve programmée (§10).

## 6. Répartition du travail

**Qui lance** : un **événement** d'abord, un relevé à l'heure seulement en filet quotidien (décision de Marc, 15/10/2026 : « plus de vérifications toutes les X heures »). Une demande directe de Marc n'attend rien : le Coordinateur ouvre le fil tout de suite.

1. **Événement.** Une PR fusionnée, ou une CI rouge, dans l'un des dix dépôts déclenche le workflow `reacteur.yml` du dépôt, qui appelle le workflow commun `reveil-reacteur.yml` de ce dépôt (script `scripts/reveil-reacteur.mjs`, testé, **sans IA** : aucun quota Claude, aucun appel à une routine). Il filtre l'événement, relance une seule fois les jobs d'une CI morte par échec de charge du robot (sans étape en échec), puis lance le workflow `boite-reacteur.yml` de `app-template` avec le jeton `REVEIL_TOKEN` (jeton fin de Marc limité à `app-template`, Actions en lecture et écriture, secret des dix dépôts). Le message dit « D libre » ou « preuve à poser sur D#n », jamais une tâche suivante (l'ordre vient de `prochaines.json`). « D libre » n'est écrit que si D n'a aucune issue ouverte `en-cours` ou `jules` ni PR ouverte hors robots (la tâche de la PR qui vient de fusionner ne compte pas) ; sinon, une fusion ou une fermeture ne réveille personne, sauf s'il y a une preuve à poser ou une tâche abandonnée (tâche #164). Une fois le Coordinateur réveillé, et seulement sur une PR fusionnée, une CI rouge ou une tâche fermée (jamais sur le filet), le même script lance `commentaire-tache-liee.yml` et `relecture-ia.yml` de `.github` (`workflow_dispatch`, chacun balaie toutes les PR ouvertes) avec le même jeton, parce que GitHub n'exécute presque pas leurs planifications (tâche #148) ; si `REVEIL_TOKEN` n'a pas le droit sur `.github`, un avertissement le dit et le réveil n'est pas touché. À l'ouverture d'une PR (ouverte, rouverte, sortie du brouillon, corps modifié), le `reacteur.yml` appelle le même workflow en mode `pr_ouverte` : il ne réveille PERSONNE et ne commente rien sur la boîte, il lance seulement `commentaire-tache-liee.yml` (tâche #157). Ce workflow commente la **boîte** (la PR brouillon permanente `app-template#58`, à ne jamais fusionner ni fermer) en `github-actions[bot]`, et le Coordinateur, abonné à la boîte, est réveillé.
2. **Pourquoi le bot.** Un commentaire fait avec le compte de Marc ne réveille personne : GitHub ne notifie pas un abonné pour ses propres commentaires (prouvé le 15/10/2026).
3. **Filet.** Une fois par jour à 6 h (heure du Québec), deux choses vérifient ce qu'aucun événement n'a signalé.
   - **Le Réacteur** (tâche #143, sans IA, sans quota) : le `reacteur.yml` de chaque dépôt a deux déclencheurs `schedule` (10 h et 11 h UTC) ; seul celui qui tombe à 6 h au Québec agit, en heure d'été comme en heure d'hiver. Il appelle `reveil-reacteur.yml` en mode `filet`, qui relit le dépôt avec le jeton du job (le quota du compte de Marc n'est pas touché) et réveille le Coordinateur, une fois par dépôt et avec des numéros seulement, s'il trouve : une PR ouverte, hors brouillon, hors Dependabot et Mergify, avec un contrôle rouge depuis plus de 30 minutes (le Garde-fou est exclu : rouge, il attend Marc) ; une issue `incident` ouverte ; la branche par défaut rouge. Le jeudi, `MoKarade/.github` ajoute « remesure hebdo de la consommation Claude à lancer ». Rien à signaler : aucun réveil. « Run workflow » lance le filet à toute heure (`forcer`).
   - **La routine continue** du Coordinateur fait son ménage et distribue les tâches.
4. **Règle.** Toute nouvelle surveillance passe d'abord par un événement. Une horloge n'est permise que comme filet quotidien.

**Capacité** : au plus **un fil** en cours et **une tâche Jules** par dépôt. Un dépôt occupé est sauté. Une tâche `preuve-attendue` n'occupe pas le dépôt (le fil a livré, la preuve est programmée), mais elle n'est **pas finie** : elle reste ouverte et ne compte comme acceptée nulle part. Un dépôt n'est libéré par une fermeture que si le garde-fou de preuve (§10 bis) l'a validée.

**Aiguillage** :

| La tâche… | Va à |
|---|---|
| change un seul fichier de texte ou de code simple, sans chemin protégé, base, secret ni donnée perso | **Jules** (étiquette `jules`) |
| demande le PC (robot de tests, Drive, NotebookLM, fichiers locaux) | **Fil PC** |
| demande un compte, un secret, un paiement, une approbation de code owner ou une décision | **Marc** (`qui:marc` + le geste exact en commentaire). Sauf ce que Mergify fusionne seul : les chemins protégés dont le garde-fou est vert (oui de Marc, 15/10), et les mises à jour mineures des actions par Dependabot : rien à faire |
| tout le reste | **Un fil** neuf, brief : « une tâche, une PR, ce document ». **Une tâche = un fil neuf**, jamais une tâche de plus dans un fil existant : chaque appel relit tout le contexte du fil, donc un fil qui s'allonge coûte de plus en plus. Un fil fini est fermé, pas réutilisé |

**Ménage, avant chaque choix**, pour toute issue `en-cours` ou `jules` liée à une PR :

| État de la PR | Action |
|---|---|
| ouverte | rien |
| fusionnée, acceptation prouvée | fermer l'issue avec la preuve (le garde-fou vérifie la fermeture, §10 bis) |
| fusionnée, preuve absente depuis plus de 2 h (hors preuve programmée dont l'heure n'est pas passée, §10) | commenter ce qui manque, et la tâche revient en file |
| fermée sans fusion | retirer `en-cours` ou `jules`, commenter, et la tâche revient en file |
| tâche fermée `completed` sans preuve valide (garde-fou en retard, PC éteint) | la rouvrir, poser `preuve-manquante` et dire ce qui manque (§10 bis) : elle n'est jamais laissée fermée |

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
| Fusionnée, non prouvée | PR fusionnée, issue ouverte, moins de 2 h | vert clair |
| Preuve programmée | PR fusionnée, issue ouverte, `preuve-attendue`, ligne `**Preuve attendue**` dont l'heure n'est pas passée. **Pas finie** | orange rayé (jamais vert) |
| Preuve manquante | tâche fermée sans preuve valide, rouverte par le garde-fou (`preuve-manquante`) | rouge |
| Preuve en retard | PR fusionnée, issue ouverte depuis plus de 2 h (ou plus d'une heure après l'heure de la preuve programmée) | rouge clair |
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
- **Pas de PR sans tâche** : le contrôle « Garde-fou » (déjà exigé dans les dix dépôts, `scripts/tache-liee.mjs`) est rouge si le corps de la PR ne cite aucune issue `niveau:tâche` OUVERTE. Dispensés : Dependabot, Mergify, GitHub Actions et la boîte du Réacteur ; Jules ne l'est pas. Un travail d'outillage a sa tâche dans `MoKarade/.github`. Corriger le corps, puis relancer le contrôle (Re-run jobs) ou pousser un commit. La raison est dans le journal du contrôle ; le workflow `commentaire-tache-liee.yml` (`scripts/commenter-tache-liee.mjs`, lancé par le Réacteur à chaque PR fusionnée, CI rouge ou tâche fermée (§6), et par une planification de secours aux minutes 3, 13, 23… que GitHub exécute très peu ; jeton `RELECTURE_PAT`) la pose aussi en commentaire sur la PR, la met à jour et la lève une fois la PR corrigée, sans jamais changer le verdict. Si la tâche citée n'a pas de parent (mission ou chantier), le même commentaire le dit en avertissement, sans changer le verdict : une tâche sans parent est un défaut du backlog (pastille du Gantt) et le dire à celui qui la travaille l'empêche de durer (tâche #151). **Prise tracée par la machine** (tâche #157) : le même passage marque `en-cours` toute tâche ouverte citée par une PR ouverte (brouillon compris) quand elle ne porte ni `en-cours`, ni `jules`, ni `preuve-attendue`, et le dit en un commentaire sur la tâche. Il ne retire jamais une étiquette. Le fil qui la pose lui-même avant la PR reste la voie normale ; le balayage rattrape l'oubli. Le jeton `RELECTURE_PAT` appartient à Marc et son plafond d'appels est partagé avec les autres boucles : si le plafond est atteint, le passage s'arrête avec un avertissement (pas de rouge) et reprend au suivant.
- **Jamais `Closes`, `Fixes` ni `Resolves`** (Jules et Mergify compris) : la fusion ne ferme pas l'issue, la preuve d'acceptation la ferme (§10). Si une PR en porte quand même un, GitHub ferme l'issue à la fusion et le garde-fou de preuve (§10 bis) la rouvre aussitôt avec `preuve-manquante`. La transition est finie : le Gantt relie les PR par `Tâche : #n`.
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
- **Chemins protégés** (`.github/`, `scripts/hooks/`, `qualite/`, `vercel.json`, `drizzle/`, `.env*`, plus les extras de chaque `.mergify.yml`) : Mergify les fusionne quand le contrôle **« Garde-fou »** est vert, comme le reste (oui écrit de Marc, 15/10/2026). Le garde-fou (`scripts/garde-fou.mjs`, tests dans `scripts/garde-fou.test.mjs`) est rouge si la PR : retire ou saute un test, ou affaiblit une étape de test de la CI ; baisse un seuil de `qualite/` ou touche au mécanisme du cliquet ; ajoute ou modifie une référence à un secret (CI, `.env*`, variable de code, scan de secrets) ; contient une migration destructive ou réécrit une migration existante ; modifie `.mergify.yml`, `CODEOWNERS`, le workflow ou le script du garde-fou lui-même.
- **Garde-fou rouge** : la PR attend et une issue `qui:marc` s'ouvre avec le geste (« Geste : ... ») ; un commentaire sur la PR dit pourquoi quand le droit d'écriture le permet, sinon le rapport est dans le contrôle et dans l'issue. Marc fusionne à la main si c'est voulu, sinon le fil corrige. Il n'existe aucune étiquette pour le contourner : une session pourrait la poser. Le garde-fou ne change que par PR sur ce dépôt, que Marc fusionne.
- **Où il tourne** : `.github/workflows/garde-fou.yml` de chaque dépôt (`pull_request_target`, donc le workflow de la branche par défaut, que la PR ne peut pas changer). Il lit la liste des fichiers par l'API et ne récupère jamais le code de la PR.

## 10. Mise en ligne et acceptation

**Règle : valider vite.** Une tâche finie se valide tout de suite, pas quand on y repense (décision de Marc, 15/10/2026). Le commentaire « **Acceptée** » est posé **au plus 1 h après** le déploiement `READY` (ou après la fusion, quand rien de servi ne change). Au-delà de **2 h** sans preuve, la tâche est en retard : le ménage du §6 la remet en file et le Gantt la signale en rouge.

1. La CI est verte : le fil sort la PR du brouillon, et Mergify fusionne.
2. Le fil vérifie qu'un déploiement de production existe et est `READY` **sur le commit fusionné**. S'il n'y en a pas, il fait un nouveau push, jamais « Redeploy ».
3. Le test de fumée commun tourne (§11).
4. Le fil prouve le « Fini quand » **en production** : réponse HTTP, page, contrôle ou donnée.
5. Le fil écrit le **commentaire de preuve** sur l'issue, puis la ferme `completed`. Le format est contrôlé par une machine (§10 bis) : le commentaire commence par `**Acceptée**` en gras, tel quel (« **Acceptée.** » ou « Acceptée » sans gras ne sont pas reconnus) :
   ```
   **Acceptée** — PR #p fusionnée (<sha court>), déploiement READY (<id>), preuve : <ce qui a été vérifié et le résultat>.
   ```
6. Cas d'une PR qui ne change rien de servi (docs, tests, CI) : pas de déploiement à vérifier, et le commentaire écrit `sans déploiement : <raison>`. La preuve n'est pas « le fichier existe » : c'est la commande ou le contrôle du « Fini quand » exécuté sur le commit fusionné, avec son résultat (sortie copiée, lien de l'exécution CI).
7. Tâche sans code (réglage, geste de Marc, révocation) : `sans PR` à la place de `PR #p`, avec une preuve d'au moins 60 caractères qui dit ce qui a été LU (code de réponse, valeur, capture). Quand Marc fait le geste, son « fait » n'est pas la preuve : Claude vérifie l'effet, puis prouve.

**Le fil reste jusqu'à l'acceptation.** Il ne se ferme pas entre la fusion et la preuve : il n'est marqué résolu que quand l'issue est fermée avec un commentaire accepté par le garde-fou, ou en `preuve-attendue` avec sa routine programmée. S'il approche de la limite de contexte (§16), il passe la main avec l'état dans un fichier, et la preuve reste due dans le même délai.

**Quand la preuve dépend d'un événement** (un cron, une échéance, un premier passage de données), on ne laisse pas la tâche en attente sans date :

1. **D'abord, déclencher l'événement soi-même** : lancement manuel du workflow ou du cron (`workflow_dispatch`, route protégée d'un cron, appel de la fonction). Si c'est possible, la preuve se fait dans l'heure, comme toute tâche.
2. **Sinon, programmer le contrôle au plus tôt.** Le fil écrit la ligne `**Preuve attendue** : AAAA-MM-JJ HH:MM (heure du Québec) — événement` dans l'issue, avec l'heure de l'événement prévue plus 15 minutes. Il crée une routine à usage unique à cette heure, qui part en session neuve et fait la preuve. Il commente la PR et l'issue pour dire la date. **La tâche reste ouverte** : le fil remplace `en-cours` par `preuve-attendue` (le dépôt est libre, le fil suivant peut partir), mais elle n'est comptée comme finie nulle part (Gantt orange, rapport hebdomadaire, règle « une chose à la fois »). Une preuve qui attend un geste de Marc suit le même chemin, avec `qui:marc` en plus et la ligne « Geste : ».
3. **À l'heure dite**, la preuve est posée dans l'heure qui suit l'événement, avec le même commentaire « **Acceptée** ». Si l'événement n'a pas eu lieu ou la preuve échoue, l'issue est rouverte comme un échec de fumée : incident, pas silence.
4. Un « Fini quand » qui exige plus d'une journée d'attente n'est pas une tâche. On sépare : la tâche s'accepte sur ce qui se prouve tout de suite, et le suivi long devient une tâche à part avec son propre « Fini quand ».

**Ce qui n'est PAS une preuve** (le garde-fou rouvre la tâche) :
- un déploiement réussi dont le résultat attendu n'a pas été lu (FinanceAI#1156, 16/10 : « je n'ai pas lu le `GET /hub/summary` déployé », [Probable], issue fermée). Quand le fil ne peut pas lire (jeton absent), la tâche reste en `preuve-attendue` avec `qui:marc` si un geste est nécessaire ;
- un commentaire qui avoue un doute : `[Probable]`, `[Supposition]`, `[À vérifier]`, « pas lu », « non testé », « je n'ai pas pu vérifier » ;
- une CI verte ou un test seuls, quand le « Fini quand » est en production ;
- une preuve écrite par un robot ou par Jules, ou datée d'avant la fusion de la PR ;
- une fusion : Mergify, `Fixes #n` ou un fil pressé ne ferment jamais la tâche.

Le Gantt marque une tâche **acceptée** seulement si l'issue est fermée avec ce commentaire. Sans commentaire, la pastille la signale.

## 10 bis. Garde-fou de preuve : une tâche ne se ferme pas sans preuve

Décision de Marc, 16/10/2026 : « je veux toujours qu'une tâche soit prouvée ». Jusque-là la règle n'était qu'écrite : rien n'empêchait de fermer l'issue sans preuve, et la fermeture libère le dépôt (§6). Constat au relevé du Gantt du 16/10 à 10 h 45 (heure du Québec) : sur 124 tâches fermées `completed`, 17 n'avaient aucun commentaire de preuve reconnu, dont des fermetures à la fusion (`Fixes #n`), des commentaires « Acceptée. » dans un format que personne ne lit, et des tâches sans PR fermées sur parole.

**Mécanisme.** Le workflow commun `.github/workflows/preuve.yml` (script `scripts/preuve.mjs`, testé) est appelé par le `reacteur.yml` de chacun des dix dépôts quand une issue `niveau:tâche` est fermée, par n'importe qui ou n'importe quoi (fil, Jules, Mergify, ménage, Marc). Il lit l'issue, ses commentaires, la PR citée et les déploiements, par l'API GitHub, et décide.

**Une fermeture `completed` est valide seulement si TOUT est vrai :**
1. un commentaire commence par `**Acceptée**`, écrit par une personne ou par Claude (pas un robot, pas Jules) ; le dernier de ces commentaires fait foi ;
2. il n'avoue aucun doute (§10, « Ce qui n'est PAS une preuve ») ;
3. sa ligne `preuve : …` fait 40 caractères au moins (60 pour une tâche `sans PR`) ;
4. il cite `PR #p` (ou `PR MoKarade/<dépôt>#p`), cette PR est fusionnée, l'empreinte citée est celle du commit fusionné, et le commentaire est postérieur à la fusion ; ou il dit `sans PR` ;
5. si la PR change autre chose que docs, tests, CI et qualité (et que le dépôt se déploie) : un déploiement de production réussi existe, après la fusion, sur le commit fusionné ou sur un commit qui le contient. Vercel : l'état de déploiement GitHub. Hors Vercel (moteur DriveAI, serveur MCP de FinanceAI) : une exécution réussie du workflow de déploiement dont un JOB de déploiement a réussi (un job ignoré ne compte pas : le serveur MCP est resté 27 jours sans déploiement sous une coche verte).

Une fermeture `not_planned` ou doublon est valide avec un commentaire `**Abandonnée** — <raison>` (20 caractères au moins), pour que l'abandon ne soit jamais silencieux.

**Sinon** : l'issue est rouverte tout de suite, l'étiquette `preuve-manquante` est posée et un commentaire dit chaque défaut et le format attendu. La tâche passe en tête de l'ordre (§5, point 1). Quand la fermeture est valide, `preuve-manquante` et `preuve-attendue` sont retirées.

**Le Réacteur ne part que sur une fermeture validée** (`acceptee` ou `abandon`) : un dépôt n'est jamais libéré par une tâche fermée sans preuve. Si le garde-fou lui-même échoue (API indisponible), le Réacteur ne part pas non plus et le filet de 6 h reprend la main.

**Réglage par dépôt**, dans le `reacteur.yml` de chacun : `deploiement: vercel`, sauf `.github`, `app-template` et `hub-contract` (`aucun`, ils ne se déploient pas) ; `workflows-deploiement: deploy.yml` chez DriveAI et `deploy-mcp.yml` chez FinanceAI. Dépôt privé : le job tourne sur le robot du PC, comme tout le reste ; PC éteint, la vérification attend son retour.

**Ce que le garde-fou ne fait pas.** Il ne lit pas la production (c'est le fil, §10) et ne juge pas le texte : il vérifie la forme et ce que GitHub sait (PR, empreinte, déploiement). Un faux commentaire bien formé passe. Deux filets restent : la pastille du Gantt (§13) et le ménage de la routine (§6), qui rouvrent ce que le garde-fou a manqué. Limite connue : chez DriveAI, `deploy.yml` réussit sans rien déployer quand ses secrets manquent.

**Sécurité.** Le script vient de `main` de ce dépôt, jamais du code de l'appelant ; le jeton du job (`github.token`) suffit, aucun secret ; le texte des commentaires est traité comme donnée, jamais exécuté.

## 11. Retour en arrière (automatique)

Le workflow commun `fumee` tourne après chaque déploiement de production. Il contrôle `/api/sante`, le summary du hub et la page de connexion.

- **Fumée verte** : rien.
- **Fumée rouge**, dans cet ordre :
  1. le workflow remet en ligne le déploiement de production précédent (retour en arrière Vercel) ;
  2. il refait la fumée sur la version remise, et le dit ;
  3. il ouvre une issue `incident` dans ce dépôt, avec le commit fautif et sa tâche d'origine, qui repasse « à faire » ;
  4. le fil lancé par la routine sur cet incident ouvre la PR d'annulation (revert) du commit fautif, hors brouillon, que Mergify fusionne quand elle est verte (décision de Marc du 16/10/2026, #85 : pas de jeton d'écriture de plus).
- La routine voit l'incident (priorité 1 du §5) et lance un fil, qui trouve la cause et refait la tâche proprement.
- Marc est prévenu par une ligne dans le chat du projet, envoyée par le Coordinateur au passage suivant de la routine.

**Comment c'est branché (état au 16/10/2026, tâche #30).** Le jeton Vercel est rangé UNE fois, dans le secret `VERCEL_TOKEN` de MoKarade/.github (pas dans les dix dépôts). Le retour en arrière tourne donc dans la surveillance de ce dépôt (`scripts/retour-arriere.mjs`, toutes les 15 minutes), pas dans l'appel du workflow de fumée : quand la sonde de santé d'une app est rouge et que son déploiement de production en ligne a moins de 2 h, la version précédente est remise en ligne, la sonde est refaite, et une issue `incident` est ouverte dans ce dépôt (commit fautif, tâche d'origine, résultat de la sonde). Un seul retour par déploiement fautif. Sans le secret, tout est inactif et le résumé du job le dit. La PR d'annulation (point 4) n'est pas ouverte par ce pas : le jeton d'un job de ce dépôt n'écrit pas chez les apps et une PR ouverte ainsi ne déclenche aucun contrôle ; c'est le fil lancé sur l'issue `incident` qui l'ouvre.

## 12. Audit régulier

**Chaque lundi**, le workflow `rapport-hebdo` ouvre une issue dans `MoKarade/.github`, intitulée « Rapport de la semaine du AAAA-MM-JJ ». Tous les chiffres sont lus sur GitHub et Vercel, aucun n'est tapé à la main. Il mesure :
- **la vitesse** :
  - le délai entre la création d'une tâche et son acceptation (médiane et maximum) ;
  - les tâches acceptées, par dépôt et par exécutant (fil, Jules) ;
  - le délai entre la mise en ligne (ou la fusion) et « Acceptée » (médiane et maximum), avec la part des tâches prouvées dans l'heure ;
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
  - les tâches fusionnées mais pas encore prouvées, et les preuves programmées avec leur date.

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
- L'heure du relevé (heure du Québec, §17) et son âge, en rouge au-delà de 2 h.

**Ce qu'il vérifie** (la pastille, qui signale sans rien corriger) :
- **Format et structure** :
  - une issue sans niveau, ou avec `niveau:plan` ;
  - une tâche orpheline ;
  - un corps qui ne suit pas le gabarit de son niveau (§2) ;
  - une dépendance inconnue ou un cycle.
- **Liens et preuves** :
  - une PR de tâche sans `Tâche : #n` ;
  - une tâche fermée `completed` sans commentaire de preuve, ou rouverte par le garde-fou (`preuve-manquante`) ;
  - une tâche `preuve-attendue` dont l'heure est passée ;
  - une tâche fusionnée mais non prouvée depuis plus de 2 h (hors preuve programmée dont l'heure n'est pas passée) ;
  - une preuve programmée dont l'heure est passée depuis plus d'une heure.
- **Délais** :
  - une tâche `en-cours` sans PR depuis 24 h ;
  - une `jules` sans PR depuis 24 h ;
  - une tâche bloquée depuis plus de 7 jours ;
  - une PR de tâche de plus de 400 lignes (hors tests).
- **Autres** :
  - un incident ouvert ;
  - un dépôt qui a plus d'un fil en cours.

Le fil « Vue personnalisée du projet » possède les outils du Gantt. Cette section est leur cahier des charges.

**Source de vérité** (mission MoKarade/.github#116, 16/10/2026) : GitHub est la source, le Gantt en est la vue. Chaque relevé écrit trois fichiers dans `commun/outils/gantt/` : `backlog.json` (le relevé), `prochaines.json` (la file, §5) et `fiabilite.json` (`scripts/verif-fidelite.mjs`). Ce dernier relit GitHub directement et mesure :
- **I1 cohérence** : les défauts de la pastille ;
- **I2 fidélité** : les écarts entre le relevé et GitHub (état, étiquettes, PR liée), hors ce qui change après le relevé ;
- **I3 prise tracée** : `en-cours` posé au plus 10 minutes après l'ouverture de la PR (le balayage le pose, §8) ; aucune PR fusionnée sans tâche (robots exclus) ; aucune branche `claude/*` sans tâche ; aucun `en-cours` sans PR depuis plus de 3 h ;
- **I4 accord file/agents** : la tâche lancée était la `suivante` du dernier calcul ; la `suivante` de chaque calcul de `prochaines.json` (toutes les 10 minutes) est gardée par `verif-fidelite.mjs --snapshot-seulement`, et un lancement sur une file de plus de 40 minutes est listé (`perimes`).
On ne dit « fiable » que quand I1 = I2 = 0 sur 20 relevés de suite et que les lancements de la période sont à 100 % ; l'historique n'est jamais remis à zéro.

**Issue d'essai** : un essai qui a besoin d'une vraie issue porte l'étiquette `essai`, est fermé `not_planned` par l'essai lui-même, et le Gantt l'ignore (il ne s'affiche pas, ne compte dans aucune mesure). Le garde-fou de preuve ne rouvre pas une issue `essai` fermée `not_planned`. À la fermeture validée d'une tâche, `en-cours` et `qui:marc` sont retirés par le garde-fou de preuve.

## 14. Cartes de décision (questions à Marc)

Une question à Marc prend toujours la forme d'une **carte**, jamais d'une question perdue dans un long message.

- **Une décision par carte.** La question tient en une douzaine de mots, verbe d'abord, avec les mots de Marc.
- **2 à 4 options**, chacune en un ou deux mots, avec sa conséquence en une phrase.
- **Une recommandation**, avec sa raison et un label de confiance.
- **Le travail continue** sur l'option recommandée pendant l'attente, sauf si le pas est irréversible : suppression, bascule en public, migration destructive, secret, dépense. Dans ce cas, la carte le dit et on attend.
- **Plusieurs questions de cadrage** : un seul lot numéroté (« 1a 2b 3c… »), une recommandation par question, déposé en fichier quand il dépasse 15 lignes.
- **La réponse est consignée** dans l'issue concernée, en commentaire : « Décision de Marc (AAAA-MM-JJ HH:MM, heure du Québec) : … ». Pour le chantier, elle va dans le plan.
- **Un geste de Marc** n'est pas une carte : c'est une issue `qui:marc` avec les étapes exactes. Le fil le dit une fois, et le Gantt le montre dans « Toi ».

## 15. Qui applique ce document

| Mécanisme | Applique |
|---|---|
| Compétence `livrer-une-tache` | §8 à §10, pour chaque fil |
| Garde-fou de preuve (`preuve.yml` commun, appelé par `reacteur.yml` des dix dépôts) | §10 bis : aucune tâche fermée sans preuve valide |
| Routine continue | §5, §6 |
| Gantt et sa pastille | §7, §13 |
| Workflows communs de ce dépôt (`captures`, `fumee`, `rapport-hebdo`) | §8, §11, §12 |
| Réacteur : `reveil-reacteur.yml` (commun), `reacteur.yml` (chaque dépôt) et `boite-reacteur.yml` (`app-template`) | §6 : réveils par événement |
| Instructions du projet (résumé du §0) | tout, pour chaque session |

Ce qui n'est pas encore branché est suivi en tâches sous le chantier « Standardiser les tâches », dans ce dépôt.

## 16. Économie de jetons

Source : `commun/plans/2026-10-15_proposition-economie-tokens.md`. Chaque appel relit tout le contexte du fil : le coût vient de la longueur du fil, du modèle et du nombre de réveils.

- **Une tâche = un fil neuf.** Un fil fini est fermé, pas réutilisé.
- **Passer la main.** Un fil qui dépasse environ 150 k jetons écrit son état dans un fichier de `commun/` et un fil neuf reprend depuis ce fichier.
- **Modèle.** Sonnet 5.5 par défaut, Haiku 5.5 pour le mécanique (tri, relais), Opus sur demande ou pour les tâches floues. Dernière génération seulement, jamais une plus ancienne.
- **Routines.** Toute routine tourne en session neuve. Ce qui est mécanique ne passe pas par Claude (script, CI, workflow).
- **CLAUDE.md.** 60 lignes au plus, sans import de `docs/COMPTE-RENDU.md` ; le détail vit dans `docs/`.
- **Mesure.** Une mesure par semaine avec la même méthode ; le résultat va dans le rapport hebdomadaire (§12).

## 17. Heures

Décision de Marc, 15/10/2026 : **toute heure donnée à Marc est en heure du Québec** (fuseau `America/Toronto`, été et hiver gérés), jamais en UTC.

- Ça vaut partout où il lit : réponses dans le chat et les fils, cartes, commentaires et corps d'issues et de PR, fichiers de `commun/`, rapports, Gantt et pastilles. Format : `HH:MM`, avec la date en `AAAA-MM-JJ` quand elle compte, et la mention « heure du Québec » quand le contexte ne la donne pas.
- L'UTC reste permis là où seule une machine lit : expressions cron (une routine porte `CRON_TZ=America/Toronto` quand c'est possible), horodatages ISO des fichiers de données, journaux des workflows. Dès qu'une de ces heures est dite à Marc, on la convertit.
- Une preuve programmée (§10) est écrite en heure du Québec ; la routine à usage unique qui la porte est créée avec l'équivalent UTC ou `CRON_TZ=America/Toronto`.
