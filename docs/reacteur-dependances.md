# Une tâche fermée réveille les dépôts qui l'attendaient

Tâche MoKarade/.github#870, mission #703 (phase 4), demande de Marc du 29/10/2026.

## Avant

Le Réacteur d'un dépôt ne réveillait que ce dépôt. Le 29/10/2026, app-template#213 est fermée à 14:50Z : les six tâches de l'onglet Apps des autres dépôts (« Attend : app-template#213 ») n'ont rien reçu pendant 20 minutes, jusqu'à un réveil à la main.

## Maintenant

À la fermeture d'une tâche **prouvée** (`completed`, c'est-à-dire ni abandonnée ni rouverte par le garde-fou de preuve), le Réacteur :

1. lit les tâches ouvertes (`niveau:tâche`) des **autres** dépôts de la constellation (les clés de `BOITES`) ;
2. garde celles dont la ligne `**Attend**` cite la tâche fermée (même lecture que la file : `lireAttend`, alias `batchchef` compris) ;
3. pour chaque dépôt concerné, lit sa file (`fileDuDepot`) : si une tâche citée est la suivante (ou dans les suivantes) il réveille la boîte de CE dépôt, avec les mêmes règles que tout autre réveil (déduplication de 6 h, session neuve lancée par la routine « Prendre une tâche », jamais un titre dans le message).

Le message est de la forme `RÉACTEUR : D libre ; suivante : #m ; tâche D0#n fermée ; D#m peut partir`.

## Ce qui ne bouge pas

- Aucun `schedule:` ou `cron:`, aucun secret de plus : le jeton de réveil existant sert.
- Un dépôt dont aucune tâche ne cite la fermée n'est pas réveillé. Une tâche citée mais pas prenable (bloquée, hors file) ne réveille pas non plus : le journal le dit.
- Une lecture qui échoue (dépôt privé, panne) est un avertissement : les autres dépôts partent quand même, et le filet de 6 h reprend la main.
- La fermeture d'une tâche abandonnée (`not_planned`) ne réveille personne : sa dépendance n'est pas levée.

## Choix à connaître

La tâche proposait un `repository_dispatch` `filet` sur le `reacteur.yml` du dépôt dépendant. Le filet ne réveille que pour une PR rouge, un incident ou une branche rouge : il ne dirait rien d'une tâche devenue prenable. Le réveil passe donc par la boîte du dépôt, comme `tache_fermee` pour le dépôt lui-même.

## Vérifier

- `node --test scripts/dependants-autres-depots.test.mjs scripts/reveil-reacteur.test.mjs`
- Cas réel : après une fermeture prouvée qui est citée dans un autre dépôt, un commentaire du bot « peut partir » apparaît sur la boîte de ce dépôt dans les 5 minutes.
