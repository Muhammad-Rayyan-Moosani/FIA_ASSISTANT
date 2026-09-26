"""Offline pipeline for Step 1: raw OpenF1 data -> zones + placed incidents.

Reads data/openf1/{circuit}_2024.json (from fetch_openf1) and writes
  data/tracks/{circuit}.json      zones for the circuit
  data/incidents/{circuit}.json   incidents with lap_frac, zone, entry speed and energy

    cd backend && python -m scripts.ingest monza
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from services.data_loader import DATA_DIR, load_incidents
from services.geolocate import load_turn_map, locate
from services.openf1_client import OpenF1Client
from services.zones import build_track, load_outline, normalise, point_at, zone_for

ROOT = Path(__file__).resolve().parents[2] / "data"
CAR_MASS_KG = 798        # F1 minimum mass incl. driver (ARCHITECTURE.md §4.4)

# Placeholder mapping from our classifier to the §4.4 schema; confirm with R2.
INCIDENT_TYPE = {"collision": "collision", "off_track": "off_track", "track_limits": "track_limits"}
SEVERITY_SCORE = {"high": 0.8, "medium": 0.4, "low": 0.1}
LOSS_RELEVANT = {"collision"}


def energy_kj(v_kph: float) -> float:
    v = v_kph / 3.6
    return round(0.5 * CAR_MASS_KG * v * v / 1000, 1)


def ingest(circuit: str) -> None:
    raw = json.load(open(DATA_DIR / f"{circuit}_2024.json"))
    session = raw["session"]
    xy, frac = load_outline(circuit)
    xy_norm = normalise(xy)
    turn_map = load_turn_map(circuit)

    track = build_track(circuit)
    (ROOT / "tracks").mkdir(parents=True, exist_ok=True)
    (ROOT / "tracks" / f"{circuit}.json").write_text(json.dumps(track, indent=1))

    incidents = load_incidents(circuit)
    with OpenF1Client() as client:
        for inc in incidents:
            locate(inc, client, session["session_key"], xy, frac, turn_map)

    records = []
    for n, inc in enumerate(incidents, start=1):
        rec = {
            "incident_id": f"{circuit}-{session['year']}-R-{n:04d}",
            "circuit": circuit, "season": session["year"], "session_type": "Race",
            "session_key": session["session_key"],
            "lap": inc.lap,
            "occurred_at": inc.date,                       # race-control notice time; the event can be 1-3 min earlier
            "raw_message": inc.text,
            "car_numbers": inc.cars,
            "turn_number": inc.turn,
            "incident_type": INCIDENT_TYPE[inc.kind],
            "severity_score": SEVERITY_SCORE[inc.severity],
            "loss_relevant": inc.kind in LOSS_RELEVANT,
            "x": None, "y": None, "lap_frac": None, "zone_id": None,
            "geo_method": inc.geo_method, "geo_confidence": inc.geo_confidence,
            "entry_speed_kph": None, "kinetic_energy_kj": None,
            "extraction": {"method": "regex"},
        }
        if inc.lap_frac is not None:
            zone = zone_for(track["zones"], inc.lap_frac)
            rec["lap_frac"] = round(inc.lap_frac, 4)
            rec["x"], rec["y"] = (round(v, 4) for v in point_at(xy_norm, frac, inc.lap_frac))
            if zone:
                rec["zone_id"] = zone["zone_id"]
                rec["entry_speed_kph"] = zone["v_entry_kph"]
                rec["kinetic_energy_kj"] = energy_kj(zone["v_entry_kph"])
        records.append(rec)

    (ROOT / "incidents").mkdir(parents=True, exist_ok=True)
    (ROOT / "incidents" / f"{circuit}.json").write_text(json.dumps(records, indent=1))

    placed = sum(r["zone_id"] is not None for r in records)
    print(f"[{circuit}] {len(track['zones'])} zones; {len(records)} incidents ({placed} placed in a zone, "
          f"{sum(r['loss_relevant'] for r in records)} loss-relevant)")


if __name__ == "__main__":
    for c in sys.argv[1:] or ["monza"]:
        ingest(c)
