#!/usr/bin/env python3
"""Page de graphe lisible : le graphe complet (graphify-out/graph.json) réduit à une carte par FICHIER.

Garde le code des dossiers sources, écarte tests, générés, dépendances, config et docs, regroupe les
symboles par fichier (un lien = au moins un appel ou import entre deux fichiers), couleur = dossier.
Local, 0 jeton, 0 réseau. Les requêtes (query, affected) restent sur le graphe complet.

Usage : graphe-page.py GRAPH_JSON SORTIE_HTML [--max-noeuds 400] [--titre "Graphe du dépôt"]
Interprète : celui du venv de graphe.sh (networkx et graphify y sont installés).
"""
import argparse
import collections
import json
import re
import sys

ECARTES = re.compile(
    r"(^|/)(docs|tests?|__tests__|e2e|\.claude|\.github|qualite|drizzle|node_modules|dist|build|\.next|public|seed|coverage|generated)/"
    r"|\.(md|json|ya?ml|css|svg|sql|lock|d\.ts)$"
    r"|(^|/)(\.[^/]+|HANDOVER|CHANGELOG|README|CLAUDE)",
    re.I,
)
# Dossiers à deux niveaux : un seul niveau les noierait dans un bloc unique.
RACINES_LARGES = {"app", "lib", "components", "src", "services", "utils", "hooks", "store", "web", "api", "mcp"}
MOBILE = (
    "<style>html, body { height: 100%; }"
    "@media (max-width: 700px) { body { flex-direction: column; } #graph { min-height: 0; }"
    " #sidebar { width: 100%; height: 45%; border-left: 0; border-top: 1px solid var(--border); } }</style>"
)


def dossier(chemin):
    parties = chemin.split("/")[:-1]
    if not parties:
        return "(racine)"
    n = 2 if parties[0] in RACINES_LARGES and len(parties) > 1 else 1
    return "/".join(parties[:n])


def etiquette(chemin):
    parties = chemin.split("/")
    return "/".join(parties[-2:]) if len(parties) > 1 else chemin


def reduire(g, max_noeuds=400):
    """Graphe complet (dict graph.json) -> (fichiers gardés, liens {(a, b): poids}, groupes {dossier: [fichiers]})."""
    fichier = {
        n["id"]: n["source_file"]
        for n in g["nodes"]
        if n.get("file_type") == "code" and n.get("source_file") and not ECARTES.search(n["source_file"])
    }
    poids = collections.Counter()
    for l in g["links"]:
        x, y = fichier.get(l["source"]), fichier.get(l["target"])
        if x and y and x != y:
            poids[tuple(sorted((x, y)))] += 1

    degre = collections.Counter()
    for (x, y), w in poids.items():
        degre[x] += w
        degre[y] += w
    gardes = sorted(p for p, _ in degre.most_common(max_noeuds))
    liens = {e: w for e, w in poids.items() if e[0] in gardes and e[1] in gardes}

    # Un sous-dossier de moins de 3 fichiers retombe sur son parent : pas de communauté d'un seul nœud.
    effectif = collections.Counter(dossier(p) for p in gardes)

    def groupe(p):
        d = dossier(p)
        return d if effectif[d] >= 3 or "/" not in d else d.rsplit("/", 1)[0]

    groupes = collections.defaultdict(list)
    for p in gardes:
        groupes[groupe(p)].append(p)
    return gardes, liens, dict(groupes), len(set(fichier.values()))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("graphe")
    ap.add_argument("sortie")
    ap.add_argument("--max-noeuds", type=int, default=400)
    ap.add_argument("--titre", default="Graphe du dépôt")
    a = ap.parse_args()

    import networkx as nx
    from graphify.export import to_html

    gardes, liens, groupes, total = reduire(json.load(open(a.graphe, encoding="utf-8")), a.max_noeuds)
    if not gardes:
        print("aucun fichier de code relié : pas de page", file=sys.stderr)
        return 0

    G = nx.Graph()
    for p in gardes:
        G.add_node(p, label=etiquette(p), source_file=p, file_type="code")
    for (x, y), w in liens.items():
        G.add_edge(x, y, weight=w, relation=f"{w} lien(s) entre fichiers", confidence="EXTRACTED")
    noms = dict(enumerate(groupes))
    communautes = {i: groupes[d] for i, d in noms.items()}

    to_html(G, communautes, a.sortie, community_labels=noms)
    # Téléphone : le panneau passe sous le graphe au lieu de le manger (largeur < 700 px).
    html = open(a.sortie, encoding="utf-8").read()
    html = re.sub(r"<title>.*?</title>", f"<title>{a.titre}</title>", html, count=1, flags=re.S)
    html = html.replace("</head>", MOBILE + "</head>", 1)
    open(a.sortie, "w", encoding="utf-8").write(html)
    print(f"{a.sortie} : {len(gardes)} fichiers, {len(liens)} liens, {len(groupes)} dossiers"
          f" ({total - len(gardes)} fichiers hors page : isolés ou au-delà de {a.max_noeuds})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
