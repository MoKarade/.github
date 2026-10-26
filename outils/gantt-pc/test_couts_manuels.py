#!/usr/bin/env python3
# Tests de couts_manuels.py : python -X utf8 -m unittest test_couts_manuels.py (depuis outils/gantt-pc). Valeurs FICTIVES uniquement.
import json, os, tempfile, unittest
import couts_manuels as C


def ecrire(dossier, contenu, nom='cm.json'):
    p = os.path.join(dossier, nom)
    with open(p, 'w', encoding='utf-8') as f:
        f.write(contenu if isinstance(contenu, str) else json.dumps(contenu))
    return p


class Lecture(unittest.TestCase):
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self.d = self._d.name

    def tearDown(self):
        self._d.cleanup()

    def test_garde_les_cles_connues_telles_quelles(self):
        src = {'lignes': [['2000-01-01', 'poste-test', 'libelle-test', 1, 'CAD']], 'notes': {'a': 'b'}, 'inconnue': 'x'}
        res, raison = C.lire(ecrire(self.d, src))
        self.assertEqual(raison, 'ok')
        self.assertEqual(res, {'lignes': src['lignes'], 'notes': src['notes']})

    def test_absent(self):
        self.assertEqual(C.lire(os.path.join(self.d, 'nexiste-pas.json')), (None, 'fichier absent'))

    def test_illisible(self):
        res, raison = C.lire(ecrire(self.d, '{pas du json'))
        self.assertIsNone(res)
        self.assertTrue(raison.startswith('illisible'))

    def test_racine_non_objet(self):
        self.assertEqual(C.lire(ecrire(self.d, [1, 2])), (None, 'racine du JSON non objet'))

    def test_aucune_cle_connue(self):
        self.assertEqual(C.lire(ecrire(self.d, {'autre': 1})), (None, 'aucune clé connue'))

    def test_trop_gros(self):
        res, raison = C.lire(ecrire(self.d, '{"notes": "' + 'x' * (C.TAILLE_MAX + 1) + '"}'))
        self.assertIsNone(res)
        self.assertTrue(raison.startswith('fichier trop gros'))

    def test_chemin_par_variable_puis_defaut(self):
        self.assertEqual(C.chemin({'COUTS_MANUELS_FILE': 'x.json'}), 'x.json')
        self.assertEqual(C.chemin({}), C.CHEMIN_DEFAUT)


if __name__ == '__main__':
    unittest.main()
