#!/usr/bin/env python3
# Tests des décisions pures de reponses.py : python -X utf8 -m unittest test_reponses.py (depuis outils/gantt-pc)
import datetime, json, os, tempfile, unittest
from unittest import mock
import reponses as R

T = datetime.datetime(2026, 10, 19, 15, 0, tzinfo=datetime.timezone.utc)
CORPS = """**Avant** : x

**Réponses** :
- Garder le texte des annonces
- Ne garder que le titre
2. Décider plus tard

**Fini quand** : y"""


def issue(labels=('qui:marc',), state='open', body=CORPS):
    return {'state': state, 'labels': [{'name': l} for l in labels], 'body': body}


def dem(**k):
    d = {'id': 'abc123', 'ref': 'jobai#109', 'geste': 'fait'}; d.update(k)
    r, err = R.lire_demande(json.dumps(d)); assert r, err
    return r


class Options(unittest.TestCase):
    def test_puces_sous_reponses(self):
        self.assertEqual(R.options(CORPS), ['Garder le texte des annonces', 'Ne garder que le titre', 'Décider plus tard'])

    def test_sans_section(self):
        self.assertEqual(R.options('**Avant** : x'), [])


class Demande(unittest.TestCase):
    def test_refuse_depot_inconnu(self):
        self.assertIsNone(R.lire_demande(json.dumps({'id': 'abc123', 'ref': 'autre#1', 'geste': 'fait'}))[0])

    def test_refuse_geste_inconnu(self):
        self.assertIsNone(R.lire_demande(json.dumps({'id': 'abc123', 'ref': 'jobai#1', 'geste': 'fermer'}))[0])

    def test_refuse_reponse_vide(self):
        self.assertIsNone(R.lire_demande(json.dumps({'id': 'abc123', 'ref': 'jobai#1', 'geste': 'reponse'}))[0])

    def test_refuse_illisible(self):
        self.assertEqual(R.lire_demande('{')[1], 'fichier illisible')


class Plan(unittest.TestCase):
    def test_fait_commente_et_retire(self):
        a, err = R.plan(dem(), issue(), T)
        self.assertIsNone(err)
        self.assertEqual([x[0] for x in a], ['commentaire', 'retirer'])
        self.assertTrue(a[0][1].startswith('**Fait** — Marc, depuis la page de suivi (19/10 11:00'))
        self.assertEqual(a[1][1], 'qui:marc')

    def test_fait_refuse_sans_qui_marc(self):
        self.assertEqual(R.plan(dem(), issue(labels=()), T)[1], "la tâche n'attend plus Marc")

    def test_fait_refuse_fermee(self):
        self.assertEqual(R.plan(dem(), issue(state='closed'), T)[1], 'tâche déjà fermée')

    def test_garde_fou_refuse_fait(self):
        g = dict(issue(), title='Garde-fou : la PR #242 attend un geste de Marc')
        self.assertIn('fusion', R.plan(dem(), g, T)[1])

    def test_reponse_doit_etre_une_option(self):
        self.assertIsNotNone(R.plan(dem(geste='reponse', texte='Tout supprimer'), issue(), T)[1])
        a, err = R.plan(dem(geste='reponse', texte='Ne garder que le titre'), issue(), T)
        self.assertIsNone(err)
        self.assertIn('**Réponse de Marc** : Ne garder que le titre', a[0][1])

    def test_fusion(self):
        pr = {'state': 'open', 'draft': False, 'head': {}}
        self.assertEqual(R.plan(dem(geste='fusionner', ref='hubperso#242'), pr, T), ([('fusion', None)], None))
        self.assertEqual(R.plan(dem(geste='fusionner'), dict(pr, draft=True), T)[1], 'PR en brouillon')
        self.assertEqual(R.plan(dem(geste='fusionner'), dict(pr, state='closed'), T)[1], 'PR déjà fermée')
        self.assertEqual(R.plan(dem(geste='fusionner'), issue(), T)[1], "ce n'est pas une PR")

    def test_motif_sans_texte_de_reponse(self):
        self.assertEqual(R.motif([('jobai#109', 'reponse'), ('hubperso#242', 'fusionner')]),
                         'RÉACTEUR : Marc depuis la page : répondu jobai#109 ; fusionné hubperso#242')


SECRET = 'a' * 24      # valeur fictive, volontairement sans entropie (gitleaks)


def geste(**k):
    d = {'v': 1, 'id': 'hub-0001', 'ref': 'jobai#109', 'geste': 'fait', 'quand': '2026-10-27T05:00:00Z'}; d.update(k)
    return d


class Hub(unittest.TestCase):
    """Le chemin hub de tour() : lecture, application par le même code que Drive, accusé. Aucun réseau, aucun gh."""
    def setUp(self):
        self._d = tempfile.TemporaryDirectory(); self.d = self._d.name
        self.secret = os.path.join(self.d, 'secret.txt')
        with open(self.secret, 'w', encoding='utf-8') as f: f.write(SECRET)
        self.journal = os.path.join(self.d, 'journal.json')
        for p in (mock.patch.object(R, 'JOURNAL', self.journal), mock.patch.object(R, 'gh', return_value='')):
            p.start(); self.addCleanup(p.stop)
        self.appels = []

    def tearDown(self): self._d.cleanup()

    def requete(self, gestes=None, code=200, code_accuse=200):
        def f(methode, url, secret, octets=None):
            self.appels.append((methode, url, secret, octets))
            if methode == 'GET': return code, json.dumps({'ok': True, 'gestes': gestes or []})
            return code_accuse, '{"ok":true}'
        return f

    def accuses(self):
        posts = [a for a in self.appels if a[0] == 'POST']
        return [json.loads(a[3]) for a in posts]

    def test_demande_du_hub_appliquee_puis_accusee(self):
        with mock.patch.object(R, 'appliquer', return_value=(True, 'appliqué')) as ap:
            ligne = R.tour(self.d, chemin_secret=self.secret, requete=self.requete([geste()]))
        self.assertEqual(ap.call_count, 1)
        self.assertIn('1 appliquée(s), 0 refusée(s)', ligne)
        self.assertNotIn('hub :', ligne)
        self.assertEqual(self.accuses(), [{'ids': ['hub-0001']}])
        self.assertEqual([a[:3] for a in self.appels], [('GET', R.URL_HUB, SECRET), ('POST', R.URL_ACCUSE, SECRET)])

    def test_refus_accuse_avec_son_message(self):
        with mock.patch.object(R, 'appliquer', return_value=(False, 'tâche déjà fermée')):
            ligne = R.tour(self.d, chemin_secret=self.secret, requete=self.requete([geste()]))
        self.assertIn('0 appliquée(s), 1 refusée(s)', ligne)
        self.assertEqual(self.accuses(), [{'ids': ['hub-0001']}])      # refusé = pris aussi : le hub ne garde que « pris »

    def test_demande_hors_contrat_refusee_et_accusee_sans_toucher_github(self):
        with mock.patch.object(R, 'appliquer') as ap:
            R.tour(self.d, chemin_secret=self.secret, requete=self.requete([geste(ref='autre#1')]))
        ap.assert_not_called()
        self.assertEqual(self.accuses(), [{'ids': ['hub-0001']}])
        with open(self.journal, encoding='utf-8') as f: e = json.load(f)[0]
        self.assertEqual((e['id'], e['ok']), ('hub-0001', False))
        self.assertTrue(e['msg'].startswith('référence inconnue'))

    def test_id_deja_journalise_jamais_rejoue_mais_reaccuse(self):
        with open(self.journal, 'w', encoding='utf-8') as f: json.dump([{'id': 'hub-0001', 'ok': True, 'msg': 'appliqué'}], f)
        with mock.patch.object(R, 'appliquer') as ap:
            R.tour(self.d, chemin_secret=self.secret, requete=self.requete([geste()]))
        ap.assert_not_called()
        self.assertEqual(self.accuses(), [{'ids': ['hub-0001']}])

    def test_secret_absent_dit_et_drive_continue(self):
        with open(os.path.join(self.d, 'reponse-1.json'), 'w', encoding='utf-8') as f: json.dump(geste(id='drive-0001'), f)
        with mock.patch.object(R, 'appliquer', return_value=(True, 'appliqué')) as ap:
            ligne = R.tour(self.d, chemin_secret=os.path.join(self.d, 'absent.txt'), requete=self.requete())
        self.assertEqual(ap.call_count, 1)
        self.assertIn('1 appliquée(s)', ligne)
        self.assertIn('hub : secret absent', ligne)
        self.assertEqual(self.appels, [])
        self.assertFalse(os.path.exists(os.path.join(self.d, 'reponse-1.json')))

    def test_pannes_du_hub_se_disent_sans_rien_lever(self):
        for code, mot in ((401, 'secret refusé'), (503, 'pas encore actif'), (500, 'réponse inattendue')):
            self.appels.clear()
            ligne = R.tour(self.d, chemin_secret=self.secret, requete=self.requete(code=code))
            self.assertIn(f'hub : {mot}', ligne); self.assertIn(f'HTTP {code}', ligne)

    def test_reseau_coupe(self):
        def coupe(*a, **k): raise OSError('réseau')
        ligne = R.tour(self.d, chemin_secret=self.secret, requete=coupe)
        self.assertIn('hub : envoi impossible (OSError)', ligne)

    def test_accuse_en_echec_se_dit(self):
        with mock.patch.object(R, 'appliquer', return_value=(True, 'appliqué')):
            ligne = R.tour(self.d, chemin_secret=self.secret, requete=self.requete([geste()], code_accuse=401))
        self.assertIn('hub : accusé refusé', ligne); self.assertIn('1 appliquée(s)', ligne)

    def test_reponse_du_hub_malformee(self):
        def bizarre(methode, url, secret, octets=None): return 200, '{"ok":true,"gestes":"oups"}'
        self.assertEqual(R.lire_hub(SECRET, bizarre), ([], 'réponse sans liste de gestes'))
        self.assertEqual(R.lire_hub(SECRET, lambda *a, **k: (200, 'pas du json')), ([], 'réponse illisible'))

    def test_vingt_demandes_au_plus_par_tour(self):
        textes, _ = R.lire_hub(SECRET, self.requete([geste(id=f'hub-{i:04d}') for i in range(30)]))
        self.assertEqual(len(textes), R.PAR_TOUR)

    def test_corps_accuse_garde_les_ids_valides_sans_doublon_et_50_au_plus(self):
        self.assertEqual(R.corps_accuse(['hub-0001', 'hub-0001', '', 'court', None, 'hub-0002']), {'ids': ['hub-0001', 'hub-0002']})
        self.assertEqual(len(R.corps_accuse([f'hub-{i:04d}' for i in range(80)])['ids']), 50)
        self.assertIsNone(R.corps_accuse(['court']))

    def test_a_blanc_n_accuse_rien(self):
        with mock.patch.object(R, 'appliquer') as ap:
            R.tour(self.d, a_blanc=True, chemin_secret=self.secret, requete=self.requete([geste()]))
        ap.assert_not_called(); self.assertEqual(self.accuses(), [])


if __name__ == '__main__':
    unittest.main()
