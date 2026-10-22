import unittest, datetime, completude

MAINT = datetime.datetime(2026, 10, 22, 15, 0, tzinfo=datetime.timezone.utc)
def releve(asof, **tailles): return {'asof': asof, 'repos': [{'repo': d, 'nodes': {str(i): {} for i in range(n)}} for d, n in tailles.items()]}

class Pertes(unittest.TestCase):
    def test_perte_de_cinq_refusee(self):
        p = completude.pertes(releve('2026-10-22T14:31:43Z', eco=95, job=40), releve('2026-10-22T15:00:00Z', eco=90, job=40), MAINT)
        self.assertEqual(p, [('eco', 95, 90)])

    def test_perte_de_quatre_acceptee(self):
        self.assertEqual(completude.pertes(releve('2026-10-22T14:31:43Z', eco=95), releve('2026-10-22T15:00:00Z', eco=91), MAINT), [])

    def test_le_cas_du_22_10_est_refuse(self):
        # 14:31Z : .github perdait environ 75 éléments sur 150
        p = completude.pertes(releve('2026-10-22T13:31:43Z', eco=150, fin=70), releve('2026-10-22T14:31:43Z', eco=75, fin=70), MAINT)
        self.assertEqual(p, [('eco', 150, 75)])

    def test_gain_accepte(self):
        self.assertEqual(completude.pertes(releve('2026-10-22T14:31:43Z', eco=95), releve('2026-10-22T15:00:00Z', eco=120), MAINT), [])

    def test_precedent_trop_vieux_ne_fait_plus_foi(self):
        self.assertEqual(completude.pertes(releve('2026-10-22T11:00:00Z', eco=95), releve('2026-10-22T15:00:00Z', eco=10), MAINT), [])

    def test_precedent_absent_ou_illisible(self):
        n = releve('2026-10-22T15:00:00Z', eco=10)
        for prec in (None, {}, {'asof': 'pas une date', 'repos': []}, {'asof': '2026-10-22T14:00:00Z'}):
            self.assertEqual(completude.pertes(prec, n, MAINT), [])

    def test_depot_disparu_compte_comme_perte(self):
        p = completude.pertes(releve('2026-10-22T14:31:43Z', eco=95, job=40), releve('2026-10-22T15:00:00Z', eco=95), MAINT)
        self.assertEqual(p, [('job', 40, 0)])

if __name__ == '__main__': unittest.main()
