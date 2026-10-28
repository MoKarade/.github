#!/usr/bin/env python3
# Tests de etapes.py : python -X utf8 -m unittest test_etapes.py (depuis outils/gantt-pc). Données FICTIVES (dépôts, numéros et commits inventés).
import re
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


class Requetes(unittest.TestCase):
    def test_requete_des_pr_porte_depot_numero_et_evenement(self):
        q = E.requete_prets([('p0', 'Depot-A', 5), ('p1', 'batchchef-', 7)])
        self.assertIn('p0: repository(owner: "MoKarade", name: "Depot-A") { pullRequest(number: 5)', q)
        self.assertIn('name: "batchchef-"', q)
        self.assertIn('READY_FOR_REVIEW_EVENT', q)
        self.assertEqual(q.count('{'), q.count('}'))

    def test_requete_des_deploiements_pagine_par_curseur(self):
        self.assertNotIn('after', E.requete_deploiements('Depot-A'))
        q = E.requete_deploiements('Depot-A', 'CUR"SEUR')
        self.assertIn('after: "CUR\\"SEUR"', q)          # une chaîne GraphQL est une chaîne JSON : jamais d'injection par un nom
        self.assertEqual(q.count('{'), q.count('}'))


class Releve(unittest.TestCase):
    DEPOTS = {'a': 'Depot-A', 'b': 'Depot-B'}

    def faux(self, prets=None, deploiements=None, erreur=None, depot_nul=None):
        """prets : {(dépôt, n): (mergedAt, [dates ready])} ; deploiements : {dépôt: [(id, sha, créé, [(état, date)])]} en une seule page."""
        self.requetes = []
        def graphql(q):
            self.requetes.append(q)
            if erreur and erreur in q: raise RuntimeError('HTTP 502 en panne')
            if 'deployments(' in q:
                depot = re.search(r'name: "([^"]+)"', q).group(1)
                if depot == depot_nul: return {'data': {'repository': None}}
                nodes = [{'databaseId': i, 'createdAt': c, 'environment': 'Production', 'commitOid': sha + '0000000', 'statuses': {'nodes': [{'state': e.upper(), 'createdAt': d} for e, d in sts]}}
                         for i, sha, c, sts in (deploiements or {}).get(depot, [])]
                return {'data': {'repository': {'deployments': {'nodes': nodes, 'pageInfo': {'hasNextPage': False, 'endCursor': None}}}}}
            data = {}
            for alias, depot, n in re.findall(r'(p\d+): repository\(owner: "MoKarade", name: "([^"]+)"\) \{ pullRequest\(number: (\d+)\)', q):
                if depot == depot_nul: data[alias] = None; continue
                pr = (prets or {}).get((depot, int(n)))
                data[alias] = {'pullRequest': None if pr is None else {'mergedAt': pr[0], 'timelineItems': {'nodes': [{'createdAt': d} for d in pr[1]]}}}
            return {'data': data}
        return graphql

    def test_une_pr_prete_et_en_ligne(self):
        g = self.faux(prets={('Depot-A', 5): ('2000-01-01T10:10:00Z', ['2000-01-01T10:00:00Z'])}, deploiements={'Depot-A': [(9, 'abc1234', '2000-01-01T10:20:00Z', [('success', '2000-01-01T10:20:01Z')])]})
        r = E.releve([{'r': 'a', 'n': 5, 'm': '2000-01-01T10:10:00Z', 'ms': 'abc1234'}], self.DEPOTS, {}, g, '2000-01-02T00:00:00Z')
        self.assertEqual(r['prets'], {'a#5': '2000-01-01T10:00:00Z'})
        self.assertEqual(r['en_ligne']['a#5']['pret_le'], '2000-01-01T10:20:01Z')
        self.assertEqual((r['restant'], r['absents'], r['erreurs'], r['couvert_depuis'], r['appels']), (0, 0, [], {'a': '2000-01-01T10:20:00Z'}, 2))

    def test_un_seul_appel_pour_vingt_pr_et_moins_de_lots_que_de_pr(self):
        prs = [{'r': 'a', 'n': i, 'm': f'2000-01-{i:02d}T10:10:00Z'} for i in range(1, 22)]
        prets = {('Depot-A', i): (f'2000-01-{i:02d}T10:10:00Z', []) for i in range(1, 22)}
        r = E.releve(prs, self.DEPOTS, {}, self.faux(prets=prets), '2000-02-01T00:00:00Z')
        self.assertEqual((len(r['prets']), r['appels']), (21, 2))                  # 20 + 1 PR : deux requêtes, aucune par PR

    def test_en_parallele_meme_resultat_que_en_serie(self):
        prs = [{'r': 'a', 'n': i, 'm': f'2000-01-{i:02d}T10:10:00Z', 'ms': f'abc123{i}'} for i in range(1, 9)]
        prets = {('Depot-A', i): (f'2000-01-{i:02d}T10:10:00Z', [f'2000-01-{i:02d}T10:00:00Z']) for i in range(1, 9)}
        deps = {'Depot-A': [(i, f'abc123{i}', f'2000-01-{i:02d}T10:20:00Z', [('success', f'2000-01-{i:02d}T10:20:01Z')]) for i in range(1, 9)]}
        serie = E.releve(prs, self.DEPOTS, {}, self.faux(prets, deps), '2000-01-01T10:30:00Z', paralleles=1)
        para = E.releve(prs, self.DEPOTS, {}, self.faux(prets, deps), '2000-01-01T10:30:00Z', paralleles=3)
        self.assertEqual(serie, para)
        self.assertEqual((len(para['prets']), len(para['en_ligne'])), (8, 8))

    def test_resultats_memorises_aucune_relecture(self):
        cache = {}
        pr = [{'r': 'a', 'n': 5, 'm': '2000-01-01T10:10:00Z', 'ms': 'abc1234'}]
        g = self.faux(prets={('Depot-A', 5): ('2000-01-01T10:10:00Z', ['2000-01-01T10:00:00Z'])}, deploiements={'Depot-A': [(9, 'abc1234', 'c', [('success', '2000-01-01T10:20:01Z')])]})
        E.releve(pr, self.DEPOTS, cache, g, '2000-01-01T10:30:00Z')
        g2 = self.faux()
        r = E.releve(pr, self.DEPOTS, cache, g2, '2000-01-01T10:40:00Z')
        self.assertEqual(self.requetes, [])                                          # PR lue, déploiement terminé : plus aucune requête
        self.assertEqual((r['prets'], r['en_ligne']['a#5']['sha'], r['appels']), ({'a#5': '2000-01-01T10:00:00Z'}, 'abc1234', 0))

    def test_deploiement_en_cours_se_relit(self):
        cache = {}
        pr = [{'r': 'a', 'n': 5, 'm': '2000-01-01T10:10:00Z', 'ms': 'abc1234'}]
        E.releve(pr, self.DEPOTS, cache, self.faux(prets={('Depot-A', 5): ('2000-01-01T10:10:00Z', [])}, deploiements={'Depot-A': [(9, 'abc1234', '2000-01-01T10:20:00Z', [('in_progress', 'p')])]}), '2000-01-01T10:30:00Z')
        self.assertEqual(E.associer(pr, cache['dep']), {})
        r = E.releve(pr, self.DEPOTS, cache, self.faux(deploiements={'Depot-A': [(9, 'abc1234', '2000-01-01T10:20:00Z', [('in_progress', 'p'), ('success', '2000-01-01T10:21:00Z')])]}), '2000-01-01T10:40:00Z')
        self.assertEqual(r['en_ligne']['a#5']['pret_le'], '2000-01-01T10:21:00Z')

    def test_deploiement_d_un_autre_commit_n_est_pas_garde(self):
        g = self.faux(deploiements={'Depot-A': [(9, 'fff0000', '2000-01-01T10:20:00Z', [('success', 'x')])]})
        r = E.releve([{'r': 'a', 'n': 5, 'm': '2000-01-01T10:10:00Z', 'ms': 'abc1234'}], self.DEPOTS, {}, g, '2000-01-01T10:30:00Z')
        self.assertEqual(r['en_ligne'], {})

    def test_fusion_sans_deploiement_apres_six_heures_n_est_plus_relue(self):
        cache = {}
        pr = [{'r': 'a', 'n': 5, 'm': '2000-01-01T10:10:00Z', 'ms': 'abc1234'}]
        g = self.faux(prets={('Depot-A', 5): ('2000-01-01T10:10:00Z', [])}, deploiements={'Depot-A': [(9, 'fff0000', '2000-01-01T09:00:00Z', [('success', 'x')])]})
        r = E.releve(pr, self.DEPOTS, cache, g, '2000-01-02T10:10:00Z')
        self.assertEqual((r['en_ligne'], r['prets'], cache['sans']), ({}, {'a#5': None}, {'a#5': True}))
        E.releve(pr, self.DEPOTS, cache, self.faux(), '2000-01-02T10:20:00Z')
        self.assertEqual(self.requetes, [])

    def test_fusion_recente_sans_deploiement_reste_a_relire(self):
        cache = {}
        pr = [{'r': 'a', 'n': 5, 'm': '2000-01-01T10:10:00Z', 'ms': 'abc1234'}]
        E.releve(pr, self.DEPOTS, cache, self.faux(deploiements={'Depot-A': [(9, 'fff0000', '2000-01-01T09:00:00Z', [('success', 'x')])]}), '2000-01-01T10:40:00Z')
        self.assertEqual(cache['sans'], {})                          # le déploiement peut encore arriver (30 minutes seulement)

    def test_plafond_lit_les_fusions_les_plus_recentes_d_abord(self):
        prs = [{'r': 'b', 'n': i, 'm': f'2000-01-{i:02d}T00:00:00Z'} for i in range(1, 31)]
        prets = {('Depot-B', i): (f'2000-01-{i:02d}T00:00:00Z', []) for i in range(1, 31)}
        r = E.releve(prs, self.DEPOTS, {}, self.faux(prets=prets), '2000-01-01T10:30:00Z', plafond=2)      # 1 requête de PR (20 PR) au plus
        self.assertEqual((len(r['prets']), r['restant']), (20, 10))
        self.assertIn('b#30', r['prets'])
        self.assertNotIn('b#1', r['prets'])               # absente = pas encore lue, jamais « sans événement »
        self.assertLessEqual(r['appels'], 2)

    def test_pr_introuvable_ou_d_un_autre_depot_est_absente_et_jamais_relue(self):
        cache = {}
        prs = [{'r': 'a', 'n': 5, 'm': '2000-01-01T10:10:00Z'}, {'r': 'a', 'n': 6, 'm': '2000-01-02T10:10:00Z'}]
        # n°5 n'existe pas ; n°6 existe mais a été fusionnée à une autre date : c'est une autre PR (dépôt qui reprend les numéros)
        g = self.faux(prets={('Depot-A', 6): ('2005-05-05T00:00:00Z', ['2005-05-05T00:00:00Z'])})
        r = E.releve(prs, self.DEPOTS, cache, g, '2000-01-01T10:30:00Z')
        self.assertEqual((r['prets'], r['absents'], r['restant']), ({}, 2, 0))
        E.releve(prs, self.DEPOTS, cache, self.faux(), '2000-01-01T10:40:00Z')
        self.assertEqual(self.requetes, [])

    def test_lecture_en_panne_n_ecrit_rien_et_se_dit(self):
        pr = [{'r': 'a', 'n': 5, 'm': '2000-01-01T10:10:00Z', 'ms': 'abc1234'}]
        r = E.releve(pr, self.DEPOTS, {}, self.faux(erreur='READY_FOR_REVIEW_EVENT'), '2000-01-01T10:30:00Z')
        self.assertEqual((r['prets'], r['restant'], r['absents']), ({}, 1, 0))
        self.assertIn('HTTP 502', r['erreurs'][0])
        r = E.releve(pr, self.DEPOTS, {}, self.faux(prets={('Depot-A', 5): ('2000-01-01T10:10:00Z', [])}, erreur='deployments('), '2000-01-01T10:30:00Z')
        self.assertTrue(any('déploiements' in e for e in r['erreurs']))

    def test_depot_illisible_n_est_pas_une_pr_absente(self):
        pr = [{'r': 'a', 'n': 5, 'm': '2000-01-01T10:10:00Z', 'ms': 'abc1234'}]
        r = E.releve(pr, self.DEPOTS, {}, self.faux(depot_nul='Depot-A'), '2000-01-01T10:30:00Z')
        self.assertEqual((r['prets'], r['absents'], r['restant']), ({}, 0, 1))
        self.assertTrue(r['erreurs'])

    def test_pr_sortie_de_prlog_est_oubliee_du_cache(self):
        cache = {'prets': {'a#1': 'x'}, 'dep': {}, 'sans': {'a#1': True}, 'absents': {'a#2': True}}
        r = E.releve([{'r': 'a', 'n': 5, 'm': '2000-01-01T10:10:00Z'}], self.DEPOTS, cache, self.faux(prets={('Depot-A', 5): ('2000-01-01T10:10:00Z', [])}), '2000-01-01T10:30:00Z')
        self.assertEqual((list(cache['prets']), cache['sans'], cache['absents']), (['a#5'], {}, {}))
        self.assertEqual(list(r['prets']), ['a#5'])

    def test_pr_d_un_depot_inconnu_ou_non_fusionnee_est_ignoree(self):
        r = E.releve([{'r': 'zzz', 'n': 1, 'm': 't'}, {'r': 'a', 'n': 2, 'm': None}], self.DEPOTS, {}, self.faux(), '2000-01-01T10:30:00Z')
        self.assertEqual((r['prets'], r['restant'], self.requetes), ({}, 0, []))

    def test_une_ancienne_cache_reste_lisible(self):
        cache = {'prets': {'a#5': '2000-01-01T10:00:00Z'}, 'dep': {'a': {'9': {'sha': 'abc1234', 'env': 'Production', 'cree_le': 'c', 'pret_le': 'p', 'termine': True}}}}
        r = E.releve([{'r': 'a', 'n': 5, 'm': '2000-01-01T10:10:00Z', 'ms': 'abc1234'}], self.DEPOTS, cache, self.faux(), '2000-01-01T10:30:00Z')
        self.assertEqual((self.requetes, r['en_ligne']['a#5']['pret_le']), ([], 'p'))


class Fenetre(unittest.TestCase):
    def test_seules_les_fusions_recentes_comptent(self):
        prlog = [{'r': 'a', 'n': 1, 'm': '2000-03-01T00:00:00Z'}, {'r': 'a', 'n': 2, 'm': '2000-01-01T00:00:00Z'}, {'r': 'a', 'n': 3, 'm': None}]
        self.assertEqual([x['n'] for x in E.recentes(prlog, '2000-03-10T00:00:00Z')], [1])
        self.assertEqual([x['n'] for x in E.recentes(prlog, '2000-03-10T00:00:00Z', jours=100)], [1, 2])


class Plafond(unittest.TestCase):
    def test_defaut_option_et_refus(self):
        self.assertEqual(E.plafond_de({}), E.PLAFOND_REQUETES)
        self.assertEqual(E.plafond_de({'plafond': '20'}), 20)
        for mauvais in ('0', '-5', 'abc'):
            with self.assertRaises(ValueError): E.plafond_de({'plafond': mauvais})


if __name__ == '__main__':
    unittest.main()
