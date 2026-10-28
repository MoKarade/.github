#!/usr/bin/env python3
# Tests de taux_change.py : python -X utf8 -m unittest test_taux_change.py (depuis outils/gantt-pc). Réponses de la banque FICTIVES (valeurs rondes).
import json
import unittest
import taux_change as T


def reponse(*obs):
    return json.dumps({'observations': [{'d': d, 'FXUSDCAD': {'v': v}} for d, v in obs]})


def jamais(url=None):
    raise AssertionError('la banque ne devait pas être sollicitée')


def panne(url=None):
    raise OSError('réseau coupé')


class Analyse(unittest.TestCase):
    def test_prend_la_date_la_plus_recente_quel_que_soit_l_ordre(self):
        r = T.analyser(reponse(('2000-01-04', '1.5'), ('2000-01-06', '1.4'), ('2000-01-05', '1.45')))
        self.assertEqual(r, {'taux': 1.4, 'date': '2000-01-06'})

    def test_saute_une_observation_illisible_mais_lit_les_autres(self):
        texte = json.dumps({'observations': [{'d': '2000-01-06', 'FXUSDCAD': {'v': 'abc'}}, {'d': '2000-01-05', 'FXUSDCAD': {'v': '1.25'}}, {'d': 'hier', 'FXUSDCAD': {'v': '1.3'}}]})
        self.assertEqual(T.analyser(texte), {'taux': 1.25, 'date': '2000-01-05'})

    def test_refuse_un_taux_hors_bornes_ou_non_fini(self):
        for v in ('0', '-1.4', '9.9', 'nan', 'inf'):
            with self.assertRaises(ValueError, msg=v):
                T.analyser(reponse(('2000-01-06', v)))

    def test_refuse_une_reponse_sans_observation(self):
        for texte in ('', '{}', '{"observations": []}', '{"observations": "x"}', 'pas du json'):
            with self.assertRaises(ValueError, msg=texte):
                T.analyser(texte)


class Mesure(unittest.TestCase):
    MAINTENANT = '2000-01-06T12:00:00Z'

    def test_premiere_lecture_porte_taux_date_source_et_instant(self):
        r = T.mesure(None, self.MAINTENANT, lambda: reponse(('2000-01-05', '1.4')))
        self.assertEqual(r, {'taux': 1.4, 'date': '2000-01-05', 'source': T.SOURCE, 'releve': self.MAINTENANT})

    def test_un_taux_recent_n_est_pas_relu(self):
        ancien = {'taux': 1.4, 'date': '2000-01-05', 'source': T.SOURCE, 'releve': '2000-01-06T07:00:00Z'}
        self.assertIs(T.mesure(ancien, self.MAINTENANT, jamais), ancien)

    def test_un_taux_ancien_est_relu_et_remplace(self):
        ancien = {'taux': 1.4, 'date': '2000-01-04', 'source': T.SOURCE, 'releve': '2000-01-06T05:00:00Z'}
        r = T.mesure(ancien, self.MAINTENANT, lambda: reponse(('2000-01-05', '1.5')))
        self.assertEqual((r['taux'], r['date'], r['releve']), (1.5, '2000-01-05', self.MAINTENANT))
        self.assertNotIn('erreur', r)

    def test_panne_garde_le_dernier_taux_marque_perime(self):
        ancien = {'taux': 1.4, 'date': '2000-01-04', 'source': T.SOURCE, 'releve': '2000-01-06T05:00:00Z'}
        r = T.mesure(ancien, self.MAINTENANT, panne)
        self.assertEqual(r['taux'], 1.4)
        self.assertEqual(r['perime'], '2000-01-06T05:00:00Z')
        self.assertIn('OSError', r['erreur'])
        self.assertEqual(r['releve'], '2000-01-06T05:00:00Z', 'l\'instant de la mesure ne bouge pas : la page voit son âge réel')

    def test_panne_sans_taux_connu_rend_none_jamais_un_taux_invente(self):
        r = T.mesure(None, self.MAINTENANT, panne)
        self.assertIsNone(r['taux'])
        self.assertIsNone(r['date'])
        self.assertIn('OSError', r['erreur'])

    def test_reponse_illisible_se_traite_comme_une_panne(self):
        r = T.mesure(None, self.MAINTENANT, lambda: '{}')
        self.assertIsNone(r['taux'])
        self.assertIn('ValueError', r['erreur'])

    def test_un_ancien_en_erreur_est_relu_meme_s_il_est_recent(self):
        ancien = {'taux': 1.4, 'date': '2000-01-04', 'source': T.SOURCE, 'releve': '2000-01-06T11:00:00Z', 'perime': '2000-01-06T11:00:00Z', 'erreur': 'x'}
        r = T.mesure(ancien, self.MAINTENANT, lambda: reponse(('2000-01-05', '1.5')))
        self.assertEqual(r['taux'], 1.5)
        self.assertNotIn('erreur', r)


if __name__ == '__main__':
    unittest.main()
