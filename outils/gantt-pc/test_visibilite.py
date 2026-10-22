import unittest, visibilite as v

class Visibilite(unittest.TestCase):
    def test_depot_prive_depuis_toujours(self):
        h = {}
        self.assertTrue(v.noter(h, 'driveai', True, '2026-10-22T10:00:00Z'))
        self.assertTrue(v.etait_prive(h, 'driveai', '2026-10-01T00:00:00Z'))
        self.assertFalse(v.noter(h, 'driveai', True, '2026-10-22T11:00:00Z'))     # lecture identique : rien de neuf
        self.assertEqual(len(h['driveai']), 1)

    def test_financeai_public_avant_le_21_10(self):
        h = {}
        v.noter(h, 'FinanceAI', True, '2026-10-22T10:00:00Z')                     # semé : public puis privé le 21/10 à 18:06Z
        self.assertFalse(v.etait_prive(h, 'FinanceAI', '2026-10-16T12:00:00Z'))   # 2 279 min du 16/10 : gratuites
        self.assertFalse(v.etait_prive(h, 'FinanceAI', '2026-10-21T18:05:59Z'))
        self.assertTrue(v.etait_prive(h, 'FinanceAI', '2026-10-21T18:06:00Z'))
        self.assertTrue(v.etait_prive(h, 'FinanceAI', '2026-10-22T09:00:00Z'))
        self.assertEqual(len(h['FinanceAI']), 2)                                  # la lecture « privé » confirme le semis, rien d'ajouté

    def test_depot_devenu_public_ne_compte_que_sa_periode_privee(self):
        h = {}
        v.noter(h, 'carai', False, '2026-10-22T10:00:00Z')
        self.assertTrue(v.etait_prive(h, 'carai', '2026-10-05T00:00:00Z'))
        self.assertFalse(v.etait_prive(h, 'carai', '2026-10-19T13:20:54Z'))
        self.assertFalse(v.etait_prive(h, 'carai', '2026-10-21T00:00:00Z'))

    def test_changement_vu_en_direct_ajoute_un_passage(self):
        h = {}
        v.noter(h, 'hubperso', False, '2026-10-22T10:00:00Z')
        self.assertTrue(v.noter(h, 'hubperso', True, '2026-10-25T08:00:00Z'))
        self.assertFalse(v.etait_prive(h, 'hubperso', '2026-10-25T07:59:59Z'))
        self.assertTrue(v.etait_prive(h, 'hubperso', '2026-10-25T08:00:00Z'))

    def test_depot_inconnu_ne_compte_pas(self):
        self.assertFalse(v.etait_prive({}, 'zzz', '2026-10-22T00:00:00Z'))

    def test_a_ete_prive_depuis(self):
        h = {}
        for r, p in (('FinanceAI', True), ('carai', False), ('app-template', False)):
            v.noter(h, r, p, '2026-10-22T10:00:00Z')
        mois = '2026-10-01T04:00:00Z'
        self.assertTrue(v.a_ete_prive_depuis(h, 'FinanceAI', mois))
        self.assertTrue(v.a_ete_prive_depuis(h, 'carai', mois))                  # privé du 1er au 19/10 : à relire
        self.assertFalse(v.a_ete_prive_depuis(h, 'carai', '2026-10-20T00:00:00Z'))
        self.assertFalse(v.a_ete_prive_depuis(h, 'app-template', mois))

    def test_passages_pour_la_note(self):
        h = {}
        for r, p in (('FinanceAI', True), ('carai', False)):
            v.noter(h, r, p, '2026-10-22T10:00:00Z')
        self.assertEqual(v.passages(h, 'FinanceAI', '2026-10-01T04:00:00Z'), [('2026-10-21T18:06:00Z', True)])
        self.assertEqual(v.passages(h, 'carai', '2026-10-01T04:00:00Z'), [('2026-10-19T13:20:54Z', False)])

    def test_total_du_22_10_recalcule(self):
        # mesure réelle du 22/10 14:32Z (quota.json) : (dépôt, créée, minutes) ; avant : 5 981 min comptées, après : seulement le privé
        h = {}
        for r, p in (('FinanceAI', True), ('driveai', True), ('carai', False), ('memoryai', False)):
            v.noter(h, r, p, '2026-10-22T14:32:00Z')
        runs = [('FinanceAI', '2026-10-16T12:00:00Z', 2279), ('FinanceAI', '2026-10-21T17:00:00Z', 92),
                ('FinanceAI', '2026-10-21T18:30:00Z', 87), ('driveai', '2026-10-15T09:00:00Z', 110),
                ('carai', '2026-10-05T09:00:00Z', 83), ('carai', '2026-10-19T15:00:00Z', 143), ('memoryai', '2026-10-01T09:00:00Z', 167)]
        total = sum(m for r, c, m in runs if v.etait_prive(h, r, c))
        self.assertEqual(total, 87 + 110 + 83 + 167)

if __name__ == '__main__': unittest.main()
