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

if __name__ == '__main__': unittest.main()
