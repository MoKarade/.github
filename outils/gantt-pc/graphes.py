# Impact de Graphify pour l'onglet Rythme (tâche .github#466, choix de Marc du 21/10/2026 20:23Z).
# Chaque push sur la branche par défaut d'un dépôt dépose l'artefact Actions « graphe » (90 jours) : meta.json et, depuis .github#465,
# impact.json (schéma impact-v1, décrit dans docs/graphe-code.md). Un artefact ne change plus : il est mémorisé par identifiant dans
# graphes_cache.json, et seuls ceux qui n'y sont pas encore sont téléchargés (au plus PAR_RELEVE par relevé, les plus récents d'abord).
# Seuls des nombres sont gardés : ni symbole ni chemin de fichier. Une valeur non mesurée reste None, jamais 0.
import io, json, subprocess, zipfile

PAR_RELEVE = 40
VERSION = 'impact-v1'
TAILLE = ('noeuds', 'aretes', 'fichiers', 'communautes', 'page_noeuds', 'hors_page', 'construction_s')
TOTAUX = (('lignes_mesurees', 'l'), ('graphe_jetons', 'gj'), ('grep_jetons', 'rj'), ('economie_jetons', 'eco'),
          ('rappel_moyen', 'rap'), ('graphe_ms_median', 'gms'), ('grep_ms_median', 'rms'))
# sommes sur le banc : dépendants indirects que grep ne donne pas, fichiers que le graphe manque, commentaires ramenés par grep
BANC = (('graphe_en_plus', 'plus'), ('grep_en_plus', 'manque'), ('grep_commentaires', 'com'))


def _nombre(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def _somme(lignes, champ):
    """Somme des valeurs mesurées ; None si aucune ligne n'a la mesure (rien de mesuré n'est pas 0)."""
    vals = [_nombre(l.get(champ)) for l in lignes if isinstance(l, dict)]
    vals = [v for v in vals if v is not None]
    return sum(vals) if vals else None


def resume_impact(impact):
    """impact.json -> {..} compact, ou None si absent ou d'une autre version que impact-v1."""
    if not isinstance(impact, dict) or impact.get('version') != VERSION: return None
    taille = impact.get('taille') if isinstance(impact.get('taille'), dict) else {}
    totaux = impact.get('totaux') if isinstance(impact.get('totaux'), dict) else {}
    banc = impact.get('banc') if isinstance(impact.get('banc'), list) else []
    out = {k: _nombre(taille.get(k)) for k in TAILLE}
    out.update({court: _nombre(totaux.get(long)) for long, court in TOTAUX})
    out.update({court: _somme(banc, long) for long, court in BANC})
    return out


def entree(cle, art, contenu):
    """Un artefact (élément de actions/artifacts) et le contenu de son zip -> entrée du relevé.
    `contenu` None ou zip illisible : 'err' le dit, l'impact reste None."""
    run = art.get('workflow_run') or {}
    e = {'r': cle, 'id': art['id'], 't': art.get('created_at'), 'sha': (run.get('head_sha') or '')[:7] or None,
         'run': run.get('id'), 'meta': None, 'impact': None}
    try:
        z = zipfile.ZipFile(io.BytesIO(contenu))
        noms = set(z.namelist())
        if 'meta.json' in noms:
            m = json.loads(z.read('meta.json'))
            e['meta'] = {'noeuds': _nombre(m.get('noeuds')), 'aretes': _nombre(m.get('aretes')), 'genereLe': m.get('genereLe')}
        if 'impact.json' in noms:
            brut = json.loads(z.read('impact.json'))
            e['impact'] = resume_impact(brut)
            if e['impact'] is None: e['err'] = 'version'
    except (zipfile.BadZipFile, TypeError, ValueError, KeyError):
        e['err'] = 'zip'
    return e


def a_telecharger(artefacts, cache, n=PAR_RELEVE):
    """Artefacts « graphe » encore téléchargeables et pas encore mémorisés, du plus récent au plus ancien, n au plus."""
    neufs = [a for a in artefacts if a.get('name') == 'graphe' and not a.get('expired') and str(a['id']) not in cache]
    return sorted(neufs, key=lambda a: a.get('created_at') or '', reverse=True)[:n]


def telecharger(depot, ident):
    """Zip d'un artefact par `gh api` (le jeton du PC). None en cas d'échec : rien n'est mémorisé, le relevé suivant réessaie."""
    r = subprocess.run(['gh', 'api', f'repos/MoKarade/{depot}/actions/artifacts/{ident}/zip'], capture_output=True, timeout=120)
    return r.stdout if r.returncode == 0 and r.stdout[:2] == b'PK' else None


def relever(depots, lire, cache, charger=telecharger, n=PAR_RELEVE):
    """depots = [(dépôt, clé)] ; lire(chemin) -> JSON (ghcache.lire). Met `cache` à jour sur place et rend (liste triée, nombre téléchargés, erreurs).
    Une liste illisible garde les entrées déjà mémorisées du dépôt ; un artefact disparu de la liste (expiré) sort du cache."""
    vus, lus, erreurs = set(), 0, []
    for depot, cle in depots:
        try:
            arts = (lire(f'repos/MoKarade/{depot}/actions/artifacts?name=graphe&per_page=100') or {}).get('artifacts') or []
        except RuntimeError as ex:
            erreurs.append(f'{depot} : {ex}'[:200])
            vus |= {k for k, v in cache.items() if v.get('r') == cle}
            continue
        vus |= {str(a['id']) for a in arts if not a.get('expired')}
        for a in a_telecharger(arts, cache, max(0, n - lus)):
            contenu = charger(depot, a['id'])
            lus += 1
            if contenu is None: erreurs.append(f'{depot} artefact {a["id"]} non téléchargé'); continue
            cache[str(a['id'])] = entree(cle, a, contenu)
    for k in [k for k in cache if k not in vus]: del cache[k]
    return sorted(cache.values(), key=lambda e: e.get('t') or ''), lus, erreurs
