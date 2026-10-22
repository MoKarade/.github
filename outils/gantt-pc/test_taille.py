# La taille d'une PR est définie DEUX fois : scripts/taille-pr.mjs (le Garde-fou) et fetch.py (le relevé du Gantt). Si l'une change
# sans l'autre, la page annonce une taille que le Garde-fou ne retient pas (tâche .github#539, 22/10/2026 : drizzle/meta/).
import os
import re
import unittest

ICI = os.path.dirname(os.path.abspath(__file__))


def lire(chemin):
    with open(chemin, encoding='utf-8') as f:
        return f.read()


def motif_py():
    m = re.search(r"^HORS_TAILLE = re\.compile\(r'(.*)', re\.I\)$", lire(os.path.join(ICI, 'fetch.py')), re.M)
    return m.group(1)


def motif_js():
    m = re.search(r"^export const HORS_TAILLE = /(.*)/i;$", lire(os.path.join(ICI, '..', '..', 'scripts', 'taille-pr.mjs')), re.M)
    return m.group(1).replace('\\/', '/')


class TailleDefinieUneFois(unittest.TestCase):
    def test_memes_motifs(self):
        self.assertEqual(motif_py(), motif_js())

    def test_drizzle_meta_hors_taille_sql_compte(self):
        hors = re.compile(motif_py(), re.I)
        for f in ('drizzle/meta/0007_snapshot.json', 'drizzle/meta/_journal.json', 'web/drizzle/meta/0001_snapshot.json'):
            self.assertTrue(hors.search(f), f)
        for f in ('drizzle/0007_neuve.sql', 'lib/schema.ts', 'docs/drizzle/metadonnees.md'):
            self.assertFalse(hors.search(f), f)


if __name__ == '__main__':
    unittest.main()
