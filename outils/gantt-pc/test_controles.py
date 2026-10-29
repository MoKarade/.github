# Contrôles ajoutés au relevé : `chemin_illisible` (build.py) et `plein_force` (tour.py). Ces deux fichiers font du travail à l'import : on n'en charge que la fonction.
import os, unittest

DIR = os.path.dirname(os.path.abspath(__file__))
def charger(fichier, debut, fin):
    src = open(os.path.join(DIR, fichier), encoding='utf-8').read()
    espace = {}
    exec(src[src.index(debut):src.index(fin)], espace)
    return espace

chemin_illisible = charger('build.py', 'def chemin_illisible', 'def sante')['chemin_illisible']
plein_force = charger('tour.py', 'def plein_force', 'def lancer')['plein_force']


class TestCheminIllisible(unittest.TestCase):
    def test_une_ligne_en_gras_prise_pour_une_puce(self):
        self.assertTrue(chemin_illisible('*Attend**'))
        self.assertTrue(chemin_illisible('**Attend** : aucune'))

    def test_libelle_avec_deux_points_ou_espace_ou_vide(self):
        self.assertTrue(chemin_illisible('Attend : aucune'))
        self.assertTrue(chemin_illisible('à faire'))
        self.assertTrue(chemin_illisible(''))

    def test_chemins_et_motifs_permis(self):
        for c in ('scripts/fichiers-communs.mjs', 'docs/claude/*.md', '.github/workflows/graphe.yml', 'package.json'):
            self.assertFalse(chemin_illisible(c), c)


class TestPleinForce(unittest.TestCase):
    MESURE = {'calcule_le': '2026-10-21T17:03:10.204Z', 'i2': {'ecarts': [{'ref': '.github#122'}]}}

    def test_ecarts_non_traites_forcent_un_plein(self):
        self.assertEqual(plein_force(self.MESURE, None, False), '2026-10-21T17:03:10.204Z')

    def test_une_seule_fois_par_mesure(self):
        self.assertIsNone(plein_force(self.MESURE, '2026-10-21T17:03:10.204Z', False))
        self.assertEqual(plein_force(self.MESURE, '2026-10-21T16:03:20.761Z', False), '2026-10-21T17:03:10.204Z')

    def test_rien_sans_ecart_ni_en_tour_econome_ni_sans_mesure(self):
        self.assertIsNone(plein_force({'calcule_le': 'x', 'i2': {'ecarts': []}}, None, False))
        self.assertIsNone(plein_force({'calcule_le': 'x'}, None, False))
        self.assertIsNone(plein_force(self.MESURE, None, True))
        self.assertIsNone(plein_force(None, None, False))
        self.assertIsNone(plein_force({'i2': {'ecarts': [1]}}, None, False))


if __name__ == '__main__':
    unittest.main()
