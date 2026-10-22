# Impact de Graphify lu dans les artefacts « graphe » (graphes.py, tâche .github#466). Tests : python -X utf8 -m unittest test_graphes.py
import io, json, unittest, zipfile
from graphes import entree, a_telecharger, relever, resume_impact


def zip_de(**fichiers):
    b = io.BytesIO()
    with zipfile.ZipFile(b, 'w') as z:
        for nom, contenu in fichiers.items(): z.writestr(nom.replace('_json', '.json'), json.dumps(contenu))
    return b.getvalue()


def art(ident, t='2026-10-22T12:00:00Z', expire=False):
    return {'id': ident, 'name': 'graphe', 'created_at': t, 'expired': expire, 'workflow_run': {'id': 39774744886, 'head_sha': 'bae630cf0b67'}}


LIGNE = {'graphe_en_plus': 4, 'grep_en_plus': 1, 'grep_commentaires': 0}
IMPACT = {'version': 'impact-v1', 'taille': {'noeuds': 2094, 'aretes': 4559, 'fichiers': 241, 'communautes': 138, 'page_noeuds': 159,
                                             'hors_page': 10, 'construction_s': 18.0},
          'banc': [LIGNE, {'graphe_en_plus': 12, 'grep_en_plus': 2, 'grep_commentaires': 2}],
          'totaux': {'lignes_mesurees': 10, 'graphe_jetons': 4465, 'grep_jetons': 6128, 'economie_jetons': 0.271, 'rappel_moyen': 0.838,
                     'graphe_ms_median': 1034, 'grep_ms_median': 4}}
META = {'noeuds': 159, 'aretes': 564, 'genereLe': '2026-10-22T11:59:49Z'}


class TestGraphes(unittest.TestCase):
    def test_cas_valide(self):
        e = entree('mem', art(12424530701), zip_de(meta_json=META, impact_json=IMPACT))
        self.assertEqual(e['sha'], 'bae630c')
        self.assertEqual(e['meta'], {'noeuds': 159, 'aretes': 564, 'genereLe': '2026-10-22T11:59:49Z'})
        i = e['impact']
        self.assertEqual((i['noeuds'], i['aretes'], i['construction_s']), (2094, 4559, 18.0))
        self.assertEqual((i['gj'], i['rj'], i['eco'], i['rap'], i['gms'], i['rms'], i['l']), (4465, 6128, 0.271, 0.838, 1034, 4, 10))
        self.assertEqual((i['plus'], i['manque'], i['com']), (16, 3, 2))
        self.assertNotIn('err', e)

    def test_impact_absent(self):
        e = entree('mem', art(1), zip_de(meta_json=META))     # artefact d'avant #465 : le graphe sans la mesure
        self.assertIsNone(e['impact'])
        self.assertEqual(e['meta']['noeuds'], 159)
        self.assertNotIn('err', e)

    def test_null_reste_null(self):
        imp = json.loads(json.dumps(IMPACT))
        imp['totaux']['economie_jetons'] = None
        imp['taille']['construction_s'] = None
        imp['banc'] = [{'graphe_en_plus': None, 'grep_en_plus': None, 'grep_commentaires': None}]
        i = entree('mem', art(2), zip_de(impact_json=imp))['impact']
        self.assertIsNone(i['eco'])
        self.assertIsNone(i['construction_s'])
        self.assertEqual((i['plus'], i['manque'], i['com']), (None, None, None))     # aucune mesure : pas 0
        self.assertEqual(i['gj'], 4465)

    def test_autre_version_ou_zip_illisible(self):
        e = entree('mem', art(3), zip_de(impact_json={**IMPACT, 'version': 'impact-v2'}))
        self.assertEqual((e['impact'], e['err']), (None, 'version'))
        self.assertEqual(entree('mem', art(4), b'pas un zip')['err'], 'zip')
        self.assertIsNone(resume_impact(None))

    def test_seuls_les_neufs_sont_telecharges(self):
        arts = [art(1, '2026-10-20T00:00:00Z'), art(2, '2026-10-22T00:00:00Z'), art(3, '2026-10-21T00:00:00Z'), art(4, expire=True)]
        self.assertEqual([a['id'] for a in a_telecharger(arts, {'3': {}}, 5)], [2, 1])
        self.assertEqual([a['id'] for a in a_telecharger(arts, {}, 1)], [2])

    def test_relever(self):
        cache = {'9': {'r': 'mem', 'id': 9, 't': '2026-07-01T00:00:00Z'}, '8': {'r': 'car', 'id': 8, 't': '2026-10-01T00:00:00Z'}}
        def lire(chemin):
            if 'carai' in chemin: raise RuntimeError('HTTP 502')
            return {'artifacts': [art(5, '2026-10-22T12:27:07Z'), art(6, '2026-10-22T12:00:00Z')]}
        appels = []
        def charger(depot, ident):
            appels.append(ident)
            return None if ident == 6 else zip_de(meta_json=META, impact_json=IMPACT)
        liste, lus, erreurs = relever([('memoryai', 'mem'), ('carai', 'car')], lire, cache, charger)
        self.assertEqual(appels, [5, 6])
        self.assertEqual(lus, 2)
        self.assertEqual(sorted(cache), ['5', '8'])     # 9 a expiré, 6 sera relu, 8 gardé malgré la liste illisible
        self.assertEqual([e['id'] for e in liste], [8, 5])
        self.assertEqual(len(erreurs), 2)


if __name__ == '__main__': unittest.main()
