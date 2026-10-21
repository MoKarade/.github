# Lecture d'un champ du gabarit (`champ` de fetch.py). fetch.py interroge GitHub dès son import : on n'en charge que la fonction.
import re, unittest, os

SRC = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fetch.py'), encoding='utf-8').read()
ESPACE = {'re': re}
exec(SRC[SRC.index('def champ'):SRC.index('GESTE =')], ESPACE)
champ = ESPACE['champ']
ESPACE['LEGER'] = True
exec(SRC[SRC.index('def pr_gardee'):SRC.index('ATTEND_MARC =')], ESPACE)
pr_gardee = ESPACE['pr_gardee']


class TestChamp(unittest.TestCase):
    def test_champ_simple(self):
        self.assertEqual(champ('**Après** : simple\n**Fini quand** : x', 'Après'), 'simple')

    def test_precision_entre_parentheses_avant_les_deux_points(self):
        corps = '**Avant** : a\n\n**Après** (besoin validé par Marc le 19/10/2026 : « Oui ») : sur chaque ligne\n\n**Fini quand** : x'
        self.assertEqual(champ(corps, 'Après'), 'sur chaque ligne')

    def test_champ_absent(self):
        self.assertIsNone(champ('**Avant** : a\n**Fini quand** : x', 'Après'))
        self.assertIsNone(champ('**Après** (sans deux-points)\n', 'Après'))


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
