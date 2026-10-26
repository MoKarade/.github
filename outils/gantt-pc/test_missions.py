#!/usr/bin/env python3
# Tests de missions.py (tâche .github#591) : python -X utf8 -m unittest test_missions.py (depuis outils/gantt-pc)
import datetime, json, unittest
import missions as M

UTC = datetime.timezone.utc
NOW = datetime.datetime(2026, 10, 26, 15, 0, tzinfo=UTC)
ASOF = '2026-10-26T15:00:00Z'


def tache(n, state='closed', cree='2026-10-20T10:00:00Z', ferme='2026-10-22T10:00:00Z', et=None, start=None, reason='completed', labels=()):
    return {'n': n, 'title': f'Tâche {n}', 'lvl': 'tâche', 'labels': ['niveau:tâche', *labels], 'state': state, 'reason': reason if state == 'closed' else None,
            'created': cree, 'closed': ferme if state == 'closed' else None, 'start': start, 'et': et or [], 'kids': []}


def mission(n, kids, state='open', lvl='mission', labels=(), ferme=None):
    return {'n': n, 'title': f'Mission {n}', 'lvl': lvl, 'labels': [f'niveau:{lvl}', *labels], 'state': state, 'reason': 'completed' if state == 'closed' else None,
            'created': '2026-10-01T10:00:00Z', 'closed': ferme, 'start': None, 'et': [], 'kids': list(kids)}


def repos(*noeuds, depot='MemoryAI'):
    return [{'repo': depot, 'nodes': {str(n['n']): n for n in noeuds}}]


class Deriver(unittest.TestCase):
    def test_debut_et_fin_viennent_des_taches_pas_de_l_issue_de_la_mission(self):
        r = repos(mission(1, [2, 3]), tache(2, et=[['cours', '2026-10-21T08:00:00Z'], ['faite', '2026-10-22T10:00:00Z']]),
                  tache(3, ferme='2026-10-23T12:00:00Z', et=[['cours', '2026-10-22T09:00:00Z'], ['faite', '2026-10-23T12:00:00Z']]))
        d = M.deriver(r)['memoryai#1']
        self.assertEqual((d['deb'], d['fin'], d['nt'], d['nf'], d['inc']), ('2026-10-21T08:00:00Z', '2026-10-23T12:00:00Z', 2, 2, 0))

    def test_une_tache_ouverte_empeche_la_fin(self):
        r = repos(mission(1, [2, 3]), tache(2), tache(3, state='open', et=[['cours', '2026-10-25T09:00:00Z']]))
        d = M.deriver(r)['memoryai#1']
        self.assertIsNone(d['fin']); self.assertEqual((d['nt'], d['nf']), (2, 1))

    def test_une_tache_fermee_d_un_seul_geste_commence_a_sa_creation(self):
        r = repos(mission(1, [2]), tache(2, cree='2026-10-20T10:00:00Z', ferme='2026-10-20T10:05:00Z'))
        self.assertEqual(M.deriver(r)['memoryai#1']['deb'], '2026-10-20T10:00:00Z')

    def test_une_tache_ouverte_jamais_commencee_n_ouvre_pas_la_mission(self):
        r = repos(mission(1, [2]), tache(2, state='open'))
        d = M.deriver(r)['memoryai#1']
        self.assertIsNone(d['deb']); self.assertEqual(d['nt'], 1)

    def test_un_enfant_absent_du_releve_laisse_la_fin_vide(self):
        r = repos(mission(1, [2, 99]), tache(2))
        d = M.deriver(r)['memoryai#1']
        self.assertIsNone(d['fin']); self.assertEqual(d['inc'], 1)

    def test_le_chantier_descend_dans_ses_missions_et_les_references_d_un_autre_depot_se_lisent(self):
        r = repos(mission(10, ['memoryai#1', 'carai#5'], lvl='chantier'), mission(1, [2]), tache(2)) + \
            [{'repo': 'carai', 'nodes': {'5': tache(5, ferme='2026-10-25T10:00:00Z')}}]
        d = M.deriver(r)['memoryai#10']
        self.assertEqual((d['nt'], d['nf'], d['fin']), (2, 2, '2026-10-25T10:00:00Z'))

    def test_un_cycle_ne_boucle_pas(self):
        r = repos(mission(1, [2]), mission(2, [1]))
        self.assertEqual(M.deriver(r)['memoryai#1']['nt'], 0)


class AFermer(unittest.TestCase):
    def test_toutes_les_taches_fermees_depuis_plus_de_24_h(self):
        r = repos(mission(1, [2, 3]), tache(2), tache(3, reason='not_planned'))
        l = M.a_fermer(r, NOW)
        self.assertEqual([(m['ref'], m['acceptees'], m['abandonnees']) for m in l], [('memoryai#1', 1, 1)])

    def test_trop_recent_ou_tache_ouverte_ou_enfant_absent_ou_rien_d_accepte(self):
        recent = repos(mission(1, [2]), tache(2, ferme='2026-10-26T10:00:00Z'))
        self.assertEqual(M.a_fermer(recent, NOW), [])
        ouverte = repos(mission(1, [2, 3]), tache(2), tache(3, state='open'))
        self.assertEqual(M.a_fermer(ouverte, NOW), [])
        absent = repos(mission(1, [2, 99]), tache(2))
        self.assertEqual(M.a_fermer(absent, NOW), [])
        abandonnee = repos(mission(1, [2]), tache(2, reason='not_planned'))
        self.assertEqual(M.a_fermer(abandonnee, NOW), [])

    def test_geste_de_marc_blocage_ou_preuve_programmee_sur_la_mission_la_gardent_ouverte(self):
        for etiquette in ('qui:marc', 'bloqué', 'preuve-attendue'):
            r = repos(mission(1, [2], labels=(etiquette,)), tache(2))
            self.assertEqual(M.a_fermer(r, NOW), [], etiquette)

    def test_une_tache_a_preuve_manquante_garde_la_mission_ouverte(self):
        r = repos(mission(1, [2]), tache(2, labels=('preuve-manquante',)))
        self.assertEqual(M.a_fermer(r, NOW), [])

    def test_mission_deja_fermee_sans_enfant_ou_tache_ne_se_ferment_pas(self):
        r = repos(mission(1, [2], state='closed', ferme='2026-10-20T10:00:00Z'), mission(3, []), tache(2))
        self.assertEqual(M.a_fermer(r, NOW), [])

    def test_une_mission_dans_un_chantier_n_est_pas_un_chantier(self):
        r = repos(mission(10, [1], lvl='chantier'), mission(1, [2]), tache(2))
        self.assertEqual([m['ref'] for m in M.a_fermer(r, NOW)], ['memoryai#1'])


class Fermer(unittest.TestCase):
    def faux_gh(self, vue, appels):
        def gh(*args, entree=None):
            appels.append((args, entree))
            return json.dumps(vue) if args[0] == 'api' and len(args) == 2 else '{}'
        return gh

    def item(self):
        return M.a_fermer(repos(mission(1, [2]), tache(2)), NOW)[0]

    def test_commentaire_acceptee_puis_fermeture_completed(self):
        appels = []
        f, refus = M.fermer([self.item()], ASOF, self.faux_gh({'state': 'open', 'sub_issues_summary': {'total': 1, 'completed': 1}}, appels))
        self.assertEqual((f, refus), (['memoryai#1'], []))
        self.assertEqual(appels[1][0][1:3], ('-X', 'POST')); self.assertTrue(appels[1][0][3].endswith('/issues/1/comments'))
        self.assertEqual(appels[2][0][1:3], ('-X', 'PATCH')); self.assertTrue(appels[2][0][3].endswith('/issues/1'))
        corps = json.loads(appels[1][1])['body']
        self.assertTrue(corps.startswith('**Acceptée**'))
        self.assertIn('preuve :', corps)
        self.assertEqual(json.loads(appels[2][1]), {'state': 'closed', 'state_reason': 'completed'})

    def test_deja_fermee_ou_github_dit_qu_il_reste_une_tache_rien_n_est_ecrit(self):
        for vue in ({'state': 'closed'}, {'state': 'open', 'sub_issues_summary': {'total': 3, 'completed': 2}}):
            appels = []
            f, refus = M.fermer([self.item()], ASOF, self.faux_gh(vue, appels))
            self.assertEqual(f, []); self.assertEqual(len(refus), 1); self.assertEqual(len(appels), 1)      # une seule lecture, aucune écriture

    def test_a_blanc_n_ecrit_rien(self):
        appels = []
        f, _ = M.fermer([self.item()], ASOF, self.faux_gh({'state': 'open'}, appels), a_blanc=True)
        self.assertEqual(f, ['memoryai#1 (à blanc)']); self.assertEqual(len(appels), 1)

    def test_une_erreur_github_se_dit_et_les_suivantes_continuent(self):
        def gh(*args, entree=None):
            if args[-1].endswith('/issues/1'): raise RuntimeError('403')
            return json.dumps({'state': 'open'})
        items = M.a_fermer(repos(mission(1, [2]), mission(3, [4]), tache(2), tache(4, ferme='2026-10-22T11:00:00Z')), NOW)
        f, refus = M.fermer(items, ASOF, gh)
        self.assertEqual(len(f), 1); self.assertEqual(len(refus), 1); self.assertIn('403', refus[0])

    def test_borne_par_tour(self):
        n = M.PAR_TOUR + 3
        noeuds = [mission(i, [100 + i]) for i in range(1, n + 1)] + [tache(100 + i, ferme=f'2026-10-22T{i:02d}:00:00Z') for i in range(1, n + 1)]
        items = M.a_fermer(repos(*noeuds), NOW)
        self.assertEqual(len(items), n)
        appels = []
        f, _ = M.fermer(items, ASOF, self.faux_gh({'state': 'open'}, appels))
        self.assertEqual(len(f), M.PAR_TOUR)


if __name__ == '__main__':
    unittest.main()
