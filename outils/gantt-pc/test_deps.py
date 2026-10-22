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

class LireAttend(unittest.TestCase):
    def test_la_forme_courte_garde_le_depot(self):
        corps = "**Attend** : Hubperso#311 (socle), hub-contract#78 (contrat), MemoryAI#63 (mémoire) ; une seule tâche à la fois."
        self.assertEqual(deps.lire_attend(corps, 'batchchef-'), ['hubperso#311', 'hub-contract#78', 'memoryai#63'])

    def test_les_formes_historiques_restent_lues(self):
        self.assertEqual(deps.lire_attend('**Attend** : #12, MoKarade/x#3, MoKarade/.github#9 — raison #77', 'jobai'), ['jobai#12', 'x#3', '.github#9'])

    def test_batchchef_seul_vaut_son_nom_de_depot(self):
        self.assertEqual(deps.lire_attend('**Attend** : BatchChef#5 et batchchef-#6', 'hubperso'), ['batchchef-#5', 'batchchef-#6'])

    def test_rien_n_attend_rien(self):
        self.assertEqual(deps.lire_attend('**Attend** : rien (PR #208 fusionnée)', 'a'), [])
        self.assertEqual(deps.lire_attend('**Attend** : aucune', 'a'), [])

    def test_un_nom_de_depot_dans_un_mot_ne_compte_pas(self):
        self.assertEqual(deps.lire_attend('**Attend** : super-carai#4 ; xmemoryai#5 ; mon-hub-contract#6', 'a'), ['a#4', 'a#5', 'a#6'])

    def test_seule_la_ligne_attend_compte(self):
        self.assertEqual(deps.lire_attend('**Avant** : Hubperso#1\n**Attend** : #2', 'a'), ['a#2'])
        self.assertEqual(deps.lire_attend(None, 'a'), [])

if __name__ == '__main__': unittest.main()
