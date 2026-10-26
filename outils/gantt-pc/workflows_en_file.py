# Workflows qui attendent un robot (tâche .github#532, 22/10/2026). Un workflow qui demande `[self-hosted, pc-marc]` dans un dépôt devenu public n'est jamais
# pris (le robot du PC ne sert pas un dépôt public) et reste « en file » sans que rien ne le dise : MemoryAI `apprentissage.yml` (runs 7 à 13) et CarAI
# `smartcar-poll.yml` (17 lancements horaires, aucun n'a tourné). Le relevé lit donc les lancements `queued` de chaque dépôt (un appel par dépôt, un 304
# ne compte pas dans la limite de GitHub) et signale ceux qui attendent trop longtemps.
# Seuils : un lancement `schedule` n'a aucune raison d'attendre plus d'1 h ; tout autre (PR, issue…) peut attendre derrière un robot occupé, il n'est un
# défaut qu'à partir de 6 h. Fonctions pures d'un côté (`en_file`), lecture de l'autre (`relever`, la lecture est injectée).
import datetime

SEUIL_SCHEDULE_H = 1
SEUIL_AUTRE_H = 6
PAR_DEPOT = 100    # une page, du plus récent au plus ancien : au-delà de 100 en file, les plus anciens manquent, mais les 100 lus suffisent à signaler le défaut


def _t(iso):
    return datetime.datetime.fromisoformat(iso.replace('Z', '+00:00'))


def en_file(runs, maintenant):
    """runs : lancements d'un dépôt (réponse de GitHub) ; maintenant : datetime aware. -> [{'run', 'wf', 'event', 'h', 'u'}] des lancements en file trop longtemps,
    du plus ancien au plus récent. Une date absente ou illisible ne signale rien (jamais un chiffre inventé)."""
    out = []
    for r in runs or []:
        if not isinstance(r, dict) or r.get('status') != 'queued': continue
        try: h = (maintenant - _t(r['created_at'])).total_seconds() / 3600
        except (KeyError, TypeError, ValueError, AttributeError): continue
        event = r.get('event') or ''
        if h >= (SEUIL_SCHEDULE_H if event == 'schedule' else SEUIL_AUTRE_H):
            out.append({'run': r.get('id'), 'wf': r.get('name') or r.get('path') or '?', 'event': event, 'h': round(h, 1), 'u': r.get('html_url') or ''})
    return sorted(out, key=lambda x: -x['h'])


# Exceptions nommées (Marc, 26/10/2026) : un lancement que GitHub garde « en file » sans qu'on puisse l'annuler (409 « not queued yet »), le supprimer ni forcer
# son annulation ne se corrige pas : il reste affiché, avec sa raison, mais ne compte plus parmi les défauts. Une entrée = un lancement précis, jamais un filtre.
EXCEPTIONS = {
    ('driveai', 29254315500): 'run fantôme GitHub, non actionnable (CI du 13/07/2026 sur une branche sans PR : insupprimable, annulation refusée)',
}


def separer(liste):
    """liste : sortie de `relever`. -> (défauts, exceptions) ; chaque exception porte sa `raison`."""
    defauts, exceptions = [], []
    for x in liste or []:
        raison = EXCEPTIONS.get((str(x.get('repo', '')).lower(), x.get('run')))
        if raison: exceptions.append({**x, 'raison': raison})
        else: defauts.append(x)
    return defauts, exceptions


def relever(repos, lire, maintenant):
    """repos : [(nom_du_depot, cle)] ; lire(chemin) -> JSON (peut lever). -> (liste, erreurs) ; la liste est [{'repo', 'run', 'wf', 'event', 'h', 'u'}].
    Un dépôt illisible est dit dans `erreurs` et ne bloque pas les autres."""
    liste, erreurs = [], []
    for repo, _cle in repos:
        try: d = lire(f'repos/MoKarade/{repo}/actions/runs?status=queued&per_page={PAR_DEPOT}')
        except Exception as e:
            erreurs.append(f'{repo} : {str(e)[:120]}'); continue
        runs = d.get('workflow_runs') if isinstance(d, dict) else None
        if runs is None:
            erreurs.append(f'{repo} : réponse inattendue'); continue
        liste += [{'repo': repo, **x} for x in en_file(runs, maintenant)]
    return liste, erreurs
