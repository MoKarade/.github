#!/usr/bin/env python3
"""Quota Claude mesuré sur le PC, publié pour la page Quota (15/10/2026, Marc : « précis sans action de ma part »).

Lit `claude -p "/usage"` (aucun appel au modèle, coût 0), en tire le % hebdomadaire et l'heure de remise
à zéro, puis réécrit le corps d'une issue de MoKarade/.github que fetch.py lit. Aucun jeton, aucune donnée perso :
seulement des pourcentages et des heures UTC. Lancé chaque heure par la tâche Windows « Quota-Claude », sans fenêtre.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ICI = Path(__file__).resolve().parent
JOURNAL = ICI / "quota.log"
DEPOT = "MoKarade/.github"
TITRE = "Quota Claude (mesuré sur le PC)"
NO_WINDOW = 0x08000000
MOIS = {m: i for i, m in enumerate(("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"), 1)}
# ex. « Current week (all models): 44% used · resets Oct 21, 7:59am (America/Toronto) »
LIGNE = re.compile(r"^Current (session|week \(([^)]+)\)):\s*(\d+(?:\.\d+)?)% used\s*·\s*resets\s+"
                   r"(\w{3}) (\d{1,2})(?:, (\d{1,2})(?::(\d{2}))?(am|pm))?\s*\(([^)]+)\)", re.M)


def run(*cmd: str, entree: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(list(cmd), input=entree, capture_output=True, text=True, encoding="utf-8",
                          errors="replace", timeout=180, creationflags=NO_WINDOW)


def heure_utc(mois: str, jour: str, h: str | None, mn: str | None, ampm: str | None, tz: str, now: datetime) -> str:
    """« Oct 21, 7:59am » (fuseau donné) → ISO UTC ; l'année est celle de la prochaine occurrence."""
    heure = (int(h) % 12 + (12 if ampm == "pm" else 0)) if h else 0
    zone = ZoneInfo(tz)
    local = now.astimezone(zone)
    d = datetime(local.year, MOIS[mois], int(jour), heure, int(mn or 0), tzinfo=zone)
    if d < local.replace(tzinfo=zone) and (local - d).days > 180:
        d = d.replace(year=d.year + 1)
    return d.astimezone(timezone.utc).isoformat(timespec="minutes").replace("+00:00", "Z")


def mesurer() -> dict:
    r = run("claude", "-p", "/usage", "--output-format", "json", "--no-session-persistence")
    rep = json.loads(r.stdout[r.stdout.find("{"):])
    if rep.get("is_error"):                          # ex. « OAuth session expired » : dire la vraie cause, pas « format changé »
        raise ValueError("Claude Code non connecté, reconnexion requise (claude auth login) : " + str(rep.get("result", ""))[:100])
    texte = rep["result"]
    now = datetime.now(timezone.utc)
    res = {"mesure_utc": now.isoformat(timespec="minutes").replace("+00:00", "Z"), "source": "claude /usage (PC)"}
    for m in LIGNE.finditer(texte):
        quoi, modele, pct, mois, jour, h, mn, ampm, tz = m.groups()
        valeur = {"pct": float(pct), "reset_utc": heure_utc(mois, jour, h, mn, ampm, tz, now)}
        if quoi == "session":
            res["session"] = valeur
        elif modele == "all models":
            res.update(valeur)                       # champs principaux : pct, reset_utc
        else:
            res.setdefault("par_modele", {})[modele] = valeur
    if "pct" not in res:
        raise ValueError("ligne « Current week (all models) » introuvable dans /usage")
    return res


def publier(res: dict) -> None:
    corps = ("Mesure automatique du PC (tâche « Quota-Claude », chaque heure). Lu par fetch.py de la page Quota.\n\n"
             "```json\n" + json.dumps(res, ensure_ascii=False, indent=1) + "\n```\n")
    # pas « --search » : l'index de recherche a du retard et créerait des doublons (vu le 15/10)
    r = run("gh", "issue", "list", "-R", DEPOT, "--state", "all", "--limit", "200",
            "--json", "number,title", "--jq", f'.[] | select(.title=="{TITRE}") | .number')
    numeros = r.stdout.split()
    if r.returncode != 0:
        raise RuntimeError("gh issue list en erreur")
    if numeros:
        e = run("gh", "issue", "edit", numeros[-1], "-R", DEPOT, "--body-file", "-", entree=corps)
    else:
        e = run("gh", "issue", "create", "-R", DEPOT, "--title", TITRE, "--body-file", "-", entree=corps)
    if e.returncode != 0:
        raise RuntimeError("publication GitHub en erreur")


def main() -> int:
    try:
        res = mesurer()
        publier(res)
        ligne = f"{res['mesure_utc']} ok {res['pct']}% reset {res['reset_utc']}"
        code = 0
    except Exception as exc:   # la page garde la dernière mesure ; l'échec est noté ici
        ligne = f"{datetime.now(timezone.utc).isoformat(timespec='minutes')} ÉCHEC {exc}"
        code = 1
    with JOURNAL.open("a", encoding="utf-8") as f:
        f.write(ligne + "\n")
    return code


if __name__ == "__main__":
    sys.exit(main())
