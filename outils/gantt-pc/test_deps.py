import unittest, deps

class Normaliser(unittest.TestCase):
    def test_une_pr_qui_cite_une_tache_devient_cette_tache(self):
        self.assertEqual(deps.normaliser(['jobai#208'], 'jobai#161', {'jobai#208': 'jobai#162'}, {'jobai#208'}), ['jobai#162'])

    def test_une_pr_fusionnee_sans_tache_est_une_dependance_levee(self):
        self.assertEqual(deps.normaliser(['jobai#209', 'jobai#150'], 'jobai#151', {}, {'jobai#209'}), ['jobai#150'])

    def test_une_tache_reste_une_tache(self):
        self.assertEqual(deps.normaliser(['.github#16'], 'driveai#492', {}, set()), ['.github#16'])

    def test_un_numero_inconnu_est_garde_pour_la_pastille(self):
        self.assertEqual(deps.normaliser(['memoryai#128'], '.github#16', {}, {'memoryai#40'}), ['memoryai#128'])

    def test_jamais_soi_meme_ni_doublon(self):
        self.assertEqual(deps.normaliser(['a#1', 'a#2', 'a#1', 'a#9'], 'a#1', {'a#9': 'a#2'}, set()), ['a#2'])

    def test_vide(self):
        self.assertEqual(deps.normaliser([], 'a#1', {}, set()), [])

if __name__ == '__main__': unittest.main()
