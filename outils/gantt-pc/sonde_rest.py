# Sonde du quota REST du jeton gh du PC (.github#741). Mesure DE QUI vient la consommation hors tour : le 28/10/2026 le quota a perdu 437 appels en 5,5 min alors
# qu'aucun tour ne tournait (tâches planifiées « Carnet questions », « Gemini-demandes », « NotebookLM », « Quota-Claude », sessions Claude ouvertes...).
# Lecture seule, UNE passe bornée (pas un minuteur : elle s'arrête seule) : lancée à la main par le fil PC, par exemple `python sonde_rest.py --duree 1200`.
# `gh api rate_limit` ne compte pas dans le quota. À chaque pas on note le restant `core` et les processus gh/git/python/node/PowerShell (nom + début de la
# ligne de commande, 160 caractères) ; chaque baisse du restant est rapportée avec les processus vus juste avant et juste après. Aucune variable d'environnement
# n'est lue ni écrite, aucune ligne de commande n'est gardée au-delà de 160 caractères, et rien n'est envoyé nulle part.
import argparse, json, os, subprocess, sys, time

RACINE_PROCESSUS = ('gh', 'git', 'python', 'pythonw', 'node', 'powershell', 'pwsh')
LONGUEUR_COMMANDE = 160


def chutes(echantillons):
    """Pure. echantillons : liste ordonnée de {'t', 'restant', 'reset', 'procs'}. Rend les baisses du restant entre deux pas consécutifs de la même
    fenêtre horaire (même `reset`) : [{'t', 'depuis', 'appels', 'avant', 'apres'}]. Un `reset` qui change = remise à zéro, jamais une consommation."""
    res = []
    for a, b in zip(echantillons, echantillons[1:]):
        if a['reset'] != b['reset'] or b['restant'] >= a['restant']: continue
        res.append({'t': b['t'], 'depuis': a['t'], 'appels': a['restant'] - b['restant'], 'avant': a['procs'], 'apres': b['procs']})
    return res


def processus_communs(chute):
    """Pure. Processus vus à la fois avant et après la baisse (les suspects n° 1), triés ; sinon ceux vus d'un côté seulement."""
    cle = lambda p: f"{p['nom']} {p['cmd']}"
    avant, apres = {cle(p) for p in chute['avant']}, {cle(p) for p in chute['apres']}
    return sorted(avant & apres) or sorted(avant | apres)


def resume(echantillons):
    """Pure. Total consommé sur la passe (hors remises à zéro) et, par baisse, les suspects."""
    c = chutes(echantillons)
    return {'pas': len(echantillons), 'baisses': len(c), 'appels': sum(x['appels'] for x in c),
            'details': [{'t': x['t'], 'appels': x['appels'], 'suspects': processus_communs(x)} for x in c]}


def restant_core():
    out = subprocess.run(['gh', 'api', 'rate_limit', '--jq', '.resources.core | [.remaining, .reset] | @tsv'], capture_output=True, text=True, timeout=30)
    if out.returncode != 0: raise RuntimeError(f'gh api rate_limit a échoué : {(out.stderr or out.stdout).strip()[:200]}')
    r, reset = out.stdout.split()
    return int(r), int(reset)


def processus():
    """Processus pertinents : [{'nom', 'cmd'}]. Windows : CIM ; ailleurs : ps. Un échec rend [] (la mesure du quota continue)."""
    try:
        if os.name == 'nt':
            filtre = ' -or '.join(f"$_.Name -like '{n}*'" for n in RACINE_PROCESSUS)
            ps = f"Get-CimInstance Win32_Process | Where-Object {{ {filtre} }} | ForEach-Object {{ [pscustomobject]@{{ nom = $_.Name; cmd = [string]$_.CommandLine }} }} | ConvertTo-Json -Compress"
            out = subprocess.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', ps], capture_output=True, text=True, timeout=30, creationflags=0x08000000)
            brut = json.loads(out.stdout or '[]')
        else:
            out = subprocess.run(['ps', '-eo', 'comm=,args='], capture_output=True, text=True, timeout=30)
            brut = [{'nom': l.split(None, 1)[0], 'cmd': l.split(None, 1)[1] if len(l.split(None, 1)) > 1 else ''} for l in out.stdout.splitlines() if l.strip()]
    except (OSError, subprocess.SubprocessError, ValueError):
        return []
    if isinstance(brut, dict): brut = [brut]
    vus = []
    for p in brut:
        nom = (p.get('nom') or '').lower()
        if not nom.startswith(RACINE_PROCESSUS) or 'sonde_rest' in (p.get('cmd') or ''): continue
        vus.append({'nom': nom, 'cmd': ' '.join((p.get('cmd') or '').split())[:LONGUEUR_COMMANDE]})
    return vus


def main(argv=None):
    ap = argparse.ArgumentParser(description='Sonde du quota REST du jeton gh du PC (.github#741) : une passe bornée, lecture seule.')
    ap.add_argument('--duree', type=int, default=1200, help='durée de la passe en secondes (défaut 20 min : deux cadences de 10 min)')
    ap.add_argument('--pas', type=int, default=4, help='secondes entre deux mesures')
    ap.add_argument('--sortie', default='sonde-rest.json')
    o = ap.parse_args(argv)
    fin, echantillons = time.time() + o.duree, []
    while time.time() < fin:
        restant, reset = restant_core()
        echantillons.append({'t': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'restant': restant, 'reset': reset, 'procs': processus()})
        time.sleep(o.pas)
    r = resume(echantillons)
    with open(o.sortie, 'w', encoding='utf-8') as fh: json.dump(r, fh, ensure_ascii=False, indent=1)
    print(f"sonde REST : {r['pas']} mesures, {r['baisses']} baisses, {r['appels']} appels consommés ; détail dans {o.sortie}")
    for d in r['details']: print(f"  {d['t']} −{d['appels']} : " + (' | '.join(d['suspects'][:4]) or 'aucun processus vu'))


if __name__ == '__main__': main()
