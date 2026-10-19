#!/usr/bin/env python3
# Tests des décisions pures de reponses.py : python -X utf8 -m unittest test_reponses.py (depuis outils/gantt-pc)
import datetime, json, unittest
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


if __name__ == '__main__':
    unittest.main()
