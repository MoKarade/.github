#!/usr/bin/env python3
"""Impact de Graphify : un banc de 10 symboles, `affected` contre `grep`, écrit dans impact.json (version impact-v1).

Pour chaque symbole tiré du graphe (les plus reliés) : la taille de la réponse de `scripts/graphe.sh affected` contre
celle de `git grep -w`, le temps de chacun, les fichiers de code que le graphe trouve en plus (dépendants indirects) ou
manque (rappel), et les lignes de commentaire que grep ramène pour rien. Jetons estimés = caractères / 4.
Une valeur non mesurée vaut `null`, jamais un nombre inventé. Local, 0 jeton, 0 réseau, aucun appel IA.

Usage : graphe-impact.py GRAPH_JSON SORTIE_JSON [--depot MoKarade/nom --sha SHA --duree-construction SECONDES]
        [--meta meta.json] [--racine .] [--banc 10]
        (lancé depuis la racine du dépôt mesuré, après `scripts/graphe.sh update` ; schéma : docs/graphe-code.md)
"""
import argparse
import collections
import datetime
import json
import math
import os
import re
import statistics
import subprocess
import sys
import time

VERSION = "impact-v1"
IDENTIFIANT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{4,}$")
FICHIER_AFFECTE = re.compile(r"\s(\S+\.[A-Za-z0-9]+):L\d+\s*$")
COMMENTAIRE = re.compile(r"^\s*(//|/\*|\*|#)")
TEST = re.compile(r"(^|/)(tests?|__tests__|e2e|spec)/|\.(test|spec)\.[A-Za-z]+$")  # le graphe en ressort presque jamais
SOURCE = re.compile(r"\.(tsx?|jsx?|mjs|cjs|py|gs|go|rs|java|rb|php|cs|kt|swift)$")
DELAI = 120  # secondes par appel : un symbole qui dépasse reste null, le banc continue
# Baseline git grep (depuis le 22/10/2026) : ni code généré (dist/ commité dans hub-contract : 20 000 jetons par symbole),
# ni ligne de plus de 1 000 caractères (code minifié : un symbole de Hubperso tombait dans un fichier vendu de 771 000 caractères).
GENERES = tuple(f":(exclude,glob)**/{d}/**" for d in ("dist", "build", ".next", "coverage", "node_modules"))
LIGNE_MAX_GREP = 1000
PLAFOND_SURPRENANTS = 200
CHAMPS_BANC = ("graphe_caracteres", "graphe_jetons", "graphe_ms", "grep_caracteres", "grep_jetons", "grep_ms",
               "fichiers_graphe", "fichiers_grep", "fichiers_communs", "graphe_en_plus", "grep_en_plus",
               "rappel", "grep_commentaires", "grep_exclus")


def jetons(caracteres):
    return round(caracteres / 4)


def choisir_symboles(graphe, n=10):
    """Les n symboles de code les plus reliés (identifiants simples, un par libellé), le plus relié d'abord."""
    degre = collections.Counter()
    for lien in graphe.get("links", graphe.get("edges", [])):
        degre[lien["source"]] += 1
        degre[lien["target"]] += 1
    candidats = []
    for noeud in graphe.get("nodes", []):
        libelle = noeud.get("label", "")
        if (noeud.get("file_type") != "code" or not IDENTIFIANT.match(libelle)
                or not SOURCE.search(noeud.get("source_file", "")) or TEST.search(noeud.get("source_file", ""))):
            continue
        candidats.append((-degre[noeud["id"]], libelle, noeud.get("source_file", "")))
    candidats.sort()
    retenus, vus = [], set()
    for _, libelle, fichier in candidats:
        if libelle not in vus:
            vus.add(libelle)
            retenus.append({"symbole": libelle, "fichier": fichier})
        if len(retenus) == n:
            break
    return retenus


def fichiers_affectes(sortie):
    """Fichiers cités par `affected` (une ligne = `- nom [relation] chemin:L12`), sans doublon."""
    return {m.group(1) for ligne in sortie.splitlines() if (m := FICHIER_AFFECTE.search(ligne))}


def analyser_grep(sortie):
    """(fichiers, lignes de commentaire) d'une sortie `git grep -n` (`chemin:ligne:texte`)."""
    fichiers, commentaires = set(), 0
    for ligne in sortie.splitlines():
        morceaux = ligne.split(":", 2)
        if len(morceaux) < 3:
            continue
        fichiers.add(morceaux[0])
        if COMMENTAIRE.match(morceaux[2]):
            commentaires += 1
    return fichiers, commentaires


def commande_grep(symbole):
    """La baseline : `git grep -nwI` du symbole, hors sortie du graphe et hors dossiers générés."""
    return ["git", "grep", "-nwI", "--no-color", symbole, "--", ":!graphify-out", *GENERES]


def ecarter_lignes_geantes(sortie, longueur_max=LIGNE_MAX_GREP):
    """(sortie de git grep sans les lignes de plus de longueur_max caractères, nombre de lignes écartées).
    Une ligne géante est du code minifié ou généré : un agent ne la lit pas, et elle gonflait la baseline."""
    gardees, ecartees = [], 0
    for ligne in sortie.splitlines(keepends=True):
        if len(ligne) > longueur_max:
            ecartees += 1
        else:
            gardees.append(ligne)
    return "".join(gardees), ecartees


def resume_structure(cycles, surprenants):
    """(nombre de cycles d'import, au plus 5 exemples, nombre de liens surprenants plafonné) ; null si non mesuré."""
    if cycles is None or surprenants is None:
        return None, None, None
    return len(cycles), [c["cycle"] for c in cycles[:5]], min(len(surprenants), PLAFOND_SURPRENANTS)


def mesurer_structure(chemin_graphe):
    """Cycles d'import et liens surprenants du graphe, par graphifyy (déterministe, 0 jeton) ; null si indisponible."""
    try:
        from graphify.analyze import find_import_cycles, surprising_connections
        from graphify.paths import load_node_link_graph
        G = load_node_link_graph(chemin_graphe)
        communautes = {}
        for noeud, attributs in G.nodes(data=True):
            if attributs.get("community") is not None:
                communautes.setdefault(int(attributs["community"]), []).append(noeud)
        cycles = find_import_cycles(G, max_cycle_length=5, top_n=1000)
        surprenants = surprising_connections(G, communautes, top_n=PLAFOND_SURPRENANTS)
    except Exception as e:  # paquet absent ou graphe illisible : la mesure est facultative
        print(f"::warning::structure du graphe non mesurée : {e}", file=sys.stderr)
        return None, None, None
    return resume_structure(cycles, surprenants)


def est_code(chemin):
    """Fichier de code hors documentation et hors tests : le périmètre du rappel (les tests restent dans grep_jetons)."""
    return SOURCE.search(chemin) is not None and TEST.search(chemin) is None


def ligne_banc(symbole, fichier, sortie_graphe, ms_graphe, sortie_grep, ms_grep, grep_exclus=None):
    """Une ligne du banc. Toute entrée None (appel échoué) laisse sa mesure à null."""
    ligne = {"symbole": symbole, "fichier": fichier, **{c: None for c in CHAMPS_BANC}}
    if sortie_graphe is not None:
        code_graphe = {f for f in fichiers_affectes(sortie_graphe) if est_code(f)}
        ligne.update(graphe_caracteres=len(sortie_graphe), graphe_jetons=jetons(len(sortie_graphe)),
                     graphe_ms=ms_graphe, fichiers_graphe=len(code_graphe))
    if sortie_grep is not None:
        fichiers, commentaires = analyser_grep(sortie_grep)
        code_grep = {f for f in fichiers if est_code(f)}
        ligne.update(grep_caracteres=len(sortie_grep), grep_jetons=jetons(len(sortie_grep)), grep_ms=ms_grep,
                     fichiers_grep=len(code_grep), grep_commentaires=commentaires, grep_exclus=grep_exclus)
    if sortie_graphe is not None and sortie_grep is not None:
        communs = code_graphe & code_grep
        ligne.update(fichiers_communs=len(communs), graphe_en_plus=len(code_graphe - code_grep),
                     grep_en_plus=len(code_grep - code_graphe),
                     rappel=round(len(communs) / len(code_grep), 3) if code_grep else None)
    return ligne


def totaux(banc):
    """Agrégats sur les lignes entièrement mesurées ; null s'il n'y en a aucune."""
    mesurees = [l for l in banc if l["graphe_jetons"] is not None and l["grep_jetons"] is not None]
    if not mesurees:
        return {"lignes_mesurees": 0, "graphe_jetons": None, "grep_jetons": None, "economie_jetons": None,
                "rappel_moyen": None, "graphe_ms_median": None, "grep_ms_median": None}
    g = sum(l["graphe_jetons"] for l in mesurees)
    r = sum(l["grep_jetons"] for l in mesurees)
    rappels = [l["rappel"] for l in mesurees if l["rappel"] is not None]
    return {
        "lignes_mesurees": len(mesurees),
        "graphe_jetons": g,
        "grep_jetons": r,
        "economie_jetons": round(1 - g / r, 3) if r else None,
        "rappel_moyen": round(sum(rappels) / len(rappels), 3) if rappels else None,
        "graphe_ms_median": round(statistics.median(l["graphe_ms"] for l in mesurees)),
        "grep_ms_median": round(statistics.median(l["grep_ms"] for l in mesurees)),
    }


def taille(graphe, meta, duree_construction, structure=(None, None, None)):
    noeuds = graphe.get("nodes", [])
    liens = graphe.get("links", graphe.get("edges", []))
    fichiers = {n["source_file"] for n in noeuds if n.get("source_file")}
    langages = collections.Counter(f.rsplit(".", 1)[1].lower() for f in fichiers if "." in f.rsplit("/", 1)[-1])
    code = {f for f in fichiers if est_code(f)}
    return {
        "noeuds": len(noeuds),
        "aretes": len(liens),
        "fichiers": len(fichiers),
        "communautes": len({n["community"] for n in noeuds if n.get("community") is not None}),
        "langages": dict(langages.most_common(8)),
        "page_noeuds": meta.get("noeuds") if meta else None,
        "hors_page": max(len(code) - meta["noeuds"], 0) if meta and isinstance(meta.get("noeuds"), int) else None,
        "construction_s": duree_construction,
        "cycles_import": structure[0],
        "liens_surprenants": structure[2],
    }


def valider(impact):
    """Liste des écarts au schéma impact-v1 (vide = valide). Une valeur non mesurée est `null`, rien d'autre."""
    ecarts = []

    def nombre(chemin, v, nullable=True, negatif=False):
        if v is None:
            if not nullable:
                ecarts.append(f"{chemin} : null interdit")
        elif isinstance(v, bool) or not isinstance(v, (int, float)) or (isinstance(v, float) and not math.isfinite(v)) or (v < 0 and not negatif):
            ecarts.append(f"{chemin} : nombre positif ou null attendu, reçu {v!r}")

    if impact.get("version") != VERSION:
        ecarts.append(f"version : {VERSION} attendue")
    for cle in ("depot", "sha", "genereLe"):
        if not isinstance(impact.get(cle), str) or not impact.get(cle):
            ecarts.append(f"{cle} : texte non vide attendu")
    for cle, v in (impact.get("taille") or {}).items():
        if cle != "langages":
            nombre(f"taille.{cle}", v)
    for cle in ("noeuds", "aretes", "fichiers", "communautes"):
        nombre(f"taille.{cle}", (impact.get("taille") or {}).get(cle), nullable=False)
    for cle, v in ((impact.get("taille") or {}).get("langages") or {}).items():
        nombre(f"taille.langages.{cle}", v, nullable=False)
    exemples = impact.get("cycles_exemples")
    if exemples is not None and not (isinstance(exemples, list) and len(exemples) <= 5 and all(
            isinstance(c, list) and c and all(isinstance(f, str) for f in c) for c in exemples)):
        ecarts.append("cycles_exemples : null ou 5 listes de chemins au plus attendues")
    banc = impact.get("banc")
    if not isinstance(banc, list) or len(banc) > 10:
        ecarts.append("banc : liste de 10 lignes au plus attendue")
        banc = []
    for i, l in enumerate(banc):
        for cle in ("symbole", "fichier"):
            if not isinstance(l.get(cle), str):
                ecarts.append(f"banc[{i}].{cle} : texte attendu")
        for cle in CHAMPS_BANC:
            if cle not in l:
                ecarts.append(f"banc[{i}].{cle} : champ absent")
            else:
                nombre(f"banc[{i}].{cle}", l[cle])
        if isinstance(l.get("rappel"), (int, float)) and l["rappel"] > 1:
            ecarts.append(f"banc[{i}].rappel : entre 0 et 1")
    for cle, v in (impact.get("totaux") or {}).items():
        nombre(f"totaux.{cle}", v, negatif=cle == "economie_jetons")  # négative si le graphe coûte plus que grep
    if not isinstance(impact.get("totaux"), dict):
        ecarts.append("totaux : objet attendu")
    return ecarts


def lancer(commande, **options):
    """(sortie, millisecondes), ou (None, None) si la commande échoue ou dépasse le délai : jamais une valeur inventée."""
    debut = time.monotonic()
    try:
        r = subprocess.run(commande, capture_output=True, text=True, timeout=DELAI, **options)
    except (subprocess.TimeoutExpired, OSError) as e:
        print(f"::warning::{commande[:3]} : {e}", file=sys.stderr)
        return None, None
    ms = round((time.monotonic() - debut) * 1000)
    if r.returncode not in (0, 1):  # git grep rend 1 quand rien n'est trouvé
        print(f"::warning::{commande[:3]} a rendu {r.returncode} : {r.stderr.strip()[:200]}", file=sys.stderr)
        return None, None
    return r.stdout, ms


def construire(graphe, meta, depot, sha, duree_construction, banc_n, maintenant, structure=(None, None, None)):
    banc = []
    for s in choisir_symboles(graphe, banc_n):
        sortie_graphe, ms_graphe = lancer(["bash", "scripts/graphe.sh", "affected", s["symbole"]])
        sortie_grep, ms_grep = lancer(commande_grep(s["symbole"]))
        exclus = None
        if sortie_grep is not None:
            sortie_grep, exclus = ecarter_lignes_geantes(sortie_grep)
        banc.append(ligne_banc(s["symbole"], s["fichier"], sortie_graphe, ms_graphe, sortie_grep, ms_grep, exclus))
    return {
        "version": VERSION,
        "depot": depot,
        "sha": sha,
        "genereLe": maintenant,
        "methode": ("jetons estimes = caracteres / 4 ; affected (scripts/graphe.sh) contre git grep -w, hors dist/build/.next/"
                    "coverage/node_modules et hors lignes de plus de 1000 caracteres (baseline changee le 22/10/2026) ; null = non mesure"),
        "taille": taille(graphe, meta, duree_construction, structure),
        "cycles_exemples": structure[1],
        "banc": banc,
        "totaux": totaux(banc),
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("graphe")
    ap.add_argument("sortie")
    ap.add_argument("--depot", default="")
    ap.add_argument("--sha", default="")
    ap.add_argument("--duree-construction", type=float, default=None)
    ap.add_argument("--meta", default="")
    ap.add_argument("--banc", type=int, default=10)
    a = ap.parse_args()

    graphe = json.load(open(a.graphe, encoding="utf-8"))
    meta = json.load(open(a.meta, encoding="utf-8")) if a.meta and os.path.exists(a.meta) else None
    maintenant = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    impact = construire(graphe, meta, a.depot, a.sha, a.duree_construction, a.banc, maintenant, mesurer_structure(a.graphe))
    ecarts = valider(impact)
    if ecarts:
        print("impact.json invalide :\n- " + "\n- ".join(ecarts), file=sys.stderr)
        return 1
    texte = json.dumps(impact, ensure_ascii=False, indent=2) + "\n"
    if len(texte.encode("utf-8")) >= 1048576:
        print("impact.json dépasse 1 Mo.", file=sys.stderr)
        return 1
    open(a.sortie, "w", encoding="utf-8").write(texte)
    t = impact["totaux"]
    print(f"{a.sortie} : {t['lignes_mesurees']}/{len(impact['banc'])} symboles mesurés, "
          f"économie de jetons {t['economie_jetons']}, rappel moyen {t['rappel_moyen']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
