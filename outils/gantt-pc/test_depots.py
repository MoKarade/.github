# Les listes de dépôts du relevé doivent toutes connaître lia-ui (tâche .github#535, 22/10/2026) : un dépôt absent d'une liste est
# invisible du Gantt ou du quota sans que rien ne le dise. fetch.py s'exécute à l'import : ses listes se lisent donc dans le texte.
import os
import re
import unittest

ICI = os.path.dirname(os.path.abspath(__file__))


def texte(nom):
    with open(os.path.join(ICI, nom), encoding='utf-8') as f:
        return f.read()


class DepotsConnus(unittest.TestCase):
    def test_fetch_relit_lia_ui(self):
        self.assertIn("('lia-ui','lia','lia-ui')", texte('fetch.py'))

    def test_quota_compte_lia_ui(self):
        m = re.search(r"^REPOS = \[(.*)\]$", texte('quota.py'), re.M)
        self.assertIn("'lia-ui'", m.group(1))

    def test_deps_reconnait_lia_ui(self):
        import deps
        self.assertIn('lia-ui', deps.NOMS_DEPOTS)
        self.assertEqual(deps.lire_attend('**Attend** : lia-ui#3, MemoryAI#4', 'memoryai'), ['lia-ui#3', 'memoryai#4'])

    def test_reponses_connait_lia_ui(self):
        m = re.search(r"^DEPOTS = \{(.*)\}$", texte('reponses.py'), re.M)
        self.assertIn("'lia-ui'", m.group(1))


if __name__ == '__main__':
    unittest.main()
