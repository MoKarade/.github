import unittest, sonde_rest

def ech(t, restant, reset=100, procs=()): return {'t': t, 'restant': restant, 'reset': reset, 'procs': [{'nom': n, 'cmd': c} for n, c in procs]}

class Chutes(unittest.TestCase):
    def test_une_baisse_est_rapportee_avec_ses_deux_extremites(self):
        c = sonde_rest.chutes([ech('a', 2000), ech('b', 1900), ech('c', 1900)])
        self.assertEqual([(x['depuis'], x['t'], x['appels']) for x in c], [('a', 'b', 100)])

    def test_pas_de_baisse_pas_de_chute(self):
        self.assertEqual(sonde_rest.chutes([ech('a', 2000), ech('b', 2000), ech('c', 2001)]), [])

    def test_remise_a_zero_n_est_jamais_une_consommation(self):
        # le restant remonte ET le reset change ; ou bien il baisse mais dans une autre fenêtre horaire : dans les deux cas, rien
        self.assertEqual(sonde_rest.chutes([ech('a', 10, reset=100), ech('b', 5000, reset=200)]), [])
        self.assertEqual(sonde_rest.chutes([ech('a', 4000, reset=100), ech('b', 3000, reset=200)]), [])

    def test_liste_vide_ou_un_seul_pas(self):
        self.assertEqual(sonde_rest.chutes([]), [])
        self.assertEqual(sonde_rest.chutes([ech('a', 1)]), [])

class Suspects(unittest.TestCase):
    def test_processus_vus_avant_et_apres_passent_en_premier(self):
        avant = [('python.exe', 'carnet.py'), ('gh.exe', 'gh api a')]
        apres = [('python.exe', 'carnet.py'), ('gh.exe', 'gh api b')]
        c = sonde_rest.chutes([ech('a', 100, procs=avant), ech('b', 40, procs=apres)])[0]
        self.assertEqual(sonde_rest.processus_communs(c), ['python.exe carnet.py'])

    def test_sans_processus_commun_on_rend_l_union_sans_inventer(self):
        c = sonde_rest.chutes([ech('a', 100, procs=[('gh.exe', 'gh api a')]), ech('b', 40, procs=[('node.exe', 'x.mjs')])])[0]
        self.assertEqual(sonde_rest.processus_communs(c), ['gh.exe gh api a', 'node.exe x.mjs'])
        vide = sonde_rest.chutes([ech('a', 100), ech('b', 40)])[0]
        self.assertEqual(sonde_rest.processus_communs(vide), [])

class Resume(unittest.TestCase):
    def test_total_des_baisses_hors_remise_a_zero(self):
        r = sonde_rest.resume([ech('a', 1000, 1), ech('b', 900, 1), ech('c', 5000, 2), ech('d', 4950, 2)])
        self.assertEqual((r['pas'], r['baisses'], r['appels']), (4, 2, 150))

class Processus(unittest.TestCase):
    def test_la_commande_est_tronquee_et_la_sonde_s_ignore(self):
        self.assertTrue(all(len(p['cmd']) <= sonde_rest.LONGUEUR_COMMANDE for p in sonde_rest.processus()))
        self.assertFalse(any('sonde_rest' in p['cmd'] for p in sonde_rest.processus()))

if __name__ == '__main__': unittest.main()
