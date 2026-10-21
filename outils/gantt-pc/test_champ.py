# Lecture d'un champ du gabarit (`champ` de fetch.py). fetch.py interroge GitHub dès son import : on n'en charge que la fonction.
import re, unittest, os

SRC = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fetch.py'), encoding='utf-8').read()
ESPACE = {'re': re}
exec(SRC[SRC.index('def champ'):SRC.index('GESTE =')], ESPACE)
champ = ESPACE['champ']


class TestChamp(unittest.TestCase):
    def test_champ_simple(self):
        self.assertEqual(champ('**Après** : simple\n**Fini quand** : x', 'Après'), 'simple')

    def test_precision_entre_parentheses_avant_les_deux_points(self):
        corps = '**Avant** : a\n\n**Après** (besoin validé par Marc le 19/10/2026 : « Oui ») : sur chaque ligne\n\n**Fini quand** : x'
        self.assertEqual(champ(corps, 'Après'), 'sur chaque ligne')

    def test_champ_absent(self):
        self.assertIsNone(champ('**Avant** : a\n**Fini quand** : x', 'Après'))
        self.assertIsNone(champ('**Après** (sans deux-points)\n', 'Après'))


if __name__ == '__main__':
    unittest.main()
