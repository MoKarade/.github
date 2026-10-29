#!/usr/bin/env python3
# missions.py (26/10/2026, tâche .github#591) : la durée d'une mission vient de ses tâches, et une mission finie se ferme toute seule.
# Demande de Marc (26/10/2026 17:49Z) : « la durée des missions correspond pas à la durée des tâches… mettre ça au propre et rendre plus solide
# par rapport au réel », choix « Calculé + mission qui se ferme » (17:53Z). Mesure du relevé de 15:11Z : 64 missions sur 64 sans début réel
# (la barre partait de la création de l'issue), 9 missions fermées à plus de 24 h de leur dernière tâche, 8 ouvertes alors que tout était fini.
#
#   deriver : pour chaque mission et chantier, `deb` (première tâche réellement commencée), `fin` (dernière fermeture, SEULEMENT si toutes les
#             tâches sont fermées), `nt` / `nf` (tâches, tâches fermées), `inc` (enfants absents du relevé : alors `fin` reste vide).
#             Aucun appel d'API, aucune étiquette : une mission `en-cours` compterait comme un travail du dépôt.
#   a_fermer: les missions ouvertes dont tous les enfants sont fermés depuis FERMER_APRES_H heures au moins, dont un au moins `completed`.
#   fermer  : commentaire « Acceptée » puis fermeture `completed`, avec le jeton `gh` du PC (comme reponses.py). Relit l'issue avant d'écrire
#             (déjà fermée ou `sub_issues_summary` qui ne dit pas « tout fermé » : on ne touche à rien). Au plus PAR_TOUR par tour.
# Fonctions pures d'un côté (deriver, a_fermer, commentaire), écritures de l'autre (fermer, avec `gh` injecté).
import datetime, json

FERMER_APRES_H = 24     # le Coordinateur a un jour pour ajouter une tâche à une mission dont tout semble fini
PAR_TOUR = 10           # borne : un tour qui fermerait plus de missions que cela s'est trompé de cible, le reste attend le tour suivant


def _iso(t): return datetime.datetime.fromisoformat(t.replace('Z', '+00:00'))


def _ref(depot, k): return k.lower() if isinstance(k, str) else f'{depot.lower()}#{k}'


def indexer(repos):
    """{ref en minuscules: (dépôt, nœud)} pour tout le relevé brut (`gh['repos']` de build.py). Pure."""
    return {f"{r['repo'].lower()}#{n['n']}": (r['repo'], n) for r in repos for n in r['nodes'].values()}


def debut(t):
    """Quand une tâche a réellement commencé : sa première étape `cours`, sinon son début, sinon (tâche fermée d'un seul geste) sa création. Pure."""
    for e in t.get('et') or []:
        if e[0] == 'cours': return e[1]
    return t.get('start') or (t.get('created') if t.get('state') == 'closed' else None)


def taches(idx, depot, n, vus=None):
    """Les tâches descendantes d'un nœud (missions imbriquées comprises) et le nombre d'enfants absents du relevé. Pure."""
    vus = set() if vus is None else vus
    out, inconnus = [], 0
    for k in n.get('kids') or []:
        ref = _ref(depot, k)
        if ref in vus: continue
        vus.add(ref)
        if ref not in idx: inconnus += 1; continue
        d2, f = idx[ref]
        if f['lvl'] == 'tâche': out.append(f)
        else:
            sous, i2 = taches(idx, d2, f, vus)
            out += sous; inconnus += i2
    return out, inconnus


def deriver(repos):
    """{ref: {deb, fin, nt, nf, inc}} pour chaque mission et chantier. `deb` : la plus ancienne des tâches commencées (None si aucune) ;
    `fin` : la dernière fermeture, seulement si TOUTES les tâches sont fermées et qu'aucun enfant ne manque (sinon None). Pure."""
    idx = indexer(repos)
    res = {}
    for ref, (depot, n) in idx.items():
        if n['lvl'] == 'tâche': continue
        ts, inc = taches(idx, depot, n)
        debuts = [d for d in map(debut, ts) if d]
        fermees = [t for t in ts if t['state'] == 'closed' and t.get('closed')]
        tout = bool(ts) and inc == 0 and len(fermees) == len(ts)
        res[ref] = {'deb': min(debuts) if debuts else None, 'fin': max(t['closed'] for t in fermees) if tout else None,
                    'nt': len(ts), 'nf': len(fermees), 'inc': inc}
    return res


def a_fermer(repos, maintenant, apres_h=FERMER_APRES_H):
    """Les missions à fermer : ouvertes, sans geste de Marc en attente, dont TOUS les enfants directs sont fermés (aucun absent du relevé, aucun
    rouvert pour preuve manquante) depuis `apres_h` heures au moins, un au moins `completed`. Les plus anciennes d'abord. Pure."""
    idx = indexer(repos)
    out = []
    for ref, (depot, n) in idx.items():
        if n['lvl'] != 'mission' or n['state'] != 'open' or not n.get('kids'): continue
        if {'qui:marc', 'bloqué', 'preuve-attendue'} & set(n.get('labels') or []): continue
        kids = [idx[_ref(depot, k)][1] if _ref(depot, k) in idx else None for k in n['kids']]
        if any(k is None or k['state'] != 'closed' or not k.get('closed') or 'preuve-manquante' in (k.get('labels') or []) for k in kids): continue
        acceptees = [k for k in kids if k.get('reason') == 'completed']
        if not acceptees: continue
        derniere = max(kids, key=lambda k: k['closed'])
        if (maintenant - _iso(derniere['closed'])).total_seconds() < apres_h * 3600: continue
        out.append({'ref': ref, 'depot': depot, 'n': n['n'], 'titre': n['title'], 'acceptees': len(acceptees), 'abandonnees': len(kids) - len(acceptees),
                    'derniere_ref': next(r for r, (_, f) in idx.items() if f is derniere), 'derniere': derniere['closed']})
    return sorted(out, key=lambda m: m['derniere'])


def heure_quebec(t):
    try: from zoneinfo import ZoneInfo; z = ZoneInfo('America/Toronto')
    except Exception: z = datetime.timezone(datetime.timedelta(hours=-4))       # Windows sans base de fuseaux (.github#188)
    return t.astimezone(z).strftime('%d/%m %H:%M')


def commentaire(m, asof):
    """Le commentaire « Acceptée » d'une mission fermée par le PC. Pure."""
    abandon = f" et {m['abandonnees']} abandonnée(s)" if m['abandonnees'] else ''
    return (f"**Acceptée** — mission finie : {m['acceptees']} tâche(s) acceptée(s){abandon}, la dernière ({m['derniere_ref']}) fermée le "
            f"{heure_quebec(_iso(m['derniere']))} (heure du Québec). preuve : chaque tâche a passé le garde-fou de preuve (§10 bis) avant sa fermeture ; "
            f"relevé du Gantt de {heure_quebec(_iso(asof))}, toutes ses tâches sont fermées depuis plus de {FERMER_APRES_H} h. Fermeture automatique par le PC "
            f"(décision de Marc, 26/10/2026 17:53Z, cycle de vie §1). Une tâche ajoutée plus tard : rouvrir la mission.")


def fermer(liste, asof, gh, a_blanc=False):
    """Ferme chaque mission de `liste` (au plus PAR_TOUR). `gh(*args, entree=None)` rend le texte de l'API ou lève RuntimeError. Rend (fermees, refus)."""
    fermees, refus = [], []
    for m in liste[:PAR_TOUR]:
        chemin = f"repos/MoKarade/{m['depot']}/issues/{m['n']}"
        try:
            vue = json.loads(gh('api', chemin))
            resume = vue.get('sub_issues_summary') or {}
            if vue.get('state') != 'open': refus.append(f"{m['ref']} (déjà fermée)"); continue
            if resume and resume.get('total') != resume.get('completed'): refus.append(f"{m['ref']} (GitHub : {resume.get('completed')}/{resume.get('total')} fermées)"); continue
            if a_blanc: fermees.append(m['ref'] + ' (à blanc)'); continue
            gh('api', '-X', 'POST', chemin + '/comments', '--input', '-', entree=json.dumps({'body': commentaire(m, asof)}))
            gh('api', '-X', 'PATCH', chemin, '--input', '-', entree=json.dumps({'state': 'closed', 'state_reason': 'completed'}))
            fermees.append(m['ref'])
        except (RuntimeError, ValueError, OSError) as e: refus.append(f"{m['ref']} ({str(e)[:100]})")
    return fermees, refus
