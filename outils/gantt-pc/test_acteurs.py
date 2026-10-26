# Qui a travaillé sur une tâche (acteurs.py).
import os, sys, unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from acteurs import acteurs, qui


def cm(nom, date, message='feat: x', login=None):
    return {'commit': {'author': {'name': nom, 'date': date}, 'committer': {'name': nom, 'date': date}, 'message': message}, 'author': {'login': login} if login else None}


class TestActeurs(unittest.TestCase):
    def test_copilot_et_jules_se_lisent_dans_l_auteur_du_commit(self):
        self.assertEqual(qui(cm('copilot-swe-agent[bot]', '2026-10-26T18:57:53Z')), 'Copilot')
        self.assertEqual(qui(cm('google-labs-jules[bot]', '2026-10-26T14:00:49Z')), 'Jules')
        self.assertEqual(qui(cm('MoKarade', '2026-10-26T14:00:49Z', login='Copilot')), 'Copilot')

    def test_claude_se_lit_dans_l_attribution_du_message(self):
        self.assertEqual(qui(cm('MoKarade', '2026-10-26T19:00:00Z', 'feat: y\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>')), 'Claude')
        self.assertEqual(qui(cm('MoKarade', '2026-10-26T19:00:00Z', 'x\n\nClaude-Session: https://claude.ai/code/session_01')), 'Claude')

    def test_un_commit_sans_signe_est_a_marc(self):
        self.assertEqual(qui(cm('MoKarade', '2026-10-26T19:00:00Z', 'fix: à la main')), 'Marc')

    def test_plage_par_acteur_du_plus_tot_au_plus_tard(self):
        r = acteurs([
            cm('google-labs-jules[bot]', '2026-10-26T14:08:46Z'),
            cm('google-labs-jules[bot]', '2026-10-26T14:00:49Z'),
            cm('MoKarade', '2026-10-26T15:30:00Z', 'x\n\nCo-Authored-By: Claude <n@a.c>'),
        ])
        self.assertEqual(r, [
            {'qui': 'Jules', 'debut': '2026-10-26T14:00:49Z', 'fin': '2026-10-26T14:08:46Z', 'commits': 2},
            {'qui': 'Claude', 'debut': '2026-10-26T15:30:00Z', 'fin': '2026-10-26T15:30:00Z', 'commits': 1},
        ])

    def test_sans_commit_ni_date_rien(self):
        self.assertEqual(acteurs([]), [])
        self.assertEqual(acteurs(None), [])
        self.assertEqual(acteurs([{'commit': {'message': 'x'}}]), [])


if __name__ == '__main__':
    unittest.main()
