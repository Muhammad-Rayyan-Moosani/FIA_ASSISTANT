"""Real incident packs (scripts/build_incident_packs.py): loading, summaries and crash locations."""
from __future__ import annotations

import json
from functools import lru_cache

import numpy as np

from services.data_loader import ROOT_DIR
from services import repository
from services.repository import UnknownCircuit
from services.race_control import frame as fr

PACK_DIR = ROOT_DIR / "race_control"


def _path(circuit: str):
    return PACK_DIR / f"{circuit}_incidents.json"


@lru_cache(maxsize=4)
def _load(circuit: str, version: float) -> dict:
    return json.loads(_path(circuit).read_text(encoding="utf-8"))


def load(circuit: str) -> dict:
    p = _path(circuit)
    if not p.exists():
        raise UnknownCircuit(f"{circuit}: no race-control incidents (run `python -m scripts.build_incident_packs {circuit}`)")
    return _load(circuit, p.stat().st_mtime)


def get(circuit: str, incident_id: str) -> dict:
    for p in load(circuit)["incidents"]:
        if p["incident_id"] == incident_id:
            return p
    raise KeyError(incident_id)


def primary_impact(pack: dict) -> dict | None:
    """The impact race control acts on: an involved car's impact first, then any car's (as built by
    scripts/build_incident_packs.py with the collision estimator)."""
    det = [d for d in pack.get("detected") or [] if d["level"] in ("incident", "crash")]
    return next((d for d in det if d["driver"] in pack["involved"]), None) or (det[0] if det else None)


def position_at(pack: dict, driver: str, t: float) -> tuple[float, float] | None:
    rows = pack["samples"].get(driver)
    if not rows:
        return None
    ts = np.array([r[0] for r in rows])
    i = int(np.clip(np.searchsorted(ts, t), 0, len(rows) - 1))
    return rows[i][4], rows[i][5]


def crash_location(circuit: str, pack: dict) -> dict:
    """Where it happened: the impact position from telemetry; else the marshal sector race control named;
    else the middle of the zone Step 1 placed the incident in."""
    f = fr.frame(circuit)
    imp = primary_impact(pack)
    raw = position_at(pack, imp["driver"], imp["t"]) if imp else None
    if raw:
        loc = {**f.locate(*raw), "source": "telemetry"}
        return {**loc, "marshal_sector": fr.sector_for_frac(circuit, loc["lap_frac"])}
    mast = next((s for s in fr.marshal_sectors(circuit) if s["sector"] == pack.get("marshal_sector")), None)
    if mast:
        return {"x": mast["x"], "y": mast["y"], "lap_frac": mast["lap_frac"], "zone_id": mast["zone_id"],
                "zone_name": mast["zone_name"], "off_line_m": 0.0, "source": "marshal_sector", "marshal_sector": mast["sector"]}
    zone = next(z for z in f.zones if z["zone_id"] == pack["zone_id"])
    mid = (zone["start_frac"] + zone["end_frac"]) / 2
    i = int(np.argmin(np.abs(f.frac - mid)))
    loc = {**f.locate(*f.xy[i]), "source": "zone"}
    return {**loc, "marshal_sector": fr.sector_for_frac(circuit, loc["lap_frac"])}


def summary(circuit: str, pack: dict) -> dict:
    imp = primary_impact(pack)
    loc = crash_location(circuit, pack)
    drivers = pack.get("drivers", {})
    return {
        "incident_id": pack["incident_id"], "season": pack["season"], "session_type": pack["session_type"],
        "occurred_at": pack["occurred_at"], "raw_message": pack["raw_message"], "rule": pack["rule"],
        "zone_id": loc["zone_id"], "zone_name": repository.short_name(loc["zone_name"]), "marshal_sector": loc["marshal_sector"],
        "x": loc["x"], "y": loc["y"], "lap_frac": loc["lap_frac"], "location_source": loc["source"],
        "involved": [{"number": n, **(drivers.get(n) or {})} for n in pack["involved"]],
        "impact": imp, "radio_clips": len(pack.get("radio") or []),
        "cars_in_window": len(pack["samples"]),
    }


def summaries(circuit: str) -> list[dict]:
    return [summary(circuit, p) for p in load(circuit)["incidents"]]
