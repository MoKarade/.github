import json, os, tempfile, unittest
import tour


class Reveil:
    def __init__(self, ok=True): self.ok, self.textes = ok, []
    def __call__(self, texte): self.textes.append(texte); return self.ok


class SuivreDrive(unittest.TestCase):
    def test_un_depot_reussi_remet_le_compteur_a_zero(self):
        r = Reveil()
        self.assertEqual(tour.suivre_drive({'tours': 5, 'depuis': 10, 'reveille': 20}, '', 1000, r), {'tours': 0})
        self.assertEqual(r.textes, [])

    def test_premier_echec_ne_reveille_pas(self):
        r = Reveil()
        e = tour.suivre_drive({}, 'FileNotFoundError', 1000, r)
        self.assertEqual((e['tours'], e['depuis'], e['reveille']), (1, 1000, None))
        self.assertEqual(r.textes, [])

    def test_deuxieme_echec_reveille_une_fois(self):
        r = Reveil()
        e = tour.suivre_drive({'tours': 1, 'depuis': 1000, 'reveille': None}, 'x', 1600, r)
        self.assertEqual((e['tours'], e['depuis'], e['reveille']), (2, 1000, 1600))
        self.assertEqual(len(r.textes), 1)
        self.assertTrue(r.textes[0].startswith('RÉACTEUR : Drive absent depuis 2 tours'))
        self.assertLessEqual(len(r.textes[0]), 600)

    def test_pas_de_nouveau_reveil_dans_les_4_h(self):
        r = Reveil()
        e = tour.suivre_drive({'tours': 2, 'depuis': 1000, 'reveille': 1600}, 'x', 1600 + 4 * 3600 - 1, r)
        self.assertEqual((e['tours'], e['reveille']), (3, 1600))
        self.assertEqual(r.textes, [])

    def test_rappel_au_bout_de_4_h(self):
        r = Reveil()
        e = tour.suivre_drive({'tours': 20, 'depuis': 1000, 'reveille': 1600}, 'x', 1600 + 4 * 3600, r)
        self.assertEqual(e['reveille'], 1600 + 4 * 3600)
        self.assertEqual(len(r.textes), 1)

    def test_un_reveil_rate_n_est_pas_enregistre(self):
        r = Reveil(ok=False)
        e = tour.suivre_drive({'tours': 1, 'depuis': 1000, 'reveille': None}, 'x', 1600, r)
        self.assertEqual(e['tours'], 2)
        self.assertIsNone(e['reveille'])
        self.assertEqual(len(r.textes), 1)       # il réessaiera au tour suivant


class DeposerDrive(unittest.TestCase):
    def test_lecteur_absent_est_dit_au_lieu_de_planter(self):
        with tempfile.TemporaryDirectory() as t:
            fichier = os.path.join(t, 'pas-un-dossier')
            open(fichier, 'w').close()
            # makedirs sous un FICHIER échoue : même famille d'erreur (OSError) qu'un lecteur G: démonté sous Windows
            erreur = tour.deposer_drive(os.path.join(fichier, '_Gantt'), 1)
        self.assertNotEqual(erreur, '')
        self.assertIn('Error', erreur)

    def test_depot_reussi_ne_renvoie_rien(self):
        with tempfile.TemporaryDirectory() as t:
            avant = tour.ETAT
            tour.ETAT = os.path.join(t, 'boucle-etat.json')
            try:
                with open(tour.ETAT, 'w', encoding='utf-8') as fh: json.dump({'resultat': 'OK'}, fh)
                dossier = os.path.join(t, 'drive', '_Gantt')
                self.assertEqual(tour.deposer_drive(dossier, 1), '')
                with open(os.path.join(dossier, 'etat.json'), encoding='utf-8') as fh: self.assertEqual(json.load(fh)['resultat'], 'OK')
            finally: tour.ETAT = avant


if __name__ == '__main__':
    unittest.main()
