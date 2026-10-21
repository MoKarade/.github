# Ce que build.py transmet à la page depuis prochaines.json. build.py lit le relevé dès son import : on n'en charge que la fonction.
import unittest, os

SRC = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'build.py'), encoding='utf-8').read()
ESPACE = {}
exec(SRC[SRC.index('def compacter_prochaines'):SRC.index('\n', SRC.index("'etats': {r:")) + 1], ESPACE)
compacter = ESPACE['compacter_prochaines']

DEPOT = {'repo': 'MoKarade/JobAI', 'cle': 'jobai', 'depot': 'JobAI', 'statut': 'partiel',
         'suivante': {'ref': 'jobai#200'}, 'suivantes': [{'ref': 'jobai#200'}],
         'places': {'total': 2, 'prises': 1, 'libres': 1},
         'couloirs': [{'place': 1, 'etat': 'occupee', 'ref': 'jobai#199', 'motif': 'en-cours', 'fichiers': ['lib/a.ts']}],
         'sautees_conflit': [{'ref': 'jobai#201', 'avec': 'jobai#199'}],
         'incidents_pc': [{'n': 312, 'titre': 'Entretien du PC : rouge', 'url': 'https://x'}],
         'file': [{'ref': 'jobai#200', 'rang': 1, 'tier': 3, 'prio': 2, 'raison': 'r', 'fichiers': ['lib/b.ts'], 'autre': 1}]}


class TestCompacter(unittest.TestCase):
    def test_places_couloirs_et_fichiers_arrivent_a_la_page(self):
        d = compacter({'depots': [DEPOT]})['depots'][0]
        self.assertEqual(d['places'], {'total': 2, 'prises': 1, 'libres': 1})
        self.assertEqual(d['couloirs'][0]['fichiers'], ['lib/a.ts'])
        self.assertEqual(d['file'][0]['fichiers'], ['lib/b.ts'])
        self.assertNotIn('autre', d['file'][0])

    def test_suivantes_en_refs_comme_suivante(self):
        d = compacter({'depots': [DEPOT]})['depots'][0]
        self.assertEqual(d['suivantes'], ['jobai#200'])
        self.assertEqual(d['suivante'], 'jobai#200')

    def test_alertes_du_pc_et_sautees(self):
        d = compacter({'depots': [DEPOT]})['depots'][0]
        self.assertEqual([i['n'] for i in d['incidents_pc']], [312])
        self.assertEqual(d['sautees_conflit'][0]['ref'], 'jobai#201')

    def test_ancien_prochaines_sans_les_champs(self):
        vieux = {k: v for k, v in DEPOT.items() if k not in ('places', 'couloirs', 'suivantes', 'sautees_conflit', 'incidents_pc')}
        d = compacter({'depots': [vieux]})['depots'][0]
        self.assertEqual((d['places'], d['couloirs'], d['suivantes'], d['incidents_pc']), (None, [], [], []))


if __name__ == '__main__':
    unittest.main()
