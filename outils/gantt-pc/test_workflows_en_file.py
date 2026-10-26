# Workflows qui attendent un robot (workflows_en_file.py, tâche .github#532). Tests : python3 -m unittest test_workflows_en_file
import datetime, os, unittest
import workflows_en_file as w

MAINT = datetime.datetime(2026, 10, 22, 20, 40, tzinfo=datetime.timezone.utc)


def run(event, depuis_h, status='queued', ident=1, nom='Poll Smartcar'):
    t = MAINT - datetime.timedelta(hours=depuis_h)
    return {'id': ident, 'name': nom, 'event': event, 'status': status, 'created_at': t.strftime('%Y-%m-%dT%H:%M:%SZ'), 'html_url': f'https://x/{ident}'}


class EnFile(unittest.TestCase):
    def test_un_schedule_en_file_depuis_plus_d_1_h_est_un_defaut(self):
        r = w.en_file([run('schedule', 2.8)], MAINT)
        self.assertEqual([(x['wf'], x['event'], x['h']) for x in r], [('Poll Smartcar', 'schedule', 2.8)])

    def test_un_schedule_recent_n_est_rien(self):
        self.assertEqual(w.en_file([run('schedule', 0.5)], MAINT), [])

    def test_une_pr_attend_6_h_avant_d_etre_un_defaut(self):
        self.assertEqual(w.en_file([run('pull_request', 5.9), run('pull_request', 2)], MAINT), [])
        self.assertEqual(len(w.en_file([run('pull_request', 6.1)], MAINT)), 1)

    def test_seul_queued_compte(self):
        self.assertEqual(w.en_file([run('schedule', 9, status='in_progress'), run('schedule', 9, status='completed')], MAINT), [])

    def test_le_plus_ancien_d_abord(self):
        r = w.en_file([run('schedule', 2, ident=1), run('schedule', 9, ident=2)], MAINT)
        self.assertEqual([x['run'] for x in r], [2, 1])

    def test_date_absente_ou_illisible_ne_signale_rien(self):
        self.assertEqual(w.en_file([{'status': 'queued', 'event': 'schedule'}, {'status': 'queued', 'event': 'schedule', 'created_at': 'hier'}, None], MAINT), [])

    def test_liste_vide_ou_absente(self):
        self.assertEqual(w.en_file([], MAINT), [])
        self.assertEqual(w.en_file(None, MAINT), [])


class Relever(unittest.TestCase):
    def test_chaque_depot_est_lu_et_nomme(self):
        lus = []
        def lire(chemin):
            lus.append(chemin)
            return {'workflow_runs': [run('schedule', 3)] if 'CarAI' in chemin else []}
        liste, err = w.relever([('CarAI', 'car'), ('FinanceAI', 'fin')], lire, MAINT)
        self.assertEqual([x['repo'] for x in liste], ['CarAI'])
        self.assertEqual(err, [])
        self.assertTrue(all('status=queued' in c for c in lus))

    def test_un_depot_illisible_est_dit_et_les_autres_sont_lus(self):
        def lire(chemin):
            if 'jobai' in chemin: raise RuntimeError('HTTP 502')
            return {'workflow_runs': [run('schedule', 3)]}
        liste, err = w.relever([('jobai', 'job'), ('carai', 'car')], lire, MAINT)
        self.assertEqual([x['repo'] for x in liste], ['carai'])
        self.assertEqual(len(err), 1)
        self.assertIn('jobai', err[0])

    def test_reponse_inattendue_est_dite(self):
        liste, err = w.relever([('carai', 'car')], lambda c: [], MAINT)
        self.assertEqual((liste, len(err)), ([], 1))


class Exceptions(unittest.TestCase):
    def test_le_run_fantome_nomme_n_est_pas_un_defaut_mais_reste_visible(self):
        fantome = {'repo': 'driveai', 'run': 29254315500, 'wf': 'CI', 'event': 'pull_request', 'h': 2521.0, 'u': 'https://x/1'}
        autre = {'repo': 'driveai', 'run': 1, 'wf': 'CI', 'event': 'pull_request', 'h': 9.0, 'u': 'https://x/2'}
        defauts, exceptions = w.separer([fantome, autre])
        self.assertEqual([x['run'] for x in defauts], [1])
        self.assertEqual([x['run'] for x in exceptions], [29254315500])
        self.assertIn('non actionnable', exceptions[0]['raison'])

    def test_ce_n_est_pas_un_filtre_general(self):
        # même dépôt, autre lancement ; même numéro, autre dépôt : rien n'est écarté
        defauts, exceptions = w.separer([{'repo': 'carai', 'run': 29254315500}, {'repo': 'DriveAI', 'run': 2}])
        self.assertEqual((len(defauts), exceptions), (2, []))

    def test_liste_vide_ou_absente(self):
        self.assertEqual(w.separer([]), ([], []))
        self.assertEqual(w.separer(None), ([], []))


class Branchement(unittest.TestCase):
    """build.py et fetch.py font du travail à l'import : on vérifie le branchement dans leur texte."""
    def test_le_controle_est_liste_et_alimente_par_le_releve(self):
        d = os.path.dirname(os.path.abspath(__file__))
        b = open(os.path.join(d, 'build.py'), encoding='utf-8').read()
        f = open(os.path.join(d, 'fetch.py'), encoding='utf-8').read()
        self.assertIn("'workflow en file sans robot']", b)
        self.assertIn("separer(gh.get('en_file'))", b)
        self.assertIn("res['en_file']", f)


if __name__ == '__main__':
    unittest.main()
