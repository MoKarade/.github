import datetime, unittest, defauts_preuve

T = datetime.datetime(2026, 10, 22, 18, 0, tzinfo=datetime.timezone.utc)

def noeud(n, labels=(), state='open', lvl='tâche'):
    return {'n': n, 'lvl': lvl, 'state': state, 'labels': list(labels)}

GH = {'repos': [
    {'repo': 'FinanceAI', 'nodes': {'1': noeud(1240, state='closed'), '2': noeud(1238), '3': noeud(1300, ['preuve-manquante'])}},
    {'repo': 'JobAI', 'nodes': {'1': noeud(161, ['qui:marc', 'preuve-attendue']), '2': noeud(7)}},
]}

def pb(k, ref): return {'k': k, 'ref': ref, 't': 'x', 'u': 'u', 'm': ''}

class Calculer(unittest.TestCase):
    def test_les_trois_motifs_de_preuve_sont_retenus_les_autres_non(self):
        sante = {'pb': [pb('fusionnée sans preuve depuis 2 h', 'FinanceAI#1240'), pb("preuve programmée dépassée depuis plus d'1 h", 'FinanceAI#1238'),
                        pb('fermée sans preuve', 'JobAI#7'), pb('incident ouvert', 'FinanceAI#9'), pb('PR de plus de 400 lignes', 'JobAI#7')]}
        r = defauts_preuve.calculer(GH, sante, T)
        self.assertEqual([(d['ref'], d['k']) for d in r['defauts'] if d['k'] != 'preuve manquante'],
                         [('FinanceAI#1240', 'fusionnée sans preuve depuis 2 h'), ('FinanceAI#1238', "preuve programmée dépassée depuis plus d'1 h"), ('JobAI#7', 'fermée sans preuve')])

    def test_une_tache_qui_attend_marc_est_marquee(self):
        r = defauts_preuve.calculer(GH, {'pb': [pb("preuve programmée dépassée depuis plus d'1 h", 'JobAI#161')]}, T)
        self.assertEqual(r['defauts'][0]['marc'], True)

    def test_une_tache_rouverte_par_le_garde_fou_est_ajoutee_une_fois(self):
        r = defauts_preuve.calculer(GH, {'pb': []}, T)
        self.assertEqual(r['defauts'], [{'k': 'preuve manquante', 'ref': 'FinanceAI#1300', 'marc': False}])
        deja = defauts_preuve.calculer(GH, {'pb': [pb('fermée sans preuve', 'FinanceAI#1300')]}, T)
        self.assertEqual(len(deja['defauts']), 1)

    def test_la_date_est_en_utc(self):
        self.assertEqual(defauts_preuve.calculer(GH, {'pb': []}, T)['calcule_le'], '2026-10-22T18:00:00Z')

    def test_une_reference_inconnue_du_releve_est_ignoree(self):
        refs = [d['ref'] for d in defauts_preuve.calculer(GH, {'pb': [pb('fermée sans preuve', 'Autre#1')]}, T)['defauts']]
        self.assertNotIn('Autre#1', refs)

if __name__ == '__main__':
    unittest.main()
