# Preuves en retard, pour le filet du PC (scripts/preuves-retard.mjs, tâche .github#513) : les tâches fusionnées sans « Acceptée » depuis plus de 2 h,
# celles dont la preuve programmée est dépassée depuis plus d'1 h, les fermées sans preuve et les rouvertes par le garde-fou (`preuve-manquante`).
# Les tâches qui attendent Marc (`qui:marc`) sont marquées : elles ont leur propre réveil (« geste de Marc en retard »).

KINDS = ('fusionnée sans preuve depuis 2 h', "preuve programmée dépassée depuis plus d'1 h", 'fermée sans preuve')

def calculer(gh, sante, maintenant):
    """gh : le relevé (repos -> nodes) ; sante : {'pb': [{k, ref, ...}]} ; maintenant : datetime aware -> {'calcule_le', 'defauts': [{k, ref, marc}]}"""
    noeud = {f"{r['repo'].lower()}#{n['n']}": n for r in gh['repos'] for n in r['nodes'].values()}
    out, vus = [], set()
    for p in sante['pb']:
        n = noeud.get(p['ref'].lower())
        if p['k'] in KINDS and n is not None:
            out.append({'k': p['k'], 'ref': p['ref'], 'marc': 'qui:marc' in n['labels']})
            vus.add(p['ref'].lower())
    for r in gh['repos']:
        for n in r['nodes'].values():
            ref = f"{r['repo']}#{n['n']}"
            if n['lvl'] == 'tâche' and n['state'] == 'open' and 'preuve-manquante' in n['labels'] and ref.lower() not in vus:
                out.append({'k': 'preuve manquante', 'ref': ref, 'marc': 'qui:marc' in n['labels']})
    return {'calcule_le': maintenant.strftime('%Y-%m-%dT%H:%M:%SZ'), 'defauts': out}
