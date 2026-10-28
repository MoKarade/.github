#!/usr/bin/env python3
# Tests de prs_ouvertes.py : python -X utf8 -m unittest test_prs_ouvertes.py (depuis outils/gantt-pc). Données FICTIVES (dépôts et numéros inventés).
import json
import unittest
import prs_ouvertes as P


def run(nom, status='completed', conclusion='success'): return {'name': nom, 'status': status, 'conclusion': conclusion}
def pr(n, **kw):
    base = {'number': n, 'title': f'titre {n}', 'html_url': f'https://x/{n}', 'body': '', 'draft': False, 'user': {'login': 'moi', 'type': 'User'},
            'head': {'ref': f'feature/{n}', 'sha': f'abcdef{n:04d}'}, 'labels': [], 'created_at': '2000-01-01T00:00:00Z', 'updated_at': f'2000-01-0{n % 9 + 1}T00:00:00Z'}
    base.update(kw)
    return base
def payload(**p): return '<!---\nDO NOT EDIT\n-*- Mergify Payload -*-\n' + json.dumps(p) + '\n-*- Mergify Payload End -*-\n-->\n\n### ⏳ Queued · 1st in line\n\ntexte'
def com(corps, login='mergify[bot]'): return {'user': {'login': login}, 'body': corps}


class Lien(unittest.TestCase):
    def test_tache_dans_le_meme_depot_ou_un_autre(self):
        self.assertEqual(P.tache_de('Tâche : #12', 'Hubperso'), 'hubperso#12')
        self.assertEqual(P.tache_de('x\n**Tâche** : MoKarade/CarAI#3', '.github'), 'carai#3')

    def test_closes_sert_de_repli_et_tache_l_emporte(self):
        self.assertEqual(P.tache_de('Closes #7', 'jobai'), 'jobai#7')
        self.assertEqual(P.tache_de('Closes #7\nTâche : #8', 'jobai'), 'jobai#8')

    def test_sans_lien_ou_corps_absent(self):
        self.assertIsNone(P.tache_de('rien', 'a'))
        self.assertIsNone(P.tache_de(None, 'a'))


class Agent(unittest.TestCase):
    def test_robots_connus_et_marques(self):
        self.assertEqual(P.agent_de(pr(1, user={'login': 'Copilot', 'type': 'Bot'})), 'Copilot')
        self.assertEqual(P.agent_de(pr(1, user={'login': 'google-labs-jules[bot]', 'type': 'Bot'})), 'Jules')
        self.assertEqual(P.agent_de(pr(1, user={'login': 'moi'}, body='fin\nhttps://jules.google.com/task/123')), 'Jules')
        self.assertEqual(P.agent_de(pr(1, user={'login': 'moi'}, labels=[{'name': 'par-jules'}])), 'Jules')
        self.assertEqual(P.agent_de(pr(1, user={'login': 'dependabot[bot]', 'type': 'Bot'})), 'Dependabot')
        self.assertEqual(P.agent_de(pr(1, user={'login': 'autre-app[bot]', 'type': 'Bot'})), 'autre-app')

    def test_claude_par_branche_ou_attribution_sinon_marc(self):
        self.assertEqual(P.agent_de(pr(1, head={'ref': 'claude/x', 'sha': 's'})), 'Claude')
        self.assertEqual(P.agent_de(pr(1, body='https://claude.ai/code/session_abc')), 'Claude')
        self.assertEqual(P.agent_de(pr(1)), 'Marc')


class CI(unittest.TestCase):
    def test_vert_compte_succes_neutre_et_saute(self):
        c = P.etat_ci([run('a'), run('b', conclusion='neutral'), run('c', conclusion='skipped')])
        self.assertEqual((c['etat'], c['ok']), ('vert', 3))

    def test_rouge_l_emporte_meme_si_d_autres_tournent(self):
        c = P.etat_ci([run('a', conclusion='failure'), run('b', status='in_progress', conclusion=None)])
        self.assertEqual((c['etat'], c['ko'], c['en_cours'], c['rouges']), ('rouge', 1, 1, ['a']))

    def test_en_file_nomme_les_jobs_en_attente_de_machine(self):
        c = P.etat_ci([run('Tests', status='queued', conclusion=None), run('Garde-fou')])
        self.assertEqual((c['etat'], c['en_file'], c['noms_en_file']), ('en_cours', 1, ['Tests']))

    def test_sans_controle_jamais_vert_et_mergify_ne_compte_pas(self):
        self.assertEqual(P.etat_ci([])['etat'], 'aucun')
        self.assertEqual(P.etat_ci([run('Mergify Merge Queue', conclusion='neutral'), run('@mergify/Mergify Merge Protections')])['etat'], 'aucun')

    def test_annule_n_est_pas_vert(self):
        self.assertEqual(P.etat_ci([run('a', conclusion='cancelled')])['etat'], 'annule')

    def test_noms_plafonnes(self):
        c = P.etat_ci([run(f'job{i}', status='queued', conclusion=None) for i in range(12)])
        self.assertEqual((c['en_file'], len(c['noms_en_file'])), (12, 8))


class Mergify(unittest.TestCase):
    def test_en_file_avec_position_et_etape(self):
        m = P.etat_mergify([com(payload(state='checking', queued_at='t0', position=2, step='checks_running'))], [])
        self.assertEqual((m['file'], m['etat'], m['position'], m['etape'], m['message']), (True, 'checking', 2, 'checks_running', '⏳ Queued · 1st in line'))

    def test_sorti_de_file_garde_l_heure_de_sortie(self):
        m = P.etat_mergify([com(payload(state='merged', queued_at='t0', left_at='t1'))], [])
        self.assertEqual((m['file'], m['sortie_le']), (False, 't1'))

    def test_dernier_commentaire_de_mergify_seulement(self):
        m = P.etat_mergify([com(payload(state='old', queued_at='t0')), com('autre', 'moi'), com(payload(state='new', queued_at='t5'), 'moi'),
                            com(payload(state='new', queued_at='t5'))], [])
        self.assertEqual(m['etat'], 'new')

    def test_sans_commentaire_pas_en_file_et_controle_recopie(self):
        m = P.etat_mergify([], [{'name': 'Mergify Merge Queue', 'output': {'title': 'Waiting for queue conditions to match'}}])
        self.assertEqual((m['file'], m['controle']), (False, 'Waiting for queue conditions to match'))
        self.assertNotIn('etat', m)

    def test_charge_utile_illisible_ne_leve_pas(self):
        m = P.etat_mergify([com('-*- Mergify Payload -*-\n{pas du json}\n-*- Mergify Payload End -*-')], [])
        self.assertFalse(m['file'])


class Deploiement(unittest.TestCase):
    def test_dernier_deploiement_et_son_statut(self):
        d = P.deploiement([{'id': 1, 'environment': 'Production', 'sha': 'abcdef12345', 'ref': 'main', 'created_at': 'c', 'updated_at': 'u'}],
                          [{'state': 'success', 'created_at': 's', 'environment_url': 'https://e'}])
        self.assertEqual((d['environnement'], d['etat'], d['sha'], d['maj_le'], d['url']), ('Production', 'success', 'abcdef1', 's', 'https://e'))

    def test_aucun_deploiement_rend_none(self):
        self.assertIsNone(P.deploiement([], []))


class Releve(unittest.TestCase):
    def faux(self, prs, runs=None, coms=None, erreur=None):
        self.chemins = []
        def lire(chemin):
            self.chemins.append(chemin)
            if erreur and erreur in chemin: raise RuntimeError('HTTP 500 en panne')
            if '/pulls?' in chemin: return prs if chemin.endswith('page=1') else []
            if '/check-runs' in chemin: return {'total_count': len(runs or []), 'check_runs': runs or []}
            if '/comments' in chemin: return coms or []
            if chemin.endswith('/deployments?per_page=1'): return [{'id': 9, 'environment': 'Production', 'sha': 'abc1234', 'ref': 'main', 'created_at': 'c'}]
            if '/statuses' in chemin: return [{'state': 'success', 'created_at': 's'}]
            raise AssertionError(chemin)
        return lire

    def test_une_pr_complete(self):
        r = P.releve(['a'], self.faux([pr(1, body='Tâche : #4', head={'ref': 'claude/x', 'sha': 'abcdef0001'})], runs=[run('t')],
                                      coms=[com(payload(state='checking', queued_at='t0', position=1))]), 'T')
        x = r['prs'][0]
        self.assertEqual((x['repo'], x['n'], x['tache'], x['agent'], x['brouillon'], x['sha'], x['ci']['etat'], x['mergify']['file']), ('a', 1, 'a#4', 'Claude', False, 'abcdef0', 'vert', True))
        self.assertEqual(r['deploiements']['a']['etat'], 'success')
        self.assertEqual((r['v'], r['releve'], r['incomplet'], r['erreurs']), (1, 'T', False, []))

    def test_brouillon_sans_lecture_des_commentaires(self):
        lire = self.faux([pr(1, draft=True)], runs=[run('t')])
        r = P.releve(['a'], lire, 'T')
        self.assertTrue(r['prs'][0]['brouillon'])
        self.assertFalse([c for c in self.chemins if '/comments' in c])

    def test_pr_de_test_de_mergify_comptee_a_part(self):
        r = P.releve(['a'], self.faux([pr(1, head={'ref': 'mergify/merge-queue/abc', 'sha': 's'}), pr(2)], runs=[]), 'T')
        self.assertEqual((r['brouillons_mergify'], [x['n'] for x in r['prs']]), (1, [2]))

    def test_lecture_en_panne_dit_l_erreur_jamais_vert(self):
        r = P.releve(['a'], self.faux([pr(1)], erreur='check-runs'), 'T')
        self.assertIn('HTTP 500', r['prs'][0]['ci']['erreur'])
        r = P.releve(['a'], self.faux([pr(1)], erreur='/pulls'), 'T')
        self.assertEqual((r['prs'], len(r['erreurs'])), ([], 1))
        r = P.releve(['a'], self.faux([pr(1)], erreur='deployments'), 'T')
        self.assertIn('erreur', r['deploiements']['a'])

    def test_plafond_marque_non_lu_les_pr_les_plus_anciennes(self):
        n = {'v': 0}
        def compter(): n['v'] += 5; return n['v']
        r = P.releve(['a'], self.faux([pr(i) for i in (1, 2, 3, 4)], runs=[run('t')]), 'T', compter, plafond=12)
        self.assertTrue(r['incomplet'])
        non_lus = [x['n'] for x in r['prs'] if x['ci']['etat'] == 'non_lu']
        lus = [x['n'] for x in r['prs'] if x['ci']['etat'] != 'non_lu']
        self.assertEqual((sorted(lus), sorted(non_lus)), ([3, 4], [1, 2]))     # modifiées le plus récemment = numéros 4 et 3

    def test_ordre_par_depot_puis_numero(self):
        r = P.releve(['b', 'a'], self.faux([pr(3), pr(1)], runs=[]), 'T')
        self.assertEqual([(x['repo'], x['n']) for x in r['prs']], [('b', 1), ('b', 3), ('a', 1), ('a', 3)])


class Plafond(unittest.TestCase):
    def test_defaut_option_et_refus(self):
        self.assertEqual(P.plafond_de({}), P.PLAFOND_APPELS)
        self.assertEqual(P.plafond_de({'plafond': '30'}), 30)
        for mauvais in ('0', '-5', 'abc'):
            with self.assertRaises(ValueError): P.plafond_de({'plafond': mauvais})


if __name__ == '__main__':
    unittest.main()
