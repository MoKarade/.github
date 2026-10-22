import unittest, ghcache

ghcache.ATTENTES_VIDE = (0, 0, 0)

class LireVide(unittest.TestCase):
    def avec(self, reponses):
        """Remplace une lecture par une suite de (JSON, vide confirmée par le cache en 304) ; rend le nombre de lectures."""
        suite, n = list(reponses), [0]
        def faux(path, *args, **kw):
            n[0] += 1
            return suite.pop(0)
        self._ancienne, ghcache._lire = ghcache._lire, faux
        self.addCleanup(lambda: setattr(ghcache, '_lire', self._ancienne))
        return n

    def test_page_vide_puis_pleine_rend_la_pleine(self):
        n = self.avec([([], False), ([1, 2, 3], False)])
        self.assertEqual(ghcache.lire('repos/x/issues?page=4'), [1, 2, 3])
        self.assertEqual(n[0], 2)

    def test_vide_trois_fois_de_suite_reste_vide(self):
        n = self.avec([([], False)] * 4)
        self.assertEqual(ghcache.lire('repos/x/issues?page=4'), [])
        self.assertEqual(n[0], 4)                       # la lecture, puis trois relectures

    def test_premiere_page_vide_en_200_est_relue(self):
        # FinanceAI, 22/10/2026 : la première page d'une liste pleine est revenue vide 2 fois sur 6
        n = self.avec([([], False), ([4, 5], False)])
        self.assertEqual(ghcache.lire('repos/x/issues?state=all&page=1'), [4, 5])
        self.assertEqual(n[0], 2)

    def test_vide_confirmee_par_le_cache_une_seule_lecture(self):
        n = self.avec([([], True)])
        self.assertEqual(ghcache.lire('repos/x/issues?labels=incident'), [])
        self.assertEqual(n[0], 1)                       # une vraie liste vide, déjà vue vide : 304 gratuit, rien de plus

    def test_page_suivante_vide_relue_meme_confirmee(self):
        n = self.avec([([], True), ([9], False)])
        self.assertEqual(ghcache.lire('repos/x/issues?page=2', verifier_vide=True), [9])
        self.assertEqual(n[0], 2)

    def test_liste_non_vide_une_seule_lecture(self):
        n = self.avec([([1], True)])
        self.assertEqual(ghcache.lire('repos/x/issues?page=1'), [1])
        self.assertEqual(n[0], 1)

    def test_listage_actions_vide_malgre_un_total(self):
        n = self.avec([({'total_count': 12, 'workflow_runs': []}, False), ({'total_count': 12, 'workflow_runs': [{'id': 1}]}, False)])
        self.assertEqual(ghcache.lire('repos/x/actions/runs?page=2', verifier_vide=True)['workflow_runs'], [{'id': 1}])
        self.assertEqual(n[0], 2)

    def test_objet_non_liste_jamais_relu(self):
        n = self.avec([({'id': 5}, True)])
        self.assertEqual(ghcache.lire('repos/x/issues/5'), {'id': 5})
        self.assertEqual(n[0], 1)

    def test_compteur_de_relectures(self):
        avant = ghcache.STATS['relectures_vide']
        self.avec([([], False), ([1], False)])
        ghcache.lire('repos/x/issues?page=4')
        self.assertEqual(ghcache.STATS['relectures_vide'], avant + 1)

class CacheDisque(unittest.TestCase):
    """Vrai _lire, `gh api` simulé : ce qui entre au cache (ETag compris) et ce qu'un 304 en fait."""
    def setUp(self):
        import tempfile, types
        self.dossier = tempfile.mkdtemp() + '/'
        anciens = (ghcache.DOSSIER, ghcache.ACTIF, ghcache.subprocess.run)
        ghcache.DOSSIER, ghcache.ACTIF = self.dossier, True
        self.addCleanup(lambda: (setattr(ghcache, 'DOSSIER', anciens[0]), setattr(ghcache, 'ACTIF', anciens[1]), setattr(ghcache.subprocess, 'run', anciens[2])))
        self.sortie, self.envoyes = [], []
        def faux(cmd, **kw):
            self.envoyes.append(cmd)
            return types.SimpleNamespace(stdout=self.sortie.pop(0), stderr='', returncode=0)
        ghcache.subprocess.run = faux

    @staticmethod
    def rep(statut, etag, corps=''):
        return f'HTTP/2.0 {statut} X\nEtag: {etag}\n\n{corps}'

    def test_une_vide_passagere_ne_remplace_pas_la_bonne_liste_du_cache(self):
        self.sortie[:] = [self.rep(200, '"E1"', '[1,2]')]
        self.assertEqual(ghcache.lire('repos/x/issues?page=1'), [1, 2])
        # la même page revient vide en 200 (ETag différent), puis la relecture reçoit un 304 sur la bonne liste
        self.sortie[:] = [self.rep(200, '"E0"', '[]'), self.rep(304, '"E1"')]
        self.assertEqual(ghcache.lire('repos/x/issues?page=1'), [1, 2])
        self.assertIn('If-None-Match: "E1"', self.envoyes[-1])      # le cache gardait E1, pas l'ETag de la vide

    def test_une_vraie_liste_vide_entre_au_cache_apres_les_relectures(self):
        self.sortie[:] = [self.rep(200, '"E0"', '[]')] * 4
        self.assertEqual(ghcache.lire('repos/x/issues?labels=incident'), [])
        self.sortie[:] = [self.rep(304, '"E0"')]
        n = len(self.envoyes)
        self.assertEqual(ghcache.lire('repos/x/issues?labels=incident'), [])
        self.assertEqual(len(self.envoyes), n + 1)                  # confirmée en 304 : une seule lecture

if __name__ == '__main__': unittest.main()
