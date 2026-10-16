# Grille de conformité

Source : plan de standardisation du 15/10/2026 (`commun/plans/2026-10-15_plan-standardisation.md`, décision 1 et lignes 13 à 15 de l'audit NotebookLM). Un dépôt est « fini » quand les lignes qui le concernent sont vertes. Le contrôle est `.github/workflows/conformite.yml` (workflow commun, logique dans `scripts/conformite.mjs`, tests dans `scripts/conformite.test.mjs`).

## Appeler la grille

```yaml
jobs:
  conformite:
    uses: MoKarade/.github/.github/workflows/conformite.yml@main
    with:
      bloquant: false   # true : le job échoue si une ligne est rouge
      racine: .         # « web » chez batchchef-
```

Le tableau ligne par ligne s'écrit dans le résumé du job. Le workflow « Essai de la conformité » le lance à la main contre un dépôt public.

## États

| État | Sens |
|---|---|
| vert | tous les sous-contrôles de la ligne passent |
| ROUGE | un sous-contrôle échoue ; la cause est écrite dans le tableau |
| sans objet | la ligne ne concerne pas le dépôt (une bibliothèque n'a ni Vercel ni Sentry) |
| à relire | la CI ne peut pas lire l'information : jamais déclaré vert |

## Ce que chaque ligne lit

| # | Règle | Lecture |
|---|---|---|
| 1 | Dépôt public, branche protégée | API : `private`, protection de la branche par défaut (au moins un contrôle exigé) |
| 2 | CI sur machines GitHub | chaque `runs-on` nomme une machine GitHub ; chaque job a `timeout-minutes` (ou appelle un workflow) ; aucun `paths:` sur un déclencheur de PR |
| 3 | Gate | `typecheck`, `lint`, `test`, `build` existent dans `package.json` ET un workflow les lance |
| 4 | Couverture | `qualite/seuils.json` porte un seuil `couverture.*` |
| 5 | Fumée | un workflow appelle `fumee.yml` |
| 6 | Sécurité | `securite.yml` appelé (ou gitleaks, CodeQL et OSV-Scanner chacun présents) ; Dependabot ; `npm audit` en CI ; scan de secrets et protection au push (réglage administrateur : « à relire » si la CI ne le voit pas) |
| 7 | Versions | Next ≥ 16, React ≥ 19, vitest ≥ 5, zod ≥ 4, TypeScript ≥ 5.9 et `strict`, Node 24, contrat hub au dernier tag. La version INSTALLÉE (`package-lock.json`) fait foi |
| 8 | Vercel | `vercel.json` : seule la branche par défaut se déploie, le motif générique est désactivé |
| 9 | Surveillance | dépendance `@sentry/*`, route `app/api/sante`, dépôt listé avec une route de santé dans `surveillance/apps.json` (MoKarade/.github) |
| 10 | Base | `lib/migrations.ts` ou `db:migrate` dans `vercel-build` ; la sauvegarde vit sur le PC : toujours « à relire » |
| 11 | Docs | `CLAUDE.md` ≤ 60 lignes, `HANDOVER.md`, `docs/adr/`, `BACKLOG.md` ≤ 20 lignes avec un renvoi vers les issues, `docs/COMPTE-RENDU.md` |
| 12 | Socle visuel | `app/globals.css` en variables, thème sombre (`prefers-color-scheme: dark` ou `data-theme`, ou un sombre seul voulu : `color-scheme: dark` posé à la racine `:root`, `html` ou `body`, hors `@media`), verrou `tests/theme.test.*` |
| 13 | Actions épinglées | chaque `uses:` finit par un SHA de 40 caractères. Exceptions : `./…`, `docker://…` et l'appel d'un workflow commun `MoKarade/.github/.github/workflows/<nom>.yml@main` |
| 14 | Crons | aucun cron `vercel.json` plus fréquent que par jour (minute et heure fixes) |
| 15 | Préfixes | les 10 derniers commits non fusionnés de la branche par défaut et le titre de la PR portent `feat:`, `fix:`, `docs:`… ou `[ID]` ou `HORS-BACKLOG:` |

## Sombre seul voulu (ligne 12)

Une app qui reste en sombre seul sur décision de Marc (Hubperso, JobAI) le déclare par `color-scheme: dark` dans une règle de premier niveau sur `:root`, `html` ou `body` de `app/globals.css`. Les variables CSS et le verrou `tests/theme.test.*` restent exigés. Ne comptent pas : `color-scheme: light dark`, la même déclaration sur un composant, dans un `@media` ou en commentaire.

## Limites connues

- Le contrôle lit des fichiers et l'API publique avec `github.token` : les réglages réservés aux administrateurs (scan de secrets, protection au push) peuvent sortir « à relire » en CI alors qu'ils sont actifs.
- Un outil équivalent n'est pas reconnu : Semgrep ne remplace pas CodeQL à la ligne 6, c'est écrit dans la cause.
- La ligne 11 ne vérifie pas le « format commun » de `CLAUDE.md`, seulement sa longueur et ses voisins.
- Un `runs-on` conditionnel qui garde un repli `self-hosted` passe à la ligne 2 tant qu'il nomme aussi une machine GitHub.
