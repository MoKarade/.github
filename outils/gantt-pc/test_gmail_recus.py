#!/usr/bin/env python3
# Tests de gmail_recus.py : python -X utf8 -m unittest test_gmail_recus.py (depuis outils/gantt-pc).
# Courriels, montants, identifiants et jetons FICTIFS (valeurs rondes) : aucune donnée réelle, aucun appel réseau, pas de DPAPI (chiffrement simulé).
import base64
import json
import os
import tempfile
import unittest
import urllib.parse

import gmail_auth as A
import gmail_recus as R

PROTEGER = lambda b: b'ENC:' + base64.b64encode(b[::-1])
DEPROTEGER = lambda b: base64.b64decode(b[4:])[::-1]
MAINTENANT = '2000-01-15T12:00:00Z'


def lire_json(p):
    with open(p, encoding='utf-8') as f:
        return json.load(f)


def message(i='m1', de='Anthropic <x@example.invalid>', objet='Receipt from Anthropic', extrait='Total $10.00 paid', ms=947_937_600_000):
    return {'id': i, 'snippet': extrait, 'internalDate': str(ms), 'payload': {'headers': [{'name': 'From', 'value': de}, {'name': 'Subject', 'value': objet}]}}


class Montants(unittest.TestCase):
    def test_formats_courants(self):
        self.assertEqual(R.montants('Total $10.00'), {(10.0, None)})
        self.assertEqual(R.montants('Total 10,50 $'), {(10.5, None)})
        self.assertEqual(R.montants('US$20.00 paid'), {(20.0, 'USD')})
        self.assertEqual(R.montants('CA$16.09'), {(16.09, 'CAD')})
        self.assertEqual(R.montants('1 234,50 $ CAD'), {(1234.5, 'CAD')})
        self.assertEqual(R.montants('1,234.50 USD'), {(1234.5, 'USD')})

    def test_sans_marqueur_de_devise_rien_n_est_pris(self):
        self.assertEqual(R.montants('Commande 2000.01 du 10.10 numéro 123.45'), set())

    def test_zero_et_texte_vide(self):
        self.assertEqual(R.montants('$0.00'), set())
        self.assertEqual(R.montants(''), set())
        self.assertEqual(R.montants(None), set())


class Recus(unittest.TestCase):
    def test_recu_simple_devise_ambigue_a_verifier(self):
        r = R.en_recu(message())
        self.assertEqual((r['fournisseur'], r['montant'], r['devise'], r['date']), ('Anthropic', 10.0, None, '2000-01-15'))
        self.assertTrue(r['a_verifier'], 'un « $ » seul ne dit pas la devise')

    def test_devise_explicite_n_est_pas_a_verifier(self):
        r = R.en_recu(message(extrait='Total US$10.00'))
        self.assertEqual((r['montant'], r['devise'], r['a_verifier']), (10.0, 'USD', False))

    def test_deux_montants_differents_aucun_choisi(self):
        r = R.en_recu(message(extrait='Prix US$10.00 puis US$11.50'))
        self.assertIsNone(r['montant'])
        self.assertTrue(r['a_verifier'])

    def test_le_libelle_total_designe_le_montant_paye(self):
        r = R.en_recu(message(extrait='Sous-total US$10.00, total US$11.50'))
        self.assertEqual((r['montant'], r['devise'], r['a_verifier']), (11.5, 'USD', False))

    def test_deux_fois_le_meme_montant_compte_pour_un(self):
        self.assertEqual(R.en_recu(message(extrait='US$10.00 payé, solde US$10.00'))['montant'], 10.0)

    def test_pas_de_montant_lisible_a_verifier(self):
        r = R.en_recu(message(extrait='Voir la facture en ligne'))
        self.assertIsNone(r['montant'])
        self.assertTrue(r['a_verifier'])

    def test_courriel_qui_n_est_pas_un_recu_est_ignore(self):
        self.assertIsNone(R.en_recu(message(objet='Nouveautés de la semaine')))
        self.assertIsNone(R.en_recu(message(de='Inconnu <x@example.invalid>', objet='Receipt #1')))

    def test_rien_de_personnel_n_est_garde(self):
        r = R.en_recu(message(de='Anthropic <secret@example.invalid>', objet='Receipt from Anthropic for jean@example.invalid', extrait='Pour jean@example.invalid $10.00'))
        self.assertEqual(set(r), {'id', 'date', 'instant', 'fournisseur', 'type', 'montant', 'devise', 'devise_probable', 'a_verifier'})
        self.assertNotIn('example.invalid', json.dumps(r))

    def test_message_mal_forme_ne_leve_pas(self):
        for m in (None, {}, {'id': 3}, {'id': 'x', 'payload': 'a'}, {'id': 'x', 'payload': {'headers': ['a']}}):
            self.assertIsNone(R.en_recu(m))


def avec_corps(texte, de, objet, mime='text/plain'):
    m = message(de=de, objet=objet, extrait='')
    m['payload']['mimeType'] = 'multipart/mixed'
    m['payload']['parts'] = [{'mimeType': mime, 'body': {'data': base64.urlsafe_b64encode(texte.encode()).decode().rstrip('=')}}, {'mimeType': 'application/pdf', 'body': {'attachmentId': 'x'}}]
    return m


class FormatsDesFournisseurs(unittest.TestCase):
    def lire(self, texte, de, objet, **k):
        return R.en_recu(avec_corps(texte, de, objet, **k))

    def test_stripe_anthropic_devise_explicite(self):
        r = self.lire('Receipt from Anthropic, PBC CA$100.00 Paid May 1, 2000 Total excluding tax CA$80.00 GST CA$4.00 Total CA$100.00 Amount paid CA$100.00', 'invoice@mail.anthropic.com', 'Your receipt from Anthropic, PBC #1')
        self.assertEqual((r['fournisseur'], r['type'], r['montant'], r['devise'], r['a_verifier']), ('Anthropic', 'recu', 100.0, 'CAD', False))

    def test_stripe_vercel_dollar_seul_devise_probable_a_verifier(self):
        r = self.lire('Receipt from Vercel Inc. $50.00 Paid on May 1, 2000 Pro Qty 1 $20.00 Subtotal $40.00 Total $50.00 Amount paid $50.00', 'invoice@vercel.com', 'Your receipt from Vercel Inc. #1')
        self.assertEqual((r['montant'], r['devise'], r['devise_probable'], r['a_verifier']), (50.0, None, 'USD', True))

    def test_github_code_de_devise_apres_le_nombre(self):
        r = self.lire('GITHUB RECEIPT\nGitHub Pro - month: $4.00 USD\n\nTotal: $4.00 USD*\n', 'noreply@github.com', '[GitHub] Payment Receipt for X')
        self.assertEqual((r['fournisseur'], r['montant'], r['devise'], r['a_verifier']), ('GitHub', 4.0, 'USD', False))

    def test_google_cloud_virgule_decimale_et_dollar_ca(self):
        r = self.lire('Paiement reçu\n\nVotre paiement de 0,57 $CA (référence CLOUD X sur Mastercard) a été appliqué', 'payments-noreply@google.com', 'Google Cloud Platform & APIs : Paiement reçu')
        self.assertEqual((r['fournisseur'], r['montant'], r['devise'], r['a_verifier']), ('Google Cloud', 0.57, 'CAD', False))

    def test_google_play_total_et_non_le_budget_ni_l_abonnement(self):
        fr = self.lire("débité du coût de l'abonnement de (actuellement\n$3.99/mois)\n\nTaxe: $1.00\n\nTotal: $0.00\n\nTotal des dépenses en octobre : vous avez dépensé $12.00 de\nvotre budget de $25.00.", 'googleplay-noreply@google.com', 'Reçu de votre commande Google Play passée le 18 oct. 2000')
        en = self.lire("Item Price\n\nPrime $8.00/month\n\nTax: $1.20\n\nTotal: $9.20/month\n\nTotal spent in October: you've spent $30.00 of your\n$25.00 budget.", 'googleplay-noreply@google.com', 'Your Google Play Order Receipt from Oct 26, 2000')
        self.assertEqual((fr['montant'], en['montant']), (0.0, 9.2))
        self.assertEqual((en['devise'], en['devise_probable'], en['a_verifier']), (None, 'CAD', True))

    def test_remboursement_garde_son_type_et_son_montant(self):
        r = self.lire('Refund from Vercel Inc. $0.02 Refunded on May 1, 2000 Receipt #1 Total $7.50 Amount paid $7.50', 'invoice@vercel.com', 'Your refund from Vercel Inc. #1')
        self.assertEqual((r['type'], r['montant']), ('remboursement', 0.02))

    def test_correction_de_factures_n_est_pas_une_depense(self):
        self.assertIsNone(self.lire('Correction ... Total $1.00', 'no-reply@vercel.com', 'Correction to your Vercel invoices for March–September 2000'))

    def test_html_seul_est_lu_sans_balises_ni_scripts(self):
        r = self.lire('<style>.a{}</style><p>Total&nbsp;: <b>$4.00 USD</b></p><script>var Total = 9.99;</script>', 'noreply@github.com', '[GitHub] Payment Receipt', mime='text/html')
        self.assertEqual((r['montant'], r['devise']), (4.0, 'USD'))

    def test_l_instant_est_en_utc_iso(self):
        self.assertEqual(R.en_recu(message())['instant'], '2000-01-15T12:00:00Z')


class Cadence(unittest.TestCase):
    def test_premiere_fois_sept_jours_et_reessai(self):
        self.assertTrue(R.a_lire(None, MAINTENANT))
        self.assertFalse(R.a_lire({'lu_le': '2000-01-10T12:00:00Z', 'recus': []}, MAINTENANT))
        self.assertTrue(R.a_lire({'lu_le': '2000-01-08T11:00:00Z', 'recus': []}, MAINTENANT))
        self.assertFalse(R.a_lire({'lu_le': '2000-01-01T00:00:00Z', 'erreur': 'reseau', 'tentative': '2000-01-15T09:00:00Z', 'recus': []}, MAINTENANT))
        self.assertTrue(R.a_lire({'lu_le': '2000-01-01T00:00:00Z', 'erreur': 'reseau', 'tentative': '2000-01-15T05:00:00Z', 'recus': []}, MAINTENANT))

    def test_fusion_dedoublonne_trie_et_compte_les_neufs(self):
        anciens = [{'id': 'a', 'date': '2000-01-01'}, {'id': 'b', 'date': '2000-01-05'}]
        liste, neufs = R.fusionner(anciens, [{'id': 'b', 'date': '2000-01-05', 'montant': 1.0}, {'id': 'c', 'date': '2000-01-09'}])
        self.assertEqual([r['id'] for r in liste], ['c', 'b', 'a'])
        self.assertEqual(neufs, 1)
        self.assertEqual(liste[1]['montant'], 1.0)


class Passer(unittest.TestCase):
    def installer(self, d):
        cp, jp, rp = (os.path.join(d, n) for n in ('c.json', 'j.bin', 'r.json'))
        with open(cp, 'w') as f:
            json.dump({'installed': {'client_id': 'id-fictif'}}, f)
        A.sauver_jeton('ref', jp, PROTEGER)
        return cp, jp, rp

    def faux_gmail(self, messages, appels=None):
        def requete(methode, url, donnees=None, entetes=None):
            if appels is not None:
                appels.append((methode, url, entetes))
            if url.startswith(A.URL_JETON):
                return 200, {'access_token': 'acces-fictif'}
            chemin = urllib.parse.urlsplit(url).path
            if chemin.endswith('/messages'):
                return 200, {'messages': [{'id': m['id']} for m in messages]}
            return 200, next(m for m in messages if chemin.endswith('/' + m['id']))
        return requete

    def passer(self, d, requete, maintenant=MAINTENANT):
        cp, jp, rp = self.installer(d) if not os.path.exists(os.path.join(d, 'c.json')) else (os.path.join(d, 'c.json'), os.path.join(d, 'j.bin'), os.path.join(d, 'r.json'))
        return R.passer(maintenant, rp, cp, jp, requete, DEPROTEGER, PROTEGER), rp

    def test_lecture_reussie_ecrit_le_fichier_prive_et_dit_une_phrase(self):
        with tempfile.TemporaryDirectory() as d:
            appels = []
            phrase, rp = self.passer(d, self.faux_gmail([message('m1'), message('m2', objet='Bonjour')], appels))
            self.assertEqual(phrase, 'Gmail : 1 reçu(s) lu(s), 1 nouveau(x)')
            etat = lire_json(rp)
            self.assertEqual((etat['lu_le'], etat['erreur'], [r['id'] for r in etat['recus']]), (MAINTENANT, None, ['m1']))
            gets = [a for a in appels if 'gmail.googleapis.com' in a[1]]
            self.assertTrue(all(a[0] == 'GET' and a[2]['Authorization'] == 'Bearer acces-fictif' for a in gets))
            self.assertTrue(all('format=full' in a[1] for a in gets if '/messages/' in a[1]))
            self.assertFalse([a for a in gets if '/attachments/' in a[1]], 'les pièces jointes ne sont jamais lues')

    def test_pas_encore_du_moment_aucun_appel(self):
        with tempfile.TemporaryDirectory() as d:
            self.passer(d, self.faux_gmail([message()]))
            appels = []
            phrase, _ = self.passer(d, self.faux_gmail([message()], appels), '2000-01-16T12:00:00Z')
            self.assertEqual((phrase, appels), ('', []))

    def test_pas_encore_autorise_ne_dit_rien_et_n_ecrit_rien(self):
        with tempfile.TemporaryDirectory() as d:
            rp = os.path.join(d, 'r.json')
            self.assertEqual(R.passer(MAINTENANT, rp, os.path.join(d, 'absent.json'), os.path.join(d, 'absent.bin'), lambda *a, **k: (500, {})), '')
            self.assertFalse(os.path.exists(rp))

    def test_autorisation_expiree_se_dit_et_garde_les_recus(self):
        with tempfile.TemporaryDirectory() as d:
            self.passer(d, self.faux_gmail([message()]))

            def refuse(methode, url, donnees=None, entetes=None):
                return 400, {'error': 'invalid_grant'}
            phrase, rp = self.passer(d, refuse, '2000-01-30T12:00:00Z')
            self.assertEqual(phrase, 'Gmail : autorisation à refaire (geste de Marc)')
            etat = lire_json(rp)
            self.assertEqual((etat['erreur'], [r['id'] for r in etat['recus']], etat['lu_le']), ('reautoriser', ['m1'], MAINTENANT))

    def test_panne_reseau_garde_les_recus_et_reessaiera(self):
        with tempfile.TemporaryDirectory() as d:
            self.passer(d, self.faux_gmail([message()]))

            def panne(*a, **k):
                raise A.ErreurGmail('reseau', 'OSError')
            phrase, rp = self.passer(d, panne, '2000-01-30T12:00:00Z')
            self.assertEqual(phrase, 'Gmail : échec (reseau)')
            self.assertEqual([r['id'] for r in lire_json(rp)['recus']], ['m1'])

    def test_api_desactivee_donne_un_code_refuse(self):
        with tempfile.TemporaryDirectory() as d:
            def requete(methode, url, donnees=None, entetes=None):
                if url.startswith(A.URL_JETON):
                    return 200, {'access_token': 'a'}
                return 403, {'error': {'errors': [{'reason': 'accessNotConfigured'}]}}
            phrase, rp = self.passer(d, requete)
            self.assertEqual(phrase, 'Gmail : échec (refuse)')
            self.assertEqual(lire_json(rp)['erreur'], 'refuse')

    def test_une_exception_imprevue_ne_fait_pas_echouer_le_tour(self):
        with tempfile.TemporaryDirectory() as d:
            def bug(*a, **k):
                raise KeyError('x')
            phrase, _ = self.passer(d, bug)
            self.assertEqual(phrase, 'Gmail : ÉCHEC KeyError')


if __name__ == '__main__':
    unittest.main()
