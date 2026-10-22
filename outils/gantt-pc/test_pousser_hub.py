import base64, gzip, json, os, tempfile, unittest, urllib.error
import pousser_hub as ph

FACTICE = 'essai-factice-' + 'x' * 12      # une valeur reconnaissable, pas un vrai secret (gitleaks lit les affectations nommées « secret »)


def ecrire(chemin, texte):
    with open(chemin, 'w', encoding='utf-8') as fh: fh.write(texte)


def dossier_avec(donnees='{"v":13,"sante":{"n":0}}', **autres):
    d = tempfile.mkdtemp()
    if donnees is not None: ecrire(os.path.join(d, 'donnees.json'), donnees)
    for nom, val in autres.items(): ecrire(os.path.join(d, nom), json.dumps(val))
    return d


def fichier_secret(contenu=FACTICE + '\n'):
    f = os.path.join(tempfile.mkdtemp(), 'gantt-secret.txt')
    ecrire(f, contenu)
    return f


class Poste:
    def __init__(self, code=200, texte='{"ok":true,"recu":"x"}', erreur=None): self.code, self.texte, self.erreur, self.appels = code, texte, erreur, []
    def __call__(self, url, secret, octets):
        self.appels.append((url, secret, octets))
        if self.erreur: raise self.erreur
        return self.code, self.texte


class Corps(unittest.TestCase):
    def test_corps_conforme_a_validerEnvoi_du_hub(self):
        # Les mêmes contrôles que lib/gantt.ts : version 1, date ISO, gzip en base64 (début « H4sI »), quatre objets.
        d = dossier_avec(**{'boucle-etat.json': {'resultat': 'OK'}, 'fiabilite.json': {'i1': {}}, 'prochaines.json': {'depots': []}, 'quota.json': {'claude': 1}})
        c = ph.construire_corps(d, '2026-10-22T21:50:00Z')
        self.assertEqual((c['v'], c['envoye']), (1, '2026-10-22T21:50:00Z'))
        self.assertTrue(c['donnees_gz_b64'].startswith('H4sI'))
        self.assertRegex(c['donnees_gz_b64'], r'^[A-Za-z0-9+/=\s]+$')
        for k in ('etat', 'fiabilite', 'prochaines', 'quota'): self.assertIsInstance(c[k], dict)
        self.assertEqual((c['etat'], c['fiabilite'], c['prochaines'], c['quota']), ({'resultat': 'OK'}, {'i1': {}}, {'depots': []}, {'claude': 1}))

    def test_le_releve_est_garde_tel_quel(self):
        texte = '{"v":13,"sante":{"n":9,"pb":[]},"é":"accent"}'
        c = ph.construire_corps(dossier_avec(texte), '2026-10-22T21:50:00Z')
        self.assertEqual(gzip.decompress(base64.b64decode(c['donnees_gz_b64'])).decode('utf-8'), texte)

    def test_fichier_de_sortie_absent_ou_abime_donne_un_objet_vide(self):
        d = dossier_avec(**{'quota.json': [1, 2]})          # une liste n'est pas un objet
        ecrire(os.path.join(d, 'fiabilite.json'), '{pas du json')
        c = ph.construire_corps(d, '2026-10-22T21:50:00Z')
        self.assertEqual((c['etat'], c['fiabilite'], c['prochaines'], c['quota']), ({}, {}, {}, {}))

    def test_sans_donnees_json_rien_a_envoyer(self):
        with self.assertRaises(OSError): ph.construire_corps(dossier_avec(None), '2026-10-22T21:50:00Z')


class Secret(unittest.TestCase):
    def test_lu_et_nettoye(self): self.assertEqual(ph.lire_secret(fichier_secret('  ' + FACTICE + '\r\n')), (FACTICE, ''))
    def test_absent(self):
        s, r = ph.lire_secret(os.path.join(tempfile.mkdtemp(), 'nexiste-pas.txt'))
        self.assertIsNone(s); self.assertIn('secret absent', r)
    def test_trop_court_ou_avec_espace_refuse(self):
        for mauvais in ('', 'court', 'deux mots dans le secret ici', 'a' * 20 + '\nb' * 10):
            self.assertIsNone(ph.lire_secret(fichier_secret(mauvais))[0], repr(mauvais))
    def test_non_utf8_ne_plante_pas(self):
        f = os.path.join(tempfile.mkdtemp(), 's.txt')
        with open(f, 'wb') as fh: fh.write(b'\xff\xfe\x00bad')
        self.assertIsNone(ph.lire_secret(f)[0])


class Pousser(unittest.TestCase):
    def appeler(self, p, **kw): return ph.pousser(dossier_avec(), fichier_secret(), poster=p, maintenant='2026-10-22T21:50:00Z', **kw)

    def test_envoi_reussi_utilise_le_secret_et_l_url(self):
        p = Poste(); r = self.appeler(p)
        self.assertTrue(r.startswith('hub : envoyé'), r)
        url, secret, octets = p.appels[0]
        self.assertEqual((url, secret), (ph.URL, FACTICE))
        self.assertEqual(json.loads(octets)['v'], 1)

    def test_le_secret_n_est_jamais_dans_le_corps_ni_dans_la_phrase(self):
        for p in (Poste(), Poste(401, '{"ok":false}'), Poste(erreur=OSError(FACTICE)), Poste(erreur=urllib.error.URLError(FACTICE))):
            r = self.appeler(p)
            self.assertNotIn(FACTICE, r)
            for _, _, octets in p.appels: self.assertNotIn(FACTICE.encode(), octets)

    def test_chaque_echec_se_dit_sans_lever(self):
        cas = {401: 'secret refusé', 503: 'pas encore active', 400: 'corps refusé', 413: 'trop gros', 429: 'trop d', 500: 'base échouée', 502: 'inattendue'}
        for code, mot in cas.items():
            r = self.appeler(Poste(code, '{"ok":false}'))
            self.assertTrue(r.startswith('hub : '), r); self.assertIn(mot, r); self.assertIn(f'HTTP {code}', r)

    def test_reseau_coupe_ou_delai(self):
        for e in (OSError('coupé'), TimeoutError(), urllib.error.URLError('dns')):
            r = self.appeler(Poste(erreur=e)); self.assertIn('envoi impossible', r)

    def test_200_sans_ok_n_est_pas_un_succes(self):
        for t in ('{"ok":false}', 'pas du json', '[]'):
            self.assertIn('non confirmé', self.appeler(Poste(200, t)))

    def test_secret_absent_n_appelle_rien(self):
        p = Poste(); r = ph.pousser(dossier_avec(), os.path.join(tempfile.mkdtemp(), 'x.txt'), poster=p)
        self.assertEqual(p.appels, []); self.assertIn('secret absent', r)

    def test_corps_trop_gros_n_est_pas_envoye(self):
        ancien, ph.TAILLE_MAX = ph.TAILLE_MAX, 100
        try:
            p = Poste(); r = ph.pousser(dossier_avec(), fichier_secret(), poster=p)
        finally: ph.TAILLE_MAX = ancien
        self.assertEqual(p.appels, []); self.assertIn('pas d\'envoi', r)

    def test_releve_illisible_n_appelle_rien(self):
        p = Poste(); r = ph.pousser(dossier_avec(None), fichier_secret(), poster=p)
        self.assertEqual(p.appels, []); self.assertIn('relevé illisible', r)


if __name__ == '__main__': unittest.main()
