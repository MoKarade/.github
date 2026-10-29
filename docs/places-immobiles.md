# Places immobiles : une tâche `en-cours` sans PR libère sa place

Décision de Marc (29/10/2026, 15:00Z, « oui go » sur le rapport « Workflow Apps : objectif, bilan et direction », décision 2). Mission MoKarade/.github#703, tâche #868.

## Le problème

Une tâche `en-cours` tient une place du dépôt (`PLACES_PAR_DEPOT`). Quand son fil s'arrête sans ouvrir de PR, la place reste prise : FinanceAI avait 5 `en-cours` pour 3 places, MemoryAI 4, et leurs files (28 tâches sur 38) ne sortaient rien. L'alerte du Gantt existait, elle ne libérait rien.

## Ce qui se passe (à l'événement, aucun minuteur)

`scripts/place-immobile.mjs` est une étape du pilotage du Réacteur (`pilotage-evenement.mjs`, étape `immobiles`). Elle part sur une tâche ouverte ou fermée, une PR fusionnée et le filet.

| Situation d'une tâche `en-cours` | Ce qui se passe |
| --- | --- |
| Moins de 3 h depuis la pose de `en-cours`, ou une PR ouverte la cite (dans n'importe quel dépôt de MoKarade) | Rien. |
| Plus de 3 h, aucune PR, pas encore de marqueur | Un commentaire `<!-- place-immobile -->`, une seule fois par tâche, et un signal « place immobile : dépôt#n » qui réveille la boîte du fil. |
| Marqueur de plus d'une heure, ni PR ni commentaire après lui | `en-cours` retiré, `bloqué` posé, raison écrite (« Aucune PR depuis N h, place libérée »). La file avance. |
| Le fil a écrit après le marqueur | Rien : il est vivant. |

## Ce qui ne bouge jamais

- Une tâche `preuve-attendue`, `qui:marc` ou `jules`.
- Une tâche citée par une PR ouverte, même dans un autre dépôt (.github#748 a ses PR dans les neuf dépôts d'app) : lue par la recherche GitHub.
- Une tâche qui attend un relevé du PC ou un déploiement : un commentaire `**Relevé PC demandé**`, `**Relevé PC**` ou `**Preuve attendue**` posé après `en-cours`, il y a moins de 24 h, la protège (cas Hubperso#719, 29/10/2026 : le fil PC attendait un déploiement).
- L'issue : elle n'est jamais fermée. On pose `bloqué`, le fil du dépôt décide (il retire `bloqué` pour reprendre).
- Une lecture impossible (événements, commentaires, recherche) ne libère rien : mieux vaut une place occupée de trop qu'un travail réel retiré. Elle est dite dans les erreurs du pilotage (run rouge, donc issue `boucle:erreur`).

## Vérifier

`node --test scripts/place-immobile.test.mjs` (contrôle « Tests du réveil du Coordinateur »). En production : sur un dépôt qui avait une tâche immobile, la lecture de `file-depot.mjs` montre une place de plus après le second passage.
