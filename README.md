# MoKarade/.github

Le dépôt commun aux apps de Marc.

- **Issues** : le travail qui touche plusieurs dépôts (chantiers, missions, tâches communes).
- **`docs/`** : les règles communes, à commencer par le [cycle de vie d'une tâche](docs/cycle-de-vie-tache.md).
- **`scripts/garde-fou.mjs`** : le contrôle « Garde-fou » appelé par `.github/workflows/garde-fou.yml` de chaque dépôt. Il décide si une PR des chemins protégés peut être fusionnée seule par Mergify ; tests : `node --test scripts/garde-fou.test.mjs`.
- **Workflows réutilisables** (à venir) : autres contrôles communs appelés par chaque dépôt.

On change une règle par une PR sur ce dépôt.
