import unittest, datetime, economie

MAINT = datetime.datetime(2026, 10, 28, 22, 0, tzinfo=datetime.timezone.utc)
def releve(asof, v=10): return {'v': v, 'asof': asof}

class LegerPossible(unittest.TestCase):
    def test_precedent_recent_et_bon_format(self):
        self.assertTrue(economie.leger_possible(releve('2026-10-28T21:30:00Z'), MAINT))

    def test_precedent_a_45_min_pile_encore_bon_46_trop_vieux(self):
        self.assertTrue(economie.leger_possible(releve('2026-10-28T21:15:00Z'), MAINT))
        self.assertFalse(economie.leger_possible(releve('2026-10-28T21:14:00Z'), MAINT))

    def test_ancien_format_absent_ou_illisible(self):
        for prec in (releve('2026-10-28T21:50:00Z', v=9), None, {}, {'v': 10}, {'v': 10, 'asof': 'pas une date'}):
            self.assertFalse(economie.leger_possible(prec, MAINT))

class SauterLePlein(unittest.TestCase):
    def test_tour_econome_sans_base_pour_un_leger_saute(self):
        self.assertTrue(economie.sauter_le_plein(True, releve('2026-10-28T20:33:00Z'), MAINT))     # le cas du 28/10 : relevé refusé depuis 20:33Z

    def test_tour_econome_avec_base_fait_son_leger(self):
        self.assertFalse(economie.sauter_le_plein(True, releve('2026-10-28T21:50:00Z'), MAINT))

    def test_tour_normal_ne_saute_jamais(self):
        self.assertFalse(economie.sauter_le_plein(False, releve('2026-10-28T20:33:00Z'), MAINT))
        self.assertFalse(economie.sauter_le_plein(False, None, MAINT))

class LigneAppels(unittest.TestCase):
    def test_derniere_ligne_comptee_du_journal(self):
        j = "workflows en file : 3 signalé(s)\nléger : 12 appels comptés (40 en 304 gratuits sur 52), 3.1 s, 400 reprises\n"
        self.assertEqual(economie.ligne_appels(j), 'léger : 12 appels comptés (40 en 304 gratuits sur 52), 3.1 s, 400 reprises')

    def test_plusieurs_lignes_la_derniere_gagne(self):
        j = "plein : 280 appels comptés (0 en 304 gratuits sur 280), 90 s\nléger : 9 appels comptés (1 en 304 gratuits sur 10), 2 s\n"
        self.assertTrue(economie.ligne_appels(j).startswith('léger : 9'))

    def test_les_chemins_les_plus_couteux_suivent_la_ligne_comptee(self):
        j = "léger : 9 appels comptés (1 en 304 gratuits sur 10), 2 s, 3 reprises\nappels comptés par chemin : repos/R/issues 6, repos/R/pulls/N 3\n"
        self.assertEqual(economie.ligne_appels(j), "léger : 9 appels comptés (1 en 304 gratuits sur 10), 2 s, 3 reprises ; appels comptés par chemin : repos/R/issues 6, repos/R/pulls/N 3")

    def test_absente_ou_vide_rend_vide_jamais_un_zero(self):
        for j in ('', None, 'rien à voir\nautre ligne'):
            self.assertEqual(economie.ligne_appels(j), '')

if __name__ == '__main__': unittest.main()
