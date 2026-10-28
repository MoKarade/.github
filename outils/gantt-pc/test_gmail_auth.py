#!/usr/bin/env python3
# Tests de gmail_auth.py : python -X utf8 -m unittest test_gmail_auth.py (depuis outils/gantt-pc).
# Identifiants et jetons FICTIFS : aucune donnée réelle, aucun appel réseau, pas de DPAPI (chiffrement simulé).
import base64
import hashlib
import json
import os
import tempfile
import unittest
import urllib.parse

import gmail_auth as A

# « chiffrement » de test : réversible, ne ressemble pas au clair
PROTEGER = lambda b: b'ENC:' + base64.b64encode(b[::-1])
DEPROTEGER = lambda b: base64.b64decode(b[4:])[::-1]


def lire_octets(p):
    with open(p, 'rb') as f:
        return f.read()


class Pkce(unittest.TestCase):
    def test_defi_est_le_sha256_du_verifier_en_base64url_sans_bourrage(self):
        v, d = A.pkce()
        self.assertTrue(43 <= len(v) <= 128)
        attendu = base64.urlsafe_b64encode(hashlib.sha256(v.encode()).digest()).rstrip(b'=').decode()
        self.assertEqual(d, attendu)
        self.assertNotIn('=', d)

    def test_deux_tirages_different(self):
        self.assertNotEqual(A.pkce()[0], A.pkce()[0])

    def test_url_ne_demande_que_la_lecture_seule(self):
        q = urllib.parse.parse_qs(urllib.parse.urlsplit(A.url_autorisation('cid', 'http://127.0.0.1:1', 'dd', 'ee')).query)
        self.assertEqual(q['scope'], ['https://www.googleapis.com/auth/gmail.readonly'])
        self.assertEqual(q['code_challenge_method'], ['S256'])
        self.assertEqual(q['access_type'], ['offline'])
        self.assertEqual(q['redirect_uri'], ['http://127.0.0.1:1'])


class Client(unittest.TestCase):
    def ecrire(self, d, contenu):
        p = os.path.join(d, 'c.json')
        with open(p, 'w') as f:
            f.write(contenu)
        return p

    def test_lit_un_client_de_bureau(self):
        with tempfile.TemporaryDirectory() as d:
            p = self.ecrire(d, json.dumps({'installed': {'client_id': 'id-fictif', 'client_secret': 'secret-fictif'}}))
            self.assertEqual(A.lire_client(p), ('id-fictif', 'secret-fictif'))

    def test_secret_facultatif(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(A.lire_client(self.ecrire(d, json.dumps({'installed': {'client_id': 'id-fictif'}}))), ('id-fictif', None))

    def test_absent_et_illisible_ont_des_codes_distincts(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(A.ErreurGmail) as c:
                A.lire_client(os.path.join(d, 'nexiste-pas.json'))
            self.assertEqual(c.exception.code, 'client_absent')
            for contenu in ('pas du json', '[]', '{}', '{"installed": {}}'):
                with self.assertRaises(A.ErreurGmail) as c:
                    A.lire_client(self.ecrire(d, contenu))
                self.assertEqual(c.exception.code, 'client_illisible', contenu)


class Jeton(unittest.TestCase):
    def test_le_fichier_du_jeton_n_est_jamais_en_clair(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, 'j.bin')
            A.sauver_jeton('refresh-fictif-123', p, PROTEGER)
            self.assertNotIn(b'refresh-fictif-123', lire_octets(p))
            self.assertEqual(A.charger_jeton(p, DEPROTEGER), 'refresh-fictif-123')

    def test_jeton_absent(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(A.ErreurGmail) as c:
                A.charger_jeton(os.path.join(d, 'x.bin'), DEPROTEGER)
            self.assertEqual(c.exception.code, 'jeton_absent')

    def prep(self, d, secret=True):
        cp, jp = os.path.join(d, 'c.json'), os.path.join(d, 'j.bin')
        with open(cp, 'w') as f:
            json.dump({'installed': {'client_id': 'id-fictif', **({'client_secret': 's-fictif'} if secret else {})}}, f)
        A.sauver_jeton('ancien', jp, PROTEGER)
        return cp, jp

    def test_acces_obtenu_avec_le_jeton_de_renouvellement(self):
        vu = {}

        def requete(methode, url, donnees=None, entetes=None):
            vu.update(methode=methode, url=url, donnees=donnees)
            return 200, {'access_token': 'acces-fictif'}
        with tempfile.TemporaryDirectory() as d:
            cp, jp = self.prep(d)
            self.assertEqual(A.jeton_d_acces(cp, jp, requete, DEPROTEGER, PROTEGER), 'acces-fictif')
            self.assertEqual(vu['donnees']['grant_type'], 'refresh_token')
            self.assertEqual(vu['donnees']['refresh_token'], 'ancien')
            self.assertEqual(vu['donnees']['client_secret'], 's-fictif')
            self.assertEqual(A.charger_jeton(jp, DEPROTEGER), 'ancien')

    def test_un_nouveau_jeton_de_renouvellement_remplace_l_ancien(self):
        with tempfile.TemporaryDirectory() as d:
            cp, jp = self.prep(d)
            A.jeton_d_acces(cp, jp, lambda *a, **k: (200, {'access_token': 'a', 'refresh_token': 'neuf'}), DEPROTEGER, PROTEGER)
            self.assertEqual(A.charger_jeton(jp, DEPROTEGER), 'neuf')

    def test_invalid_grant_demande_a_reautoriser(self):
        with tempfile.TemporaryDirectory() as d:
            cp, jp = self.prep(d)
            with self.assertRaises(A.ErreurGmail) as c:
                A.jeton_d_acces(cp, jp, lambda *a, **k: (400, {'error': 'invalid_grant'}), DEPROTEGER, PROTEGER)
            self.assertEqual(c.exception.code, 'reautoriser')

    def test_panne_de_reponse_n_est_pas_une_reautorisation(self):
        with tempfile.TemporaryDirectory() as d:
            cp, jp = self.prep(d)
            with self.assertRaises(A.ErreurGmail) as c:
                A.jeton_d_acces(cp, jp, lambda *a, **k: (503, {}), DEPROTEGER, PROTEGER)
            self.assertEqual(c.exception.code, 'reponse')

    def test_echange_du_code_exige_un_jeton_de_renouvellement(self):
        self.assertEqual(A.echanger_code('i', None, 'code', 'v', 'http://127.0.0.1:1', lambda *a, **k: (200, {'access_token': 'a', 'refresh_token': 'r'})), 'r')
        with self.assertRaises(A.ErreurGmail):
            A.echanger_code('i', None, 'code', 'v', 'http://127.0.0.1:1', lambda *a, **k: (200, {'access_token': 'a'}))

    def test_le_message_d_erreur_ne_contient_jamais_le_jeton(self):
        with tempfile.TemporaryDirectory() as d:
            cp, jp = self.prep(d)
            with self.assertRaises(A.ErreurGmail) as c:
                A.jeton_d_acces(cp, jp, lambda *a, **k: (400, {'error': 'invalid_grant', 'error_description': 'ancien'}), DEPROTEGER, PROTEGER)
            self.assertNotIn('ancien', str(c.exception))


if __name__ == '__main__':
    unittest.main()
