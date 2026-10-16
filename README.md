# MoKarade/.github

Le dépôt commun aux apps de Marc.

- **Issues** : le travail qui touche plusieurs dépôts (chantiers, missions, tâches communes).
- **`docs/`** : les règles communes, à commencer par le [cycle de vie d'une tâche](docs/cycle-de-vie-tache.md).
- **`scripts/garde-fou.mjs`** : le contrôle « Garde-fou » appelé par `.github/workflows/garde-fou.yml` de chaque dépôt. Il décide si une PR des chemins protégés peut être fusionnée seule par Mergify ; tests : `node --test scripts/garde-fou.test.mjs`.
- **Workflows réutilisables** : les contrôles communs, écrits une fois et appelés par chaque dépôt avec `uses: MoKarade/.github/.github/workflows/<nom>.yml@main`.
  - `securite.yml` : gitleaks sur les commits de la PR, OSV-Scanner sur `package-lock.json`, CodeQL (dépôt public seulement). Actions épinglées par SHA. Un risque accepté s'écrit dans un `osv-scanner.toml` du dépôt, avec sa raison et sa date. Ce dépôt l'applique à lui-même (`securite-ci.yml`).
  - `conformite.yml` : la grille de conformité (15 lignes) lue dans le dépôt appelant, tableau ligne par ligne dans le résumé du job. Détail : [docs/conformite.md](docs/conformite.md). Lancement à la main : workflow « Essai de la conformité ».
  - À venir : `fumee.yml` (PR en cours), `surveillance.yml`.

On change une règle par une PR sur ce dépôt.
