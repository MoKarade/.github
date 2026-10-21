# Fin de CI et CI rouge d'une PR fusionnée (ci.py). Tests : python -X utf8 -m unittest test_ci.py
import unittest
from ci import resume_ci


def run(c, u, sha='s2', concl='success', st='completed'):
    return {'created_at': c, 'updated_at': u, 'head_sha': sha, 'conclusion': concl, 'status': st}


class TestResumeCi(unittest.TestCase):
    def test_premiere_vague_du_dernier_commit(self):
        runs = [run('2026-10-21T17:41:00Z', '2026-10-21T17:44:00Z', 's1'),
                run('2026-10-21T17:50:00Z', '2026-10-21T17:52:00Z'), run('2026-10-21T17:51:00Z', '2026-10-21T17:53:30Z'),
                run('2026-10-21T17:57:00Z', '2026-10-21T17:59:00Z')]   # relance à la sortie du brouillon : pas du temps de CI
        self.assertEqual(resume_ci(runs, 's2'), {'ci': '2026-10-21T17:53:30Z', 'cr': 0})

    def test_un_echec_avant_la_fusion_rend_la_pr_rouge(self):
        runs = [run('2026-10-21T17:41:00Z', '2026-10-21T17:44:00Z', 's1', 'failure'), run('2026-10-21T17:50:00Z', '2026-10-21T17:52:00Z')]
        self.assertEqual(resume_ci(runs, 's2')['cr'], 1)

    def test_vague_inachevee_ou_commit_absent_ne_donne_pas_de_fin(self):
        self.assertIsNone(resume_ci([run('2026-10-21T17:50:00Z', '2026-10-21T17:52:00Z', st='in_progress')], 's2')['ci'])
        self.assertEqual(resume_ci([run('2026-10-21T17:50:00Z', '2026-10-21T17:52:00Z', 's1')], 's2'), {'ci': None, 'cr': 0})

    def test_aucun_run_n_est_pas_vert(self):
        self.assertEqual(resume_ci([], 's2'), {'ci': None, 'cr': None})


if __name__ == '__main__': unittest.main()
