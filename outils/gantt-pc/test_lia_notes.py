#!/usr/bin/env python3
# Tests de lia_notes.py : python -X utf8 -m unittest test_lia_notes.py (depuis outils/gantt-pc). Secret et réponses du hub FICTIFS.
import json
import os
import tempfile
import unittest
import lia_notes as L


def hub(code=200, corps=None):
    def requete(url, secret):
        requete.vus.append((url, secret))
        if isinstance(code, Exception): raise code
        return code, json.dumps(corps) if not isinstance(corps, str) else corps
    requete.vus = []
    return requete


class Lecture(unittest.TestCase):
    def test_nombre_et_inconnu(self):
        self.assertEqual(L.lire_notes('s', hub(corps={'ok': True, 'notesLia': 3})), (3, ''))
        self.assertEqual(L.lire_notes('s', hub(corps={'ok': True, 'notesLia': 0})), (0, ''))
        self.assertEqual(L.lire_notes('s', hub(corps={'ok': True, 'notesLia': None})), (None, ''))      # inconnu : jamais 0

    def test_valeurs_invalides_refusees(self):
        for mauvais in (-1, 'trois', 2.5, True, [1]):
            n, raison = L.lire_notes('s', hub(corps={'notesLia': mauvais}))
            self.assertEqual((n, raison), (None, 'notesLia invalide'))
        self.assertEqual(L.lire_notes('s', hub(corps='pas du json'))[1], 'réponse illisible')

    def test_codes_http_et_reseau_disent_la_raison(self):
        self.assertIn('route pas encore en ligne', L.lire_notes('s', hub(404, {}))[1])
        self.assertIn('secret refusé', L.lire_notes('s', hub(401, {}))[1])
        self.assertIn('OSError', L.lire_notes('s', hub(OSError('coupé')))[1])

    def test_le_secret_part_en_en_tete_pas_dans_l_adresse(self):
        r = hub(corps={'notesLia': 1})
        L.lire_notes('secret-fictif', r)
        self.assertEqual(r.vus, [(L.URL_HUB, 'secret-fictif')])
        self.assertNotIn('secret', L.URL_HUB)


class Decision(unittest.TestCase):
    def test_premiere_note_reveille(self):
        texte, etat = L.decider(1, {}, 1000)
        self.assertIn('1 note(s) non lue(s)', texte)
        self.assertEqual(etat, {'signale': 1, 'quand': 1000})

    def test_meme_nombre_ne_reveille_pas_avant_le_rappel(self):
        self.assertIsNone(L.decider(2, {'signale': 2, 'quand': 1000}, 1000 + L.RAPPEL_S - 1)[0])
        self.assertIsNotNone(L.decider(2, {'signale': 2, 'quand': 1000}, 1000 + L.RAPPEL_S)[0])

    def test_nombre_qui_monte_reveille_celui_qui_baisse_non(self):
        self.assertIsNotNone(L.decider(3, {'signale': 2, 'quand': 1000}, 1100)[0])
        texte, etat = L.decider(1, {'signale': 3, 'quand': 1000}, 1100)
        self.assertEqual((texte, etat), (None, {'signale': 1, 'quand': 1000}))
        self.assertIsNotNone(L.decider(2, etat, 1200)[0])         # remonte au-dessus du dernier niveau suivi

    def test_zero_remet_a_zero(self):
        self.assertEqual(L.decider(0, {'signale': 3, 'quand': 1000}, 1100), (None, {'signale': 0, 'quand': None}))
        self.assertIsNotNone(L.decider(1, {'signale': 0, 'quand': None}, 1200)[0])


class Passer(unittest.TestCase):
    def setUp(self):
        self.dossier = tempfile.mkdtemp()
        self.secret = os.path.join(self.dossier, 'secret.txt')
        self.etat = os.path.join(self.dossier, 'etat.json')
        with open(self.secret, 'w') as f: f.write('x' * 32)
        self.reveils = []

    def passer(self, requete, ts=1000, reussit=True):
        def reveiller(texte): self.reveils.append(texte); return reussit
        return L.passer(ts, reveiller, self.secret, self.etat, requete)

    def test_secret_absent_se_dit_sans_lever(self):
        os.remove(self.secret)
        self.assertIn('secret absent', self.passer(hub(corps={'notesLia': 2})))
        self.assertEqual(self.reveils, [])

    def test_inconnu_ne_declenche_rien_et_n_ecrit_pas_d_etat(self):
        self.assertIn('inconnues', self.passer(hub(corps={'notesLia': None})))
        self.assertEqual(self.reveils, [])
        self.assertFalse(os.path.exists(self.etat))

    def test_reveil_puis_silence_puis_rappel(self):
        self.assertIn('réveil envoyé', self.passer(hub(corps={'notesLia': 2})))
        self.assertIn('déjà signalée', self.passer(hub(corps={'notesLia': 2}), ts=1600))
        self.passer(hub(corps={'notesLia': 2}), ts=1000 + L.RAPPEL_S)
        self.assertEqual(len(self.reveils), 2)

    def test_reveil_rate_n_est_pas_enregistre(self):
        self.assertIn('ÉCHEC', self.passer(hub(corps={'notesLia': 2}), reussit=False))
        self.assertFalse(os.path.exists(self.etat))
        self.assertIn('réveil envoyé', self.passer(hub(corps={'notesLia': 2}), ts=1600))      # le tour suivant réessaie
        self.assertEqual(len(self.reveils), 2)

    def test_zero_note_dit_aucune_et_ne_reveille_pas(self):
        self.assertEqual(self.passer(hub(corps={'notesLia': 0})), 'LIA : aucune note non lue')
        self.assertEqual(self.reveils, [])

    def test_hub_en_panne_se_dit(self):
        self.assertIn('route pas encore en ligne', self.passer(hub(404, {})))
        self.assertEqual(self.reveils, [])


if __name__ == '__main__':
    unittest.main()
