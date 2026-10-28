#!/usr/bin/env python3
# Tests de etapes.py : python -X utf8 -m unittest test_etapes.py (depuis outils/gantt-pc). Données FICTIVES (dépôts, numéros et commits inventés).
import unittest
import etapes as E


def ev(nom, quand): return {'event': nom, 'created_at': quand}
def dep(id_, sha, quand, env='Production'): return {'id': id_, 'sha': sha + '0000000', 'environment': env, 'created_at': quand}
def st(etat, quand): return {'state': etat, 'created_at': quand}


class Pret(unittest.TestCase):
    def test_dernier_ready_avant_la_fusion(self):
        e = [ev('labeled', '2000-01-01T09:00:00Z'), ev('ready_for_review', '2000-01-01T10:00:00Z'), ev('converted_to_draft', '2000-01-01T11:00:00Z'),
             ev('ready_for_review', '2000-01-01T12:00:00Z'), ev('merged', '2000-01-01T13:00:00Z')]
        self.assertEqual(E.pret_de(e, '2000-01-01T13:00:00Z'), '2000-01-01T12:00:00Z')

    def test_jamais_brouillon_rend_none(self):
        self.assertIsNone(E.pret_de([ev('labeled', '2000-01-01T09:00:00Z'), ev('merged', '2000-01-01T13:00:00Z')], '2000-01-01T13:00:00Z'))
        self.assertIsNone(E.pret_de([], '2000-01-01T13:00:00Z'))

    def test_un_ready_apres_la_fusion_ne_compte_pas(self):
        self.assertIsNone(E.pret_de([ev('ready_for_review', '2000-01-02T00:00:00Z')], '2000-01-01T13:00:00Z'))


class Deploiement(unittest.TestCase):
    def test_succes_le_plus_ancien_et_termine(self):
        self.assertEqual(E.etat_deploiement([st('success', '2000-01-01T10:05:00Z'), st('success', '2000-01-01T10:01:00Z'), st('pending', '2000-01-01T10:00:00Z')]),
                         ('2000-01-01T10:01:00Z', True))

    def test_echec_est_termine_sans_heure_en_ligne(self):
        self.assertEqual(E.etat_deploiement([st('failure', 't')]), (None, True))

    def test_en_cours_n_est_pas_termine(self):
        self.assertEqual(E.etat_deploiement([st('in_progress', 't')]), (None, False))
        self.assertEqual(E.etat_deploiement([]), (None, False))


class Association(unittest.TestCase):
    def test_commit_de_fusion_retrouve_son_deploiement(self):
        d = {'a': {'1': {'sha': 'abc1234', 'env': 'Production', 'cree_le': 'c', 'pret_le': '2000-01-01T10:20:00Z'}}}
        self.assertEqual(E.associer([{'r': 'a', 'n': 5, 'ms': 'abc1234'}], d), {'a#5': d['a']['1']})

    def test_sans_deploiement_ou_sans_ms_pas_d_entree(self):
        d = {'a': {'1': {'sha': 'abc1234', 'env': 'P', 'cree_le': 'c', 'pret_le': None}}}
        self.assertEqual(E.associer([{'r': 'a', 'n': 5, 'ms': 'abc1234'}, {'r': 'a', 'n': 6, 'ms': 'zzz9999'}, {'r': 'a', 'n': 7}], d), {})

    def test_redeploiement_le_premier_en_ligne_gagne(self):
        d = {'a': {'1': {'sha': 'abc1234', 'env': 'P', 'cree_le': 'c1', 'pret_le': '2000-01-02T00:00:00Z'},
                   '2': {'sha': 'abc1234', 'env': 'P', 'cree_le': 'c2', 'pret_le': '2000-01-01T10:00:00Z'}}}
        self.assertEqual(E.associer([{'r': 'a', 'n': 5, 'ms': 'abc1234'}], d)['a#5']['pret_le'], '2000-01-01T10:00:00Z')

    def test_meme_commit_dans_un_autre_depot_ne_se_confond_pas(self):
        d = {'b': {'1': {'sha': 'abc1234', 'env': 'P', 'cree_le': 'c', 'pret_le': 't'}}}
        self.assertEqual(E.associer([{'r': 'a', 'n': 5, 'ms': 'abc1234'}], d), {})


class Releve(unittest.TestCase):
    DEPOTS = {'a': 'Depot-A', 'b': 'Depot-B'}

    def faux(self, evenements=None, deploiements=None, statuts=None, erreur=None):
        self.chemins = []
        def lire(chemin):
            self.chemins.append(chemin)
            if erreur and erreur in chemin: raise RuntimeError('HTTP 500 en panne')
            if '/events?' in chemin: return (evenements or {}).get(chemin.split('/issues/')[1].split('/')[0], []) if chemin.endswith('page=1') else []
            if '/deployments?' in chemin: return (deploiements or {}).get(chemin.split('/MoKarade/')[1].split('/')[0], []) if chemin.endswith('page=1') else []
            if '/statuses' in chemin: return (statuts or {}).get(chemin.split('/deployments/')[1].split('/')[0], [])
            raise AssertionError(chemin)
        return lire

    def test_une_pr_prete_et_en_ligne(self):
        lire = self.faux(evenements={'5': [ev('ready_for_review', '2000-01-01T10:00:00Z')]}, deploiements={'Depot-A': [dep(9, 'abc1234', '2000-01-01T10:20:00Z')]},
                         statuts={'9': [st('success', '2000-01-01T10:20:01Z')]})
        r = E.releve([{'r': 'a', 'n': 5, 'm': '2000-01-01T10:10:00Z', 'ms': 'abc1234'}], self.DEPOTS, {}, lire, 'T')
        self.assertEqual(r['prets'], {'a#5': '2000-01-01T10:00:00Z'})
        self.assertEqual(r['en_ligne']['a#5']['pret_le'], '2000-01-01T10:20:01Z')
        self.assertEqual((r['restant'], r['erreurs'], r['couvert_depuis']), (0, [], {'a': '2000-01-01T10:20:00Z'}))

    def test_en_parallele_meme_resultat_que_en_serie(self):
        prs = [{'r': 'a', 'n': i, 'm': f'2000-01-{i:02d}T10:10:00Z', 'ms': f'abc123{i}'} for i in range(1, 9)]
        evenements = {str(i): [ev('ready_for_review', f'2000-01-{i:02d}T10:00:00Z')] for i in range(1, 9)}
        deploiements = {'Depot-A': [dep(i, f'abc123{i}', f'2000-01-{i:02d}T10:20:00Z') for i in range(1, 9)]}
        statuts = {str(i): [st('success', f'2000-01-{i:02d}T10:20:01Z')] for i in range(1, 9)}
        serie = E.releve(prs, self.DEPOTS, {}, self.faux(evenements, deploiements, statuts), 'T', paralleles=1)
        para = E.releve(prs, self.DEPOTS, {}, self.faux(evenements, deploiements, statuts), 'T', paralleles=5)
        self.assertEqual(serie, para)
        self.assertEqual((len(para['prets']), len(para['en_ligne'])), (8, 8))

    def test_resultats_memorises_aucune_relecture(self):
        cache = {}
        pr = [{'r': 'a', 'n': 5, 'm': '2000-01-01T10:10:00Z', 'ms': 'abc1234'}]
        lire = self.faux(evenements={'5': [ev('ready_for_review', '2000-01-01T10:00:00Z')]}, deploiements={'Depot-A': [dep(9, 'abc1234', '2000-01-01T10:20:00Z')]},
                         statuts={'9': [st('success', '2000-01-01T10:20:01Z')]})
        E.releve(pr, self.DEPOTS, cache, lire, 'T')
        lire2 = self.faux(deploiements={'Depot-A': [dep(9, 'abc1234', '2000-01-01T10:20:00Z')]})
        r = E.releve(pr, self.DEPOTS, cache, lire2, 'T2')
        self.assertFalse([c for c in self.chemins if '/events' in c or '/statuses' in c])     # seule la liste des déploiements est relue (lecture à ETag)
        self.assertEqual((r['prets'], r['en_ligne']['a#5']['sha']), ({'a#5': '2000-01-01T10:00:00Z'}, 'abc1234'))

    def test_deploiement_en_cours_se_relit(self):
        cache = {}
        pr = [{'r': 'a', 'n': 5, 'm': '2000-01-01T10:10:00Z', 'ms': 'abc1234'}]
        E.releve(pr, self.DEPOTS, cache, self.faux(deploiements={'Depot-A': [dep(9, 'abc1234', 'c')]}, statuts={'9': [st('in_progress', 'p')]}), 'T')
        r = E.releve(pr, self.DEPOTS, cache, self.faux(deploiements={'Depot-A': [dep(9, 'abc1234', 'c')]}, statuts={'9': [st('success', '2000-01-01T10:21:00Z')]}), 'T2')
        self.assertEqual(r['en_ligne']['a#5']['pret_le'], '2000-01-01T10:21:00Z')

    def test_deploiement_d_un_autre_commit_n_est_pas_lu(self):
        lire = self.faux(deploiements={'Depot-A': [dep(9, 'fff0000', 'c')]})
        r = E.releve([{'r': 'a', 'n': 5, 'm': '2000-01-01T10:10:00Z', 'ms': 'abc1234'}], self.DEPOTS, {}, lire, 'T')
        self.assertFalse([c for c in self.chemins if '/statuses' in c])
        self.assertEqual(r['en_ligne'], {})

    def test_plafond_lit_les_fusions_les_plus_recentes_d_abord(self):
        n = {'v': 0}
        def compter(): n['v'] += 1; return n['v']
        prs = [{'r': 'b', 'n': i, 'm': f'2000-01-0{i}T00:00:00Z'} for i in (1, 2, 3, 4)]
        r = E.releve(prs, self.DEPOTS, {}, self.faux(), 'T', compter, plafond=4)     # 4 lectures comptées au plus, une PR coûte 2 appels du compteur ici
        self.assertTrue(r['restant'] > 0)
        self.assertIn('b#4', r['prets'])
        self.assertNotIn('b#1', r['prets'])           # absente = pas encore lue, jamais « sans événement »

    def test_lecture_en_panne_n_ecrit_rien_et_se_dit(self):
        r = E.releve([{'r': 'a', 'n': 5, 'm': '2000-01-01T10:10:00Z', 'ms': 'abc1234'}], self.DEPOTS, {}, self.faux(erreur='/events'), 'T')
        self.assertEqual((r['prets'], r['restant']), ({}, 1))
        self.assertIn('HTTP 500', r['erreurs'][0])
        r = E.releve([{'r': 'a', 'n': 5, 'm': '2000-01-01T10:10:00Z', 'ms': 'abc1234'}], self.DEPOTS, {}, self.faux(erreur='/deployments?'), 'T')
        self.assertIn('déploiements', r['erreurs'][0])

    def test_pr_sortie_de_prlog_est_oubliee_du_cache(self):
        cache = {'prets': {'a#1': 'x'}, 'dep': {}}
        r = E.releve([{'r': 'a', 'n': 5, 'm': '2000-01-01T10:10:00Z'}], self.DEPOTS, cache, self.faux(), 'T')
        self.assertNotIn('a#1', cache['prets'])
        self.assertEqual(list(r['prets']), ['a#5'])

    def test_pr_d_un_depot_inconnu_ou_non_fusionnee_est_ignoree(self):
        r = E.releve([{'r': 'zzz', 'n': 1, 'm': 't'}, {'r': 'a', 'n': 2, 'm': None}], self.DEPOTS, {}, self.faux(), 'T')
        self.assertEqual((r['prets'], r['restant']), ({}, 0))


class Pages(unittest.TestCase):
    def test_s_arrete_sous_la_plus_ancienne_fusion(self):
        appels = []
        def lire(chemin):
            appels.append(chemin)
            return [{'created_at': f'2000-01-{31 - i // 4:02d}T00:00:00Z'} for i in range(100)]      # page 1 : du 31 au 7 janvier
        E._pages(lire, 'x?per_page=100', 5, '2000-01-20T00:00:00Z')
        self.assertEqual(len(appels), 1)
        appels.clear()
        E._pages(lire, 'x?per_page=100', 5, '1999-01-01T00:00:00Z')
        self.assertEqual(len(appels), 5)         # jamais plus que le maximum


class Fenetre(unittest.TestCase):
    def test_seules_les_fusions_recentes_comptent(self):
        prlog = [{'r': 'a', 'n': 1, 'm': '2000-03-01T00:00:00Z'}, {'r': 'a', 'n': 2, 'm': '2000-01-01T00:00:00Z'}, {'r': 'a', 'n': 3, 'm': None}]
        self.assertEqual([x['n'] for x in E.recentes(prlog, '2000-03-10T00:00:00Z')], [1])
        self.assertEqual([x['n'] for x in E.recentes(prlog, '2000-03-10T00:00:00Z', jours=100)], [1, 2])


class Plafond(unittest.TestCase):
    def test_defaut_option_et_refus(self):
        self.assertEqual(E.plafond_de({}), E.PLAFOND_APPELS)
        self.assertEqual(E.plafond_de({'plafond': '20'}), 20)
        for mauvais in ('0', '-5', 'abc'):
            with self.assertRaises(ValueError): E.plafond_de({'plafond': mauvais})


if __name__ == '__main__':
    unittest.main()
