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

    def test_recus_gmail_s_ajoutent_au_registre_sans_le_remplacer(self):
        reg = ecrire(self.d, {'notes': {'a': 'b'}})
        recus = ecrire(self.d, {'v': 1, 'lu_le': '2000-01-01T00:00:00Z', 'erreur': None, 'recus': [{'id': 'm1'}], 'autre': 'ignoré'}, 'r.json')
        res, raison = C.lire(reg, recus)
        self.assertEqual(raison, 'ok')
        self.assertEqual(res, {'notes': {'a': 'b'}, 'recus_gmail': {'lu_le': '2000-01-01T00:00:00Z', 'erreur': None, 'recus': [{'id': 'm1'}]}})

    def test_recus_gmail_seuls_suffisent(self):
        recus = ecrire(self.d, {'lu_le': None, 'erreur': 'reautoriser', 'recus': []}, 'r.json')
        res, raison = C.lire(os.path.join(self.d, 'nexiste-pas.json'), recus)
        self.assertEqual((raison, sorted(res)), ('ok', ['recus_gmail']))
        self.assertEqual(res['recus_gmail']['erreur'], 'reautoriser')

    def test_recus_absents_ou_illisibles_ne_changent_rien(self):
        reg = ecrire(self.d, {'notes': {'a': 'b'}})
        for r in (os.path.join(self.d, 'x.json'), ecrire(self.d, '{pas du json', 'r1.json'), ecrire(self.d, {'recus': 'x'}, 'r2.json')):
            self.assertEqual(C.lire(reg, r), ({'notes': {'a': 'b'}}, 'ok'))

    def test_chemin_par_variable_puis_defaut(self):
        self.assertEqual(C.chemin_recus({'GMAIL_RECUS_FILE': 'r.json'}), 'r.json')
        self.assertEqual(C.chemin_recus({}), C.RECUS_DEFAUT)
        self.assertEqual(C.chemin({'COUTS_MANUELS_FILE': 'x.json'}), 'x.json')
        self.assertEqual(C.chemin({}), C.CHEMIN_DEFAUT)


if __name__ == '__main__':
    unittest.main()
