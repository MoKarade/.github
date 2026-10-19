#!/usr/bin/env python3
# reponses.py (19/10/2026) : applique sur GitHub les réponses que Marc donne depuis l'onglet « À toi » de la page de suivi.
# Demande de Marc (fil Page de suivi, 19/10 14:47Z) : « pour chaque, l'option de dire que c'est fait pour que ça enchaîne direct,
# ou alors des réponses préfaites si question ».
#
# Chemin : la page dépose `reponse-<horodatage>.json` dans le dossier Drive `_Gantt` (connecteur Google Drive de Marc) ; Google
# Drive pour ordinateur le recopie dans le dossier local que `tour.py` reçoit en `--drive`. Ce script, lancé par `tour.py` AVANT
# le relevé, l'applique avec le jeton `gh` du PC (le compte de Marc), puis réveille le Coordinateur par `boite-reacteur.yml`
# (un commentaire du compte de Marc ne réveille personne : GitHub ne notifie pas l'auteur).
#
#   fait      : commentaire « **Fait** — Marc, depuis la page de suivi (…) » + retrait de `qui:marc` (tâche ouverte qui l'a)
#   reponse   : commentaire « **Réponse de Marc** : <option> » + retrait de `qui:marc` ; l'option DOIT être une puce de la
#               section `**Réponses**` du corps de l'issue, relue ici : un fichier ne peut pas faire écrire un texte libre
#   fusionner : fusion squash d'une PR ouverte, hors brouillon
#
# Un fichier est traité une seule fois (journal `reponses-journal.json`, par id), puis supprimé du dossier, réussi ou non :
# un échec se lit dans le journal, que build.py embarque pour la page. Rien ici ne fait échouer le tour.
# Lancer seul : python -X utf8 reponses.py --drive "G:\Mon disque\_Gantt" [--a-blanc]
import argparse, datetime, glob, json, os, re, subprocess, sys

D = os.path.dirname(os.path.abspath(__file__)) + os.sep
JOURNAL = D + 'reponses-journal.json'
GARDER = 100
DEPOTS = {'.github', 'app-template', 'batchchef-', 'carai', 'driveai', 'financeai', 'hub-contract', 'hubperso', 'jobai', 'memoryai'}
GESTES = {'fait', 'reponse', 'fusionner'}
REF = re.compile(r'^([a-z0-9._-]+)#(\d{1,6})$')
DEPOT_BOITE, WORKFLOW_BOITE = 'MoKarade/app-template', 'boite-reacteur.yml'   # mêmes valeurs que scripts/reveil-reacteur.mjs
REPONSES = re.compile(r'^\s*\*\*\s*Réponses\s*(?:\*\*\s*:?|:\s*\*\*)\s*$(.*?)(?=^\s*\*\*[^*\n]{1,40}?(?:\*\*\s*:|:\s*\*\*)|\Z)', re.M | re.S | re.I)
PUCE = re.compile(r'^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$')


def options(body):
    """Les réponses préfaites d'une issue : une puce par option sous `**Réponses**`. Pure."""
    m = REPONSES.search(body or '')
    if not m: return []
    out = []
    for l in m.group(1).splitlines():
        p = PUCE.match(l)
        if p: out.append(re.sub(r'\s+', ' ', p.group(1))[:200])
    return out[:8]


def lire_demande(texte):
    """Valide le contenu d'un fichier déposé par la page. Rend (demande, erreur). Pure."""
    try: d = json.loads(texte)
    except ValueError: return None, 'fichier illisible'
    if not isinstance(d, dict): return None, 'fichier illisible'
    ref, geste, ident = str(d.get('ref', '')).lower(), d.get('geste'), str(d.get('id', ''))
    m = REF.match(ref)
    if not m or m.group(1) not in DEPOTS: return None, f'référence inconnue : {ref[:40]}'
    if geste not in GESTES: return None, f'geste inconnu : {str(geste)[:20]}'
    if not re.fullmatch(r'[A-Za-z0-9-]{6,40}', ident): return None, 'identifiant absent'
    texte_rep = d.get('texte')
    if geste == 'reponse' and not (isinstance(texte_rep, str) and texte_rep.strip()): return None, 'réponse vide'
    return {'id': ident, 'ref': ref, 'depot': m.group(1), 'n': int(m.group(2)), 'geste': geste,
            'texte': texte_rep.strip()[:200] if isinstance(texte_rep, str) else None, 'quand': str(d.get('quand', ''))[:30]}, None


def heure_quebec(t):
    try: from zoneinfo import ZoneInfo; z = ZoneInfo('America/Toronto')
    except Exception: z = datetime.timezone(datetime.timedelta(hours=-4))       # Windows sans base de fuseaux (.github#188)
    return t.astimezone(z).strftime('%d/%m %H:%M')


def plan(dem, objet, maintenant):
    """Les écritures GitHub à faire pour une demande, d'après l'objet relu (issue ou PR). Rend (actions, erreur). Pure."""
    if dem['geste'] == 'fusionner':
        if 'head' not in objet: return [], 'ce n\'est pas une PR'
        if objet.get('state') != 'open': return [], 'PR déjà fermée'
        if objet.get('draft'): return [], 'PR en brouillon'
        return [('fusion', None)], None
    if 'pull_request' in objet: return [], 'c\'est une PR, pas une tâche'
    if objet.get('state') != 'open': return [], 'tâche déjà fermée'
    labels = {l['name'] for l in objet.get('labels', [])}
    if 'qui:marc' not in labels: return [], 'la tâche n\'attend plus Marc'
    h = heure_quebec(maintenant)
    if dem['geste'] == 'fait':
        corps = f'**Fait** — Marc, depuis la page de suivi ({h}, heure du Québec).'
    else:
        opts = options(objet.get('body'))
        if dem['texte'] not in opts: return [], 'réponse absente de la section « Réponses » de l\'issue'
        corps = f'**Réponse de Marc** : {dem["texte"]}\n\n_Depuis la page de suivi ({h}, heure du Québec)._'
    return [('commentaire', corps), ('retirer', 'qui:marc')], None


def motif(faits):
    """Le texte du réveil : les tâches et ce que Marc a fait, jamais le texte d'une réponse. Pure."""
    mots = {'fait': 'fait', 'reponse': 'répondu', 'fusionner': 'fusionné'}
    return ('RÉACTEUR : Marc depuis la page : ' + ' ; '.join(f'{mots[g]} {r}' for r, g in faits))[:300]


def gh(*args, entree=None):
    r = subprocess.run(['gh', *args], input=entree, capture_output=True, text=True, timeout=60)
    if r.returncode != 0: raise RuntimeError(' '.join((r.stderr or r.stdout).split())[:160])
    return r.stdout


def appliquer(dem, maintenant):
    repo = f'MoKarade/{dem["depot"]}'
    chemin = f'repos/{repo}/pulls/{dem["n"]}' if dem['geste'] == 'fusionner' else f'repos/{repo}/issues/{dem["n"]}'
    objet = json.loads(gh('api', chemin))
    actions, err = plan(dem, objet, maintenant)
    if err: return False, err
    for quoi, val in actions:
        if quoi == 'fusion':
            gh('api', '-X', 'PUT', f'repos/{repo}/pulls/{dem["n"]}/merge', '-f', 'merge_method=squash')
        elif quoi == 'commentaire':
            gh('api', '-X', 'POST', f'repos/{repo}/issues/{dem["n"]}/comments', '--input', '-', entree=json.dumps({'body': val}))
        elif quoi == 'retirer':
            gh('api', '-X', 'DELETE', f'repos/{repo}/issues/{dem["n"]}/labels/{val.replace(":", "%3A")}')
    return True, 'fusionnée' if dem['geste'] == 'fusionner' else 'appliqué'


def lire_journal():
    try:
        with open(JOURNAL, encoding='utf-8') as fh: j = json.load(fh)
        return j if isinstance(j, list) else []
    except (OSError, ValueError): return []


def ecrire_journal(j):
    with open(JOURNAL + '.tmp', 'w', encoding='utf-8') as fh: json.dump(j[-GARDER:], fh, ensure_ascii=False)
    os.replace(JOURNAL + '.tmp', JOURNAL)


def tour(drive, a_blanc=False):
    """Traite les fichiers déposés. Rend la ligne à afficher ; ne lève jamais."""
    try:
        fichiers = sorted(glob.glob(os.path.join(drive, 'reponse-*.json')))
        if not fichiers: return 'réponses : aucune'
        journal = lire_journal(); vus = {e.get('id') for e in journal}
        ok, ko, faits = 0, 0, []
        for f in fichiers[:20]:
            try:
                with open(f, encoding='utf-8') as fh: texte = fh.read()
            except OSError: continue                      # pas encore fini de se recopier : au tour suivant
            dem, err = lire_demande(texte)
            maintenant = datetime.datetime.now(datetime.timezone.utc)
            if a_blanc:
                print(os.path.basename(f), dem or err); continue
            if dem and dem['id'] in vus: os.remove(f); continue          # déjà traité (fichier resté après une coupure)
            e = {'id': (dem or {}).get('id') or os.path.basename(f), 'ref': (dem or {}).get('ref'), 'geste': (dem or {}).get('geste'),
                 'quand': (dem or {}).get('quand'), 'traite': maintenant.strftime('%Y-%m-%dT%H:%M:%SZ'), 'ok': False, 'msg': err}
            if dem:
                try: e['ok'], e['msg'] = appliquer(dem, maintenant)
                except (RuntimeError, ValueError, subprocess.TimeoutExpired) as x: e['msg'] = 'GitHub : ' + str(x)[:160]
            journal.append(e); ecrire_journal(journal); vus.add(e['id'])
            os.remove(f)
            if e['ok']: ok += 1; faits.append((e['ref'], e['geste']))
            else: ko += 1
        reveil = ''
        if faits:
            try: gh('workflow', 'run', WORKFLOW_BOITE, '--repo', DEPOT_BOITE, '--ref', 'main', '-f', f'texte={motif(faits)}'); reveil = ', réveil envoyé'
            except (RuntimeError, subprocess.TimeoutExpired) as x: reveil = f', réveil en ÉCHEC ({str(x)[:80]})'
        return f'réponses : {ok} appliquée(s), {ko} refusée(s){reveil}'
    except Exception as x:
        return f'réponses : ÉCHEC ({str(x)[:160]})'


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--drive', required=True)
    ap.add_argument('--a-blanc', action='store_true')
    o = ap.parse_args()
    print(tour(o.drive, o.a_blanc))
    sys.exit(0)
