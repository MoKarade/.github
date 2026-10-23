#!/usr/bin/env python3
# tour.py (16/10/2026) : UN tour du relevé du Gantt, en Python seul, pour le PC de Marc (tâche Windows cachée toutes les 10 min).
# Pourquoi : la boucle du conteneur Claude (boucle.sh + refresh.sh) meurt à chaque recyclage de la machine, et la relancer coûte
# du quota Claude (Marc, 16/10 : « je veux pas une routine qui tourne et qui demande des quotas »). Même logique que refresh.sh,
# sans bash ni find ni timeout, pour tourner sous Windows comme sous Linux.
#   1. relevé GitHub (fetch.py) : léger si un relevé plein a moins d'1 h, sinon plein ; quotas (quota.py) à chaque tour, complets 1×/h
#   2. build.py : prochaines.json, donnees.json
#   3. fiabilité (verif-fidelite.mjs de MoKarade/.github) : mesure complète si la précédente a plus de 55 min, sinon instantané de file seul
#   4. filet (filet-pc.mjs de MoKarade/.github, tâche #196) : un dépôt libre avec une tâche prenable et sans lancement depuis plus de
#      30 min réveille le Coordinateur (boite-reacteur.yml d'app-template, avec le jeton gh du PC) ; aucun appel Claude
#   0. réponses de Marc (reponses.py) : ce qu'il a coché dans l'onglet « À toi », déposé par la page dans le même dossier Drive, appliqué sur
#      GitHub avec le jeton gh du PC, puis réveil du Coordinateur ; avant le relevé, pour qu'il en voie déjà l'effet
#   5. dépôt dans le dossier Google Drive synchronisé (--drive DOSSIER) : donnees.json.gz (lu par la page), prochaines.json,
#      fiabilite.json, quota.json, etat.json. Les fichiers sont RÉÉCRITS SUR PLACE : Drive garde alors le même identifiant.
#   5 bis. envoi au hub (pousser_hub.py, .github#544) : POST https://www.hubperso.com/api/gantt, secret lu dans C:\dev\_pc-local\gantt-secret.txt, jamais bloquant
# Freins : le jeton du PC est celui de Marc, partagé avec tout le reste de son compte (5 000 appels/h). Sous 1 500 appels restants, tour
# économe (relevé léger, quotas rapides, pas de mesure de fiabilité) ; sous 3 500, quotas Claude et coût API seuls ; sous 300, tour sauté ; « rate limit » au tour précédent = 30 min
# d'attente. Un seuil unique à 3 000 sautait des tours entiers dès que le compte servait ailleurs (PC de Marc, 16/10 : 1 911 restants).
# Lancer : python -X utf8 tour.py --drive "G:\Mon disque\_Gantt"   (un tour, puis sortie ; code 0 = OK ou tour sauté, 1 = échec)
import argparse, datetime, gzip, json, os, shutil, socket, subprocess, sys, time
import pousser_hub
import gestes, reponses      # gestes de Marc à jour (.github#478) ; reponses.appliquer écrit le commentaire « Fait » et retire qui:marc

D = os.path.dirname(os.path.abspath(__file__)) + os.sep
ENV = dict(os.environ, PYTHONUTF8='1')
ENV.setdefault('GANTT_CACHE_HTTP', D + '.cache-http')     # le cache ETag de ghcache.py ; /tmp n'existe pas sous Windows
PY, NODE = sys.executable, shutil.which('node') or 'node'
ETAT = D + 'boucle-etat.json'
ETAT_EXTRA = {}      # clés structurées ajoutées à etat.json par le tour en cours (ex. `gestes`, .github#478)


def maintenant(): return datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
# Les repères (.dernier-plein, .dernier-quota-plein) portent leur heure DANS le fichier : sur le dossier partagé du projet, changer la date
# d'un fichier est ignoré sans erreur (vu le 16/10 : .dernier-plein resté à 18:38 alors qu'il était touché à chaque tour).
def age_min(f):
    if not os.path.exists(D + f): return None
    try:
        with open(D + f, encoding='utf-8') as fh: t = datetime.datetime.fromisoformat(fh.read().strip().replace('Z', '+00:00')).timestamp()
    except (OSError, ValueError): t = os.path.getmtime(D + f)
    return (time.time() - t) / 60
def touche(f):
    with open(D + f, 'w', encoding='utf-8') as fh: fh.write(maintenant())
def age_mesure_min():
    # âge de la dernière MESURE de fiabilité, lu dans le fichier (calcule_le) et non dans sa date, pour la même raison
    try: return (time.time() - datetime.datetime.fromisoformat(lire('fiabilite.json')['calcule_le'].replace('Z', '+00:00')).timestamp()) / 60
    except (OSError, ValueError, KeyError, TypeError): return None
def lire(f):
    with open(D + f, encoding='utf-8') as fh: return json.load(fh)
def marque(f):
    try:
        with open(D + f, encoding='utf-8') as fh: return fh.read().strip() or None
    except OSError: return None
def plein_force(fid, deja, econome):
    # I2 (.github#116) : la dernière mesure a vu des écarts entre le relevé et GitHub (par exemple une PR liée perdue par un relevé léger). Un relevé plein relit tout et
    # les corrige : le prochain tour en fait un, UNE fois par mesure (`deja` = la mesure déjà traitée), sauf au tour économe (quota entamé). Rend le `calcule_le` de la mesure, ou None.
    if econome or not isinstance(fid, dict): return None
    ecarts = (fid.get('i2') or {}).get('ecarts')
    calcule = fid.get('calcule_le')
    return calcule if ecarts and calcule and calcule != deja else None


def lancer(cmd, log, delai, ajout=False):
    with open(D + log, 'a' if ajout else 'w', encoding='utf-8') as fh:
        try: return subprocess.run(cmd, cwd=D, env=ENV, stdout=fh, stderr=subprocess.STDOUT, timeout=delai).returncode
        except subprocess.TimeoutExpired: fh.write(f'\ndélai de {delai} s dépassé\n'); return 124


def queue(log, n=300):
    try:
        with open(D + log, encoding='utf-8', errors='replace') as fh: return ' '.join(fh.read()[-n:].split())
    except OSError: return ''


def ecrire_etat(debut, res):
    d = {'pid': os.getpid(), 'machine': socket.gethostname(), 'dernier_tour': debut, 'prochain_tour': None, 'resultat': res,
         'periode_s': 600, 'ecrit': maintenant(), 'moteur': 'tour.py (tâche Windows)', **ETAT_EXTRA}
    with open(ETAT + '.tmp', 'w', encoding='utf-8') as fh: json.dump(d, fh, ensure_ascii=False)
    os.replace(ETAT + '.tmp', ETAT)
    with open(D + 'releve-erreur.txt', 'w', encoding='utf-8') as fh: fh.write(res + '\n')


def sur_place(src, dst, gz=False):
    # Réécrire le contenu du fichier existant plutôt que le remplacer : le client Drive garde le même fichier (même identifiant).
    with open(src, 'rb') as fh: b = fh.read()
    if gz: b = gzip.compress(b, 9, mtime=0)
    with open(dst, 'r+b' if os.path.exists(dst) else 'wb') as fh: fh.seek(0); fh.write(b); fh.truncate()


def releve(econome=False, quota_complet=True, drive=None):
    # 0. réponses de Marc déposées par la page (onglet « À toi ») : appliquées AVANT le relevé, pour qu'il voie déjà leur effet
    rep = ''
    if drive and os.path.isdir(drive):
        lancer([PY, 'reponses.py', '--drive', drive], '.refresh-reponses.log', 300)
        rep = ' · ' + (queue('.refresh-reponses.log', 240) or 'réponses : sans sortie')
    # 1. relevé GitHub
    mode = 'plein'
    corrige = None
    try:
        recent = age_min('.dernier-plein') is not None and age_min('.dernier-plein') < 60
        if (recent or econome) and lire('backlog.json').get('v', 0) >= 10: mode = 'leger'
    except (OSError, ValueError): pass
    try: corrige = plein_force(lire('fiabilite.json'), marque('.corrige-i2'), econome)
    except (OSError, ValueError): pass
    if corrige and mode == 'leger': mode = 'plein (écarts I2)'
    args = [PY, 'fetch.py', '--sans-quota'] + (['--leger'] if mode == 'leger' else [])
    if lancer(args, '.refresh-fetch.log', 900) != 0:
        if mode == 'leger' and lancer([PY, 'fetch.py', '--sans-quota'], '.refresh-fetch.log', 900) == 0: mode = 'plein (léger en échec)'
        else: return 1, f'ÉCHEC {maintenant()} relevé GitHub ({mode}) : {queue(".refresh-fetch.log")}'
    if mode.startswith('plein'): touche('.dernier-plein')
    if corrige and mode.startswith('plein'):      # traité même si le plein était déjà prévu : la mesure suivante dira si les écarts demeurent
        with open(D + '.corrige-i2', 'w', encoding='utf-8') as fh: fh.write(corrige)
    rapide = econome or (age_min('.dernier-quota-plein') is not None and age_min('.dernier-quota-plein') < 55)
    # un échec de quota.py ne bloque pas le relevé, mais il se DIT dans etat.json : ignoré en silence, il a laissé le Drive sans quota.json
    # (et le frein de quota sans pourcentage) sans que rien ne le montre depuis le cloud (.github#188)
    quota = ''
    # jauges Claude et coût API seules (≈ 1 appel GitHub) quand le compte est entamé : à froid, toutes les jauges coûtent ≈ 2 900 appels
    # (mesuré le 17/10, cache ETag vide), de quoi vider le jeton de Marc. La jauge Claude est celle que lit le frein de quota.
    seule = [] if quota_complet else ['--seulement=claude,api']
    if lancer([PY, 'quota.py'] + (['--rapide'] if rapide else []) + seule, '.refresh-quota.log', 900) == 0:
        if not rapide and not seule: touche('.dernier-quota-plein')
    else: quota = ' · quota : ÉCHEC ' + queue('.refresh-quota.log', 200)
    # 2. file du script + données de la page
    if lancer([PY, 'build.py'], '.refresh-build.log', 600) != 0: return 1, f'ÉCHEC {maintenant()} build.py : {queue(".refresh-build.log")}'
    asof = lire('backlog.json')['asof']
    try: p = lire('prochaines.json')
    except (OSError, ValueError): p = {}
    if p.get('source_asof') != asof: return 1, f'ÉCHEC {maintenant()} prochaines.json non écrit pour le relevé {asof}'
    # 3. fiabilité : mesure complète au plus 1×/h (≈ 800 appels), sinon instantané de file (aucun appel GitHub, date du fichier gardée)
    fid = 'non mesurée'
    script = D + 'scripts-github/verif-fidelite.mjs'
    texte = open(script, encoding='utf-8').read() if os.path.exists(script) else ''
    a = age_mesure_min()
    if texte and not econome and (a is None or a >= 55):
        n = str(lire('donnees.json')['sante']['n'])
        i4 = ['--depuis-i4', '2026-10-16T19:48:00Z'] if '--depuis-i4' in texte else []
        if lancer([NODE, script, 'backlog.json', 'prochaines.json', '--sortie', 'fiabilite.json', '--defauts', n] + i4, '.refresh-fiab.log', 600) == 0:
            fid = ([l for l in open(D + '.refresh-fiab.log', encoding='utf-8', errors='replace').read().splitlines() if l.strip()] or ['mesurée'])[-1]
            if lancer([PY, 'build.py'], '.refresh-build.log', 600) != 0: return 1, f'ÉCHEC {maintenant()} build.py (2e passe) : {queue(".refresh-build.log")}'
        else: fid = 'ÉCHEC de la mesure : ' + queue('.refresh-fiab.log', 200)
    elif texte and '--snapshot-seulement' in texte:
        fid = f'mesure précédente reprise ({lire("fiabilite.json")["calcule_le"][11:16]}Z)'
        lancer([NODE, script, '--snapshot-seulement', 'prochaines.json', '--sortie', 'fiabilite.json'], '.refresh-fiab.log', 120, ajout=True)
    # 4. filet du PC : n'écrit rien sur la page ni sur le Drive ; sa ligne se lit dans etat.json. Un échec ne fait pas échouer le tour.
    filet = ''
    script_filet = D + 'scripts-github/filet-pc.mjs'
    if os.path.exists(script_filet):
        lancer([NODE, script_filet, 'prochaines.json', '--etat', 'filet-pc-etat.json', '--executer'], '.refresh-filet.log', 120)
        filet = ' · ' + (queue('.refresh-filet.log', 520) or 'filet PC : sans sortie')
    # 3 bis. gestes de Marc à jour (gestes.py, .github#478) : un « fait » clair de Marc retire `qui:marc` (même commentaire que le bouton « Fait »),
    # le reste est signalé dans etat.json et dans les deux listes. Un échec se DIT, il ne fait pas échouer le tour.
    ges = ''
    try:
        g = lire('donnees.json').get('gestes') or {}
        if g.get('erreur') or 'gestes' not in g: ges = f' · gestes : non calculés ({g.get("erreur", "absents du relevé")})'
        else:
            retirees, refus = gestes.retirer(g['a_retirer'], reponses.appliquer, datetime.datetime.now(datetime.timezone.utc))
            ligne, ETAT_EXTRA['gestes'] = gestes.resume(g, retirees, refus)
            ges = ' · ' + ligne
    except Exception as e: ges = f' · gestes : ÉCHEC {type(e).__name__} : {str(e)[:160]}'
    rep += ges
    p = lire('prochaines.json')
    file = ' '.join(d['depot'] + '=' + (d['suivante']['ref'] if d.get('suivante') else d['statut']) for d in p['depots'])
    # La mesure du quota Claude écrite par la tâche « Quota-Claude » : trop vieille, elle ne dit plus rien (le frein garde alors son palier ou,
    # après la remise à zéro, l'ignore : .github#319). Se DIT dans etat.json, sinon une tâche arrêtée ne se voit nulle part.
    fd = p.get('frein_detail') or {}
    if fd.get('apres_reset'): quota += ' · quota Claude : remise à zéro passée, mesure de la semaine précédente ignorée (frein normal)'
    elif (fd.get('age_heures') or 0) > 3: quota += f' · quota Claude : mesure vieille de {fd["age_heures"]} h (tâche Quota-Claude arrêtée ?)'
    rv = lire('backlog.json').get('relectures_vide')      # pages vides de GitHub relues pendant ce relevé (.github#494) : se DIT, une panne de lecture ne se devine pas
    relectures = '' if rv is None else f' · relectures de pages vides : {rv}'
    return 0, f'OK {maintenant()} relevé {mode} {asof} · prochaines.json {p["calcule_le"]} {file} · fiabilité : {fid}{relectures}{quota}{filet}{rep}'

# Drive absent (22/10/2026, .github#529) : le lecteur G: n'était plus monté de 18:31Z à 19:20Z ; le tour écrivait « OK » dans son état local puis
# plantait au dépôt (FileNotFoundError), et la page est restée 56 min sur le relevé de 18:25Z sans que rien ne le dise.
DRIVE_ETAT = D + '.drive-absent.json'
DRIVE_TOURS_AVANT_REVEIL = 2          # deux tours de suite sans dépôt (20 min) avant de réveiller le Coordinateur
DRIVE_RAPPEL_S = 4 * 3600             # puis un rappel toutes les 4 h tant que ça dure
DEPOT_BOITE, WORKFLOW_BOITE = 'MoKarade/app-template', 'boite-reacteur.yml'


def suivre_drive(etat, erreur, ts, reveiller):
    """Pure (sauf `reveiller`, qui renvoie True si le réveil est parti). Renvoie le nouvel état du suivi.
    `etat` : {'tours': n, 'depuis': ts, 'reveille': ts}. Un réveil raté n'est pas enregistré : le tour suivant réessaie."""
    if not erreur: return {'tours': 0}
    tours = int((etat or {}).get('tours') or 0) + 1
    nouveau = {'tours': tours, 'depuis': (etat or {}).get('depuis') or ts, 'reveille': (etat or {}).get('reveille')}
    if tours >= DRIVE_TOURS_AVANT_REVEIL and (nouveau['reveille'] is None or ts - nouveau['reveille'] >= DRIVE_RAPPEL_S):
        depuis = datetime.datetime.fromtimestamp(nouveau['depuis'], datetime.timezone.utc).strftime('%Y-%m-%dT%H:%MZ')
        texte = f'RÉACTEUR : Drive absent depuis {tours} tours (depuis {depuis}) : le relevé de la page est figé, vérifier que le lecteur Google Drive est monté sur le PC'
        if reveiller(texte): nouveau['reveille'] = ts
    return nouveau


def reveiller_boite(texte):
    # Même route que scripts/filet-pc.mjs : boite-reacteur.yml commente app-template#58 en github-actions[bot], ce qui réveille le Coordinateur.
    try:
        r = subprocess.run(['gh', 'workflow', 'run', WORKFLOW_BOITE, '--repo', DEPOT_BOITE, '--ref', 'main', '-f', f'texte={texte}'],
                           env=ENV, capture_output=True, text=True, timeout=60)
        return r.returncode == 0
    except (OSError, subprocess.TimeoutExpired): return False


def deposer_drive(drive, code):
    """Dépose les sorties dans le dossier Drive. Renvoie '' si tout est écrit, sinon la raison (lecteur non monté, dossier refusé…)."""
    try:
        os.makedirs(drive, exist_ok=True)
        if code == 0:
            sur_place(D + 'donnees.json', os.path.join(drive, 'donnees.json.gz'), gz=True)
            for f in ('prochaines.json', 'fiabilite.json', 'quota.json', 'boucle-etat.json', 'gestes-de-marc.md', 'a-faire-maintenant.md'):
                if os.path.exists(D + f): sur_place(D + f, os.path.join(drive, 'etat.json' if f == 'boucle-etat.json' else f))
        else:
            sur_place(ETAT, os.path.join(drive, 'etat.json'))   # un échec se voit aussi depuis la page
    except OSError as e: return f'{type(e).__name__} : {e}'
    return ''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--drive', help='dossier Google Drive synchronisé où déposer les sorties')
    o = ap.parse_args()
    debut = maintenant()
    verrou = D + '.tour.lock'
    try: os.mkdir(verrou)
    except FileExistsError:
        if time.time() - os.path.getmtime(verrou) < 20 * 60: print('déjà en cours'); return 0
        os.utime(verrou)                      # reste d'un plantage : on le reprend
    t0 = time.time()
    try:
        try: precedent = lire('boucle-etat.json')
        except (OSError, ValueError): precedent = {}
        try: ecrit = datetime.datetime.fromisoformat(precedent['ecrit'].replace('Z', '+00:00')).timestamp()
        except (KeyError, ValueError, AttributeError): ecrit = 0
        if 'rate limit' in str(precedent.get('resultat', '')).lower() and time.time() - ecrit < 30 * 60:
            print('tour sauté : limite d\'API au tour précédent'); return 0
        try:
            reste = int(subprocess.run(['gh', 'api', 'rate_limit', '--jq', '.resources.core.remaining'], env=ENV,
                                       capture_output=True, text=True, timeout=60).stdout.strip() or 99999)
        except (OSError, ValueError, subprocess.TimeoutExpired): reste = 99999
        if reste < 300: code, res = 0, f'tour sauté : {reste} appels GitHub restants dans l\'heure'
        else:
            code, res = releve(econome=reste < 1500, quota_complet=reste >= 3500, drive=o.drive)
            if code == 0 and reste < 1500: res += f' · tour économe ({reste} appels restants)'
            res = res.replace(f'relevé ', f'relevé en {int(time.time() - t0)} s, ', 1) if code == 0 else res
        ecrire_etat(debut, res)
        print(res)
        if code == 0 and not res.startswith('tour sauté'):
            # 5 bis. envoi au hub (tâche .github#544) : l'onglet « Chantier Apps » lit ce que le hub a reçu. Jamais bloquant : le résultat ne change pas
            # le code du tour, il se DIT dans la ligne (secret absent, 401, 503…), et le Drive reste la copie de secours.
            res += ' · ' + pousser_hub.pousser(D, os.environ.get('GANTT_SECRET_FILE') or pousser_hub.SECRET_PAR_DEFAUT)
            ecrire_etat(debut, res)
            print(res)
        if o.drive:
            try: suivi = lire('.drive-absent.json')
            except (OSError, ValueError): suivi = {}
            erreur = deposer_drive(o.drive, code)
            if not erreur and suivi.get('tours'):
                res += f' · Drive : de retour après {suivi["tours"]} tour(s) sans dépôt'
                ecrire_etat(debut, res)
                erreur = deposer_drive(o.drive, 1)         # etat.json seul, avec la ligne de retour
            suivi = suivre_drive(suivi, erreur, time.time(), reveiller_boite)
            with open(DRIVE_ETAT, 'w', encoding='utf-8') as fh: json.dump(suivi, fh)
            if erreur:
                res += f' · DRIVE ABSENT depuis {suivi["tours"]} tour(s) : {erreur}'
                ecrire_etat(debut, res)
                print(res)
                return 1
        return code
    finally:
        shutil.rmtree(verrou, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())
