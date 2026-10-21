#!/usr/bin/env python3
# Tests des décisions pures de quota_claude.py : python -X utf8 -m unittest test_quota_claude.py (depuis outils/gantt-pc)
import datetime, json, unittest
from unittest import mock
import quota_claude as Q

T = datetime.datetime(2026, 10, 21, 13, 0, tzinfo=datetime.timezone.utc)
USAGE = """Current session: 18% used · resets Oct 21, 6:30pm (America/Toronto)
Current week (all models): 44.5% used · resets Oct 28, 8:00am (America/Toronto)
Current week (Fable): 0% used · resets Oct 28, 8:00am (America/Toronto)"""


def sortie(**champs):
    return mock.Mock(stdout=json.dumps(champs), returncode=0)


class Mesure(unittest.TestCase):
    def test_heure_locale_vers_utc(self):
        self.assertEqual(Q.heure_utc('Oct', '28', '8', '00', 'am', 'America/Toronto', T), '2026-10-28T12:00Z')
        self.assertEqual(Q.heure_utc('Oct', '21', '12', '00', 'pm', 'America/Toronto', T), '2026-10-21T16:00Z')

    def test_lignes_du_rapport_usage(self):
        trouves = [m.groups() for m in Q.LIGNE.finditer(USAGE)]
        self.assertEqual([t[0] for t in trouves], ['session', 'week (all models)', 'week (Fable)'])
        self.assertEqual(float(trouves[1][2]), 44.5)

    def test_mesure_lit_la_semaine_et_les_modeles(self):
        with mock.patch.object(Q, 'run', return_value=sortie(is_error=False, result=USAGE)):
            res = Q.mesurer()
        self.assertEqual(res['pct'], 44.5)
        self.assertEqual(res['reset_utc'], '2026-10-28T12:00Z')
        self.assertEqual(res['session']['pct'], 18.0)
        self.assertEqual(res['par_modele']['Fable']['pct'], 0.0)

    def test_non_connecte_est_dit_tel_quel(self):
        with mock.patch.object(Q, 'run', return_value=sortie(is_error=True, result='OAuth session expired')):
            with self.assertRaisesRegex(ValueError, 'non connecté, reconnexion requise'):
                Q.mesurer()

    def test_format_change_reste_une_autre_erreur(self):
        with mock.patch.object(Q, 'run', return_value=sortie(is_error=False, result='rien de lisible')):
            with self.assertRaisesRegex(ValueError, 'introuvable'):
                Q.mesurer()


if __name__ == '__main__':
    unittest.main()
