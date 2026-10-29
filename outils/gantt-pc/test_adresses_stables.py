# Une liste GitHub dont l'adresse change à chaque passage n'a jamais d'ETag : elle coûte à chaque tour, et une liste vide est relue 3 fois (ghcache.lire).
# 29/10/2026 : `repos/R/issues?...&since=<maintenant − 24 h>` de la jauge Gemini = 72 appels comptés par tour (.github#741). quota.py s'exécute à
# l'import : l'adresse se vérifie dans le texte.
import os
import re
import unittest

ICI = os.path.dirname(os.path.abspath(__file__))


def texte(nom):
    with open(os.path.join(ICI, nom), encoding='utf-8') as f:
        return f.read()


class AdressesStables(unittest.TestCase):
    def test_gemini_ne_met_pas_l_instant_dans_l_adresse(self):
        src = texte('quota.py')
        m = re.search(r"def gemini\(\):.*?\ndef claude\(\):", src, re.S)
        self.assertIsNotNone(m)
        corps = m.group(1) if m.groups() else m.group(0)
        self.assertNotIn('since={iso(debut)}', corps)
        self.assertIn('since={since_url}', corps)
        # l'adresse est arrondie au jour ; le filtre exact reste fait en local, sinon la fenêtre de 24 h s'élargirait
        self.assertRegex(corps, r"since_url = iso\(debut\.replace\(hour=0, minute=0, second=0, microsecond=0\)\)")
        self.assertIn("i['updated_at'] >= iso(debut)", corps)

    def test_actions_rapide_ne_liste_que_les_depots_prives_dans_la_fenetre(self):
        # 29/10/2026 : `actions/runs` = 27 à 28 appels par passage, dépôts devenus publics la veille compris. La fenêtre rapide (36 h) ne scrute que
        # les dépôts qui ont été privés dans cette fenêtre ; le relevé complet horaire relit le mois pour tous.
        src = texte('quota.py')
        m = re.search(r"def actions\(\):.*?todo, en_cours = ", src, re.S)
        self.assertIsNotNone(m)
        corps = m.group(0)
        self.assertRegex(corps, r"depuis = iso\(max\(mois0, NOW - 36 \* H\)\) if RAPIDE else since")
        self.assertRegex(corps, r"scrutes = \[r for r in REPOS if visibilite\.a_ete_prive_depuis\(vis, r, depuis\)\]")
        self.assertLess(corps.index('depuis = iso'), corps.index('scrutes = '))

    def test_arrondi_au_jour_ne_change_pas_dans_la_journee(self):
        import datetime
        utc = datetime.timezone.utc
        def since(d): return d.replace(hour=0, minute=0, second=0, microsecond=0).strftime('%Y-%m-%dT%H:%M:%SZ')
        a = datetime.datetime(2026, 10, 28, 1, 11, 5, tzinfo=utc)
        b = a + datetime.timedelta(minutes=10)
        self.assertEqual(since(a), since(b))
        self.assertEqual(since(a), '2026-10-28T00:00:00Z')


if __name__ == '__main__':
    unittest.main()
