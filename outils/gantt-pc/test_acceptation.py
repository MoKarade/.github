import unittest, acceptation

def com(corps, login='MoKarade', type_='User'):
    return {'body': corps, 'user': {'login': login, 'type': type_}}

ACC = '**Acceptée** — PR #7 fusionnée (abc1234), preuve : lu en production.'

class EstPreuve(unittest.TestCase):
    def test_une_personne_prouve(self):
        self.assertTrue(acceptation.est_preuve(com(ACC)))

    def test_le_robot_avec_le_marqueur_prouve(self):
        self.assertTrue(acceptation.est_preuve(com(ACC + '\n\n<!-- acceptation-auto -->', 'github-actions[bot]', 'Bot')))

    def test_le_robot_sans_le_marqueur_ne_prouve_pas(self):
        self.assertFalse(acceptation.est_preuve(com(ACC, 'github-actions[bot]', 'Bot')))

    def test_un_autre_robot_ne_prouve_pas_meme_avec_le_marqueur(self):
        self.assertFalse(acceptation.est_preuve(com(ACC + '\n<!-- acceptation-auto -->', 'mergify[bot]', 'Bot')))

    def test_jules_ne_prouve_pas(self):
        self.assertFalse(acceptation.est_preuve(com(ACC, 'google-labs-jules[bot]', 'Bot')))
        self.assertFalse(acceptation.est_preuve(com(ACC, 'jules-agent', 'User')))

    def test_un_commentaire_qui_ne_commence_pas_par_acceptee_ne_prouve_pas(self):
        self.assertFalse(acceptation.est_preuve(com('Voir **Acceptée** plus haut')))

    def test_champs_absents(self):
        self.assertFalse(acceptation.est_preuve({}))
        self.assertFalse(acceptation.est_preuve({'body': ACC}))

if __name__ == '__main__':
    unittest.main()
