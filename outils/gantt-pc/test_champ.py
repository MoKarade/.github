# Lecture d'un champ du gabarit (`champ` de fetch.py). fetch.py interroge GitHub dès son import : on n'en charge que la fonction.
import re, unittest, os

SRC = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fetch.py'), encoding='utf-8').read()
ESPACE = {'re': re}
exec(SRC[SRC.index('def champ'):SRC.index('GESTE =')], ESPACE)
champ = ESPACE['champ']
ESPACE['LEGER'] = True
exec(SRC[SRC.index('def pr_gardee'):SRC.index('ATTEND_MARC =')], ESPACE)
pr_gardee = ESPACE['pr_gardee']
exec(SRC[SRC.index('FP = re.compile'):SRC.index("# Étapes d'une tâche")], ESPACE)
exec(SRC[SRC.index('def du_backlog'):SRC.index('ATTEND_MARC =')], ESPACE)
du_backlog = ESPACE['du_backlog']
fichiers_declares = ESPACE['fichiers_declares']
fichiers_permis = ESPACE['fichiers_permis']


def issue(*etiquettes, **extra):
    return {'number': 1, 'labels': [{'name': e} for e in etiquettes], **extra}


class TestDuBacklog(unittest.TestCase):
    # Le cycle de vie dit que le Gantt ignore les issues `essai` ; fetch.py ne filtrait que sur `niveau:*` (.github#571, #572, tâche #576).
    def test_une_tache_normale_entre(self):
        self.assertTrue(du_backlog(issue('niveau:tâche', 'prio:1')))

    def test_une_issue_essai_avec_niveau_est_ecartee(self):
        self.assertFalse(du_backlog(issue('niveau:tâche', 'essai')))
        self.assertFalse(du_backlog(issue('essai', 'niveau:mission')))

    def test_une_pr_ou_une_issue_sans_niveau_est_ecartee(self):
        self.assertFalse(du_backlog(issue('niveau:tâche', pull_request={})))
        self.assertFalse(du_backlog(issue('prio:1')))


class TestChamp(unittest.TestCase):
    def test_champ_simple(self):
        self.assertEqual(champ('**Après** : simple\n**Fini quand** : x', 'Après'), 'simple')

    def test_precision_entre_parentheses_avant_les_deux_points(self):
        corps = '**Avant** : a\n\n**Après** (besoin validé par Marc le 19/10/2026 : « Oui ») : sur chaque ligne\n\n**Fini quand** : x'
        self.assertEqual(champ(corps, 'Après'), 'sur chaque ligne')

    def test_champ_absent(self):
        self.assertIsNone(champ('**Avant** : a\n**Fini quand** : x', 'Après'))
        self.assertIsNone(champ('**Après** (sans deux-points)\n', 'Après'))


class TestFichiersDeclares(unittest.TestCase):
    # « **Attend** : aucune » commence par « * » : ce n'est pas une puce (une puce est suivie d'une espace), sinon la liste déborde (.github#374, #375).
    def test_la_ligne_suivante_en_gras_n_est_pas_une_puce(self):
        corps = '**Fichiers touchés** :\n- `scripts/a.mjs`\n- `docs/b.md`\n**Attend** : aucune\n'
        self.assertEqual(fichiers_declares(corps), ['scripts/a.mjs', 'docs/b.md'])

    def test_puces_avec_tiret_ou_etoile(self):
        self.assertEqual(fichiers_declares('**Fichiers touchés** :\n- app/page.tsx pour la carte\n* lib/x.ts\n'), ['app/page.tsx', 'lib/x.ts'])

    def test_liste_vide_suivie_d_un_champ_en_gras_ne_lit_rien(self):
        self.assertIsNone(fichiers_declares('**Fichiers touchés** :\n**Attend** : aucune\n'))

    def test_fichiers_permis_ne_compte_pas_le_champ_suivant(self):
        corps = '**Fichiers permis** (aucun autre) :\n- `a.py`\n- `b.py`\n**Attend** : aucune\n'
        self.assertEqual(fichiers_permis(corps), 2)


class TestPrGardee(unittest.TestCase):
    FUSIONNEE = {'n': 130, 'state': 'closed', 'merged': '2026-10-17T10:00:00Z', 'kind': 'tache'}

    def test_pr_ancienne_hors_de_la_premiere_page_est_gardee(self):
        self.assertEqual(pr_gardee(None, {'pr': self.FUSIONNEE}), self.FUSIONNEE)

    def test_pr_trouvee_ou_ouverte_ou_nommee_dans_le_corps_ou_relevé_plein(self):
        autre = {'n': 9, 'state': 'open'}
        self.assertEqual(pr_gardee(autre, {'pr': self.FUSIONNEE}), autre)
        self.assertIsNone(pr_gardee(None, {'pr': {'n': 5, 'state': 'open'}}))
        self.assertIsNone(pr_gardee(None, {'pr': {**self.FUSIONNEE, 'kind': 'corps'}}))
        self.assertIsNone(pr_gardee(None, None))
        ESPACE['LEGER'] = False
        try:
            self.assertIsNone(pr_gardee(None, {'pr': self.FUSIONNEE}))
        finally:
            ESPACE['LEGER'] = True


if __name__ == '__main__':
    unittest.main()
