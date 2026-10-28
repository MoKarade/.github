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

class Bascules(unittest.TestCase):
    # FinanceAI a été remplacé par un dépôt neuf le 28/10/2026 : 90 -> 30 éléments n'est pas une lecture incomplète.
    PREC = releve('2026-10-28T20:33:00Z', FinanceAI=90, JobAI=40)
    FIN = datetime.datetime(2026, 10, 29, 12, 0, tzinfo=datetime.timezone.utc)

    def test_la_bascule_connue_est_acceptee_avant_sa_date(self):
        maint = datetime.datetime(2026, 10, 28, 21, 30, tzinfo=datetime.timezone.utc)
        n = releve('2026-10-28T21:30:00Z', FinanceAI=30, JobAI=40)
        self.assertEqual(completude.pertes(self.PREC, n, maint, bascules={'FinanceAI': self.FIN}), [])

    def test_la_bascule_ne_couvre_que_son_depot(self):
        maint = datetime.datetime(2026, 10, 28, 21, 30, tzinfo=datetime.timezone.utc)
        n = releve('2026-10-28T21:30:00Z', FinanceAI=30, JobAI=20)
        self.assertEqual(completude.pertes(self.PREC, n, maint, bascules={'FinanceAI': self.FIN}), [('JobAI', 40, 20)])

    def test_apres_sa_date_la_garde_reprend(self):
        maint = self.FIN + datetime.timedelta(minutes=1)
        prec = releve('2026-10-29T12:00:00Z', FinanceAI=90)
        n = releve('2026-10-29T12:01:00Z', FinanceAI=30)
        self.assertEqual(completude.pertes(prec, n, maint, bascules={'FinanceAI': self.FIN}), [('FinanceAI', 90, 30)])

    def test_le_cas_reel_du_28_10_passe_avec_la_table_du_module(self):
        maint = datetime.datetime(2026, 10, 28, 21, 30, tzinfo=datetime.timezone.utc)
        self.assertEqual(completude.pertes(self.PREC, releve('2026-10-28T21:30:00Z', FinanceAI=30, JobAI=40), maint), [])

if __name__ == '__main__': unittest.main()
