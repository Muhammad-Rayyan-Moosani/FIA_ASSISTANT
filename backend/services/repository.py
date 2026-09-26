"""R3 · Read Step 1 output (data/tracks, data/incidents, data/openf1) and shape it for the API contract.

Scope: Monza and Montreal (SUPPORTED_CIRCUITS). Files are re-read automatically when the ingestion pipeline
rewrites them (cache keyed on file modification time), so a finished ingestion run is live immediately.
"""

from __future__ import annotations

import json
import re

import numpy as np
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path

from services import crash_filter
from services.data_loader import CIRCUITS, CircuitConfig

DATA_DIR = Path(__file__).resolve().parents[2] / "data"
SUPPORTED_CIRCUITS = ("monza", "montreal")


class UnknownCircuit(KeyError):
    """Requested circuit is not in scope (or has no Step 1 data yet)."""


@dataclass(frozen=True)
class CircuitData:
    cfg: CircuitConfig
    track: dict            # data/tracks/{id}.json as written by scripts/ingest.py
    incidents: list[dict]  # data/incidents/{id}.json
    reference: dict        # data/openf1/{reference_lap}: session, reference lap, drivers, samples
    version: float         # newest input file mtime; keys every downstream cache


def _paths(circuit: str) -> tuple[Path, Path, Path]:
    cfg = CIRCUITS[circuit]
    return (DATA_DIR / "tracks" / f"{circuit}.json", DATA_DIR / "incidents" / f"{circuit}.json",
            DATA_DIR / "openf1" / cfg.reference_lap)


def data_version(circuit: str) -> float:
    if circuit not in SUPPORTED_CIRCUITS or circuit not in CIRCUITS:
        raise UnknownCircuit(circuit)
    paths = _paths(circuit)
    missing = [p.name for p in paths if not p.exists()]
    if missing:
        raise UnknownCircuit(f"{circuit}: missing {', '.join(missing)} (run `python -m scripts.ingest {circuit}`)")
    return max(p.stat().st_mtime for p in paths)


def load(circuit: str) -> CircuitData:
    return _load(circuit, data_version(circuit))


@lru_cache(maxsize=8)
def _load(circuit: str, version: float) -> CircuitData:
    track_p, inc_p, ref_p = _paths(circuit)
    read = lambda p: json.loads(p.read_text(encoding="utf-8"))  # noqa: E731
    return CircuitData(CIRCUITS[circuit], read(track_p), read(inc_p), read(ref_p), version)


# ----------------------------------------------------------------------------- shaping
def _centre(outline: list[list[float]]):
    """Step 1 writes the outline in [0, 1]² from the bounding-box corner; the contract is centred on 0."""
    xs, ys = [p[0] for p in outline], [p[1] for p in outline]
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    return lambda x, y: (round(x - cx, 4), round(y - cy, 4))


_PREFIXES = re.compile(r"^(Variante (del|della|dei) |Variante |Curva )")


def short_name(name: str) -> str:
    """Compact label for the map: 'Curva Alboreto (Parabolica)' -> 'Parabolica', 'Variante della Roggia' -> 'Roggia'."""
    if name.startswith("Straight to the line"):
        return "To the line"
    if name.startswith("Straight after "):
        return "After " + short_name(name[len("Straight after "):])
    if name == "Start/finish straight":
        return "Start/finish"
    name = name.split(" / ")[0]          # "Hairpin / Turn 11 (Casino Straight)" -> "Hairpin"
    m = re.search(r"\(([^)]+)\)", name)
    if m:
        return m.group(1)          # the corner's common name: "(Parabolica)", "(Curva Grande)"
    return _PREFIXES.sub("", name)


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(timespec="seconds")


def circuit_summary(circuit: str) -> dict:
    d = load(circuit)
    cov = d.track["data_coverage"]
    return {
        "id": circuit, "name": d.track["name"], "short_name": d.cfg.short_name or d.track["name"],
        "country": d.cfg.country, "length_m": d.track["length_m"], "zone_count": len(d.track["zones"]),
        "coverage": {
            "seasons": cov["seasons"], "sessions": len(cov["sessions"]), "incidents": cov["incidents"],
            "loss_relevant": cov["loss_relevant"], "last_ingested_at": _iso(d.version),
        },
    }


def _zone(z: dict) -> dict:
    return {
        "zone_id": z["zone_id"], "name": z["name"], "short_name": short_name(z["name"]),
        "zone_type": z["zone_type"], "turns": z["turns"], "turn_number": z["turns"][0] if z["turns"] else None,
        "start_frac": z["start_frac"], "end_frac": z["end_frac"], "length_m": z["length_m"],
        "v_entry_kph": z["v_entry_kph"], "v_apex_kph": z["v_apex_kph"],
        "barrier_type": z["barrier_type"], "runoff_type": z["runoff_type"], "runoff_depth_m": z["runoff_depth_m"],
        "fence_height_m": z["fence_height_m"], "grandstands": z["grandstands"],
        "grandstand_capacity": z["grandstand_capacity"], "distance_to_stand_m": z["distance_to_stand_m"],
        "marshal_posts": z["marshal_posts"], "asset_value_eur": z["asset_value_eur"],
        "inventory_source": z["inventory_source"], "n_incidents": z["n_incidents"], "n_loss_relevant": z["n_loss_relevant"],
    }


def _track_sources(d: CircuitData) -> dict:
    t, cov, ref = d.track, d.track["data_coverage"], d.reference
    r = ref["reference"]
    lap = (f"car #{r['driver_number']}, lap {r['lap_number']} of the {ref['session']['year']} {d.cfg.event_name} race "
           f"(OpenF1 session {ref['session']['session_key']})")
    geo = cov["by_geo_method"]
    return {
        "outline": {"provenance": "measured", "title": "Track shape",
                    "detail": f"GPS positions from OpenF1 `location` for {lap}: {len(ref['samples'])} samples, resampled to "
                              f"{len(t['outline'])} evenly spaced points and calibrated to the official lap length "
                              f"({t['length_m']:,} m)."},
        "speeds": {"provenance": "measured", "title": "Corner speeds",
                   "detail": f"OpenF1 `car_data` speed trace for {lap}, matched to the GPS points by timestamp. Braking zones: "
                             "entry = speed at the braking point, apex = slowest point. Other zones: entry = top speed."},
        "zones": {"provenance": "measured", "title": "Zones",
                  "detail": f"{len(t['zones'])} zones cut from the real lap's speed trace: a braking zone runs from the braking "
                            "point to where the car is halfway back to its entry speed; the stretches between are straights "
                            f"or fast corners. Turn and marshal-post positions: {t['sources']['turns_and_marshal_sectors']}."},
        "incidents": {"provenance": "measured", "title": "Incidents",
                      "detail": f"{cov['incidents']} incidents ({cov['loss_relevant']} loss-relevant) from "
                                f"{cov['race_control_messages']:,} OpenF1 race-control messages in {len(cov['sessions'])} sessions, "
                                f"{cov['seasons'][0]}–{cov['seasons'][-1]}. Placed by the turn named in the message "
                                f"({geo.get('turn_in_message', 0)}) or the yellow-flag marshal sector ({geo.get('marshal_sector', 0)}); "
                                f"two-car contacts checked against car positions "
                                f"({cov['car_location_check']['agrees_with_turn']} confirmed).\n\n"
                                "Types come from the message text (regex rules), not from telemetry."},
        "safety_inventory": {"provenance": "assumed", "title": "Safety equipment",
                             "detail": f"Grandstand names: {t['sources']['grandstands']}. Seats per stand and distance to the track "
                                       "are assumed. Marshal-post counts are real (MultiViewer).\n\n"
                                       f"Barrier, run-off, fence and asset value: {t['sources']['barrier_runoff_fence_asset']}"},
    }


def _speed_profile(d: CircuitData) -> tuple[list[float], float]:
    """Real speed (km/h) at each outline point, and the metres spanned by one normalised unit."""
    from services.zones import lap_geometry

    geo = lap_geometry(d.reference["samples"], d.cfg.length_m)
    n = len(d.track["outline"])
    along = np.linspace(0, geo["dist"][-1], n, endpoint=False)
    speed = np.interp(along, geo["dist"], geo["v"])
    raw_m = np.hypot(np.diff(geo["x"]), np.diff(geo["y"])).sum() / 10          # OpenF1 units are 0.1 m
    extent_m = max(np.ptp(geo["x"]), np.ptp(geo["y"])) / 10 * (d.cfg.length_m / raw_m)
    return [round(float(v), 1) for v in speed], round(float(extent_m), 1)


def track_geometry(circuit: str) -> dict:
    d = load(circuit)
    t, ref = d.track, d.reference
    centre = _centre(t["outline"])
    speed, extent_m = _speed_profile(d)
    r, s = ref["reference"], ref["session"]
    drivers = {dr["driver_number"]: dr.get("full_name") for dr in ref.get("drivers", [])}
    return {
        "circuit": circuit, "name": t["name"], "country": d.cfg.country, "length_m": t["length_m"],
        "outline": [centre(x, y) for x, y in t["outline"]],
        "speed_kph": speed,
        "extent_m": extent_m,
        "zones": [_zone(z) for z in t["zones"]],
        "reference": {
            "season": s["year"], "event_name": d.cfg.event_name, "session_key": s["session_key"], "session_type": "Race",
            "driver_number": r["driver_number"], "driver_name": drivers.get(r["driver_number"]),
            "lap_number": r["lap_number"], "lap_duration_s": r["lap_duration"], "sample_count": len(ref["samples"]),
        },
        "sources": _track_sources(d),
    }


def incidents(circuit: str, zone_id: str | None = None, season: int | None = None) -> list[dict]:
    d = load(circuit)
    centre = _centre(d.track["outline"])
    counted = crash_filter.crash_ids(d.incidents)
    out = []
    for r in d.incidents:
        if (zone_id and r["zone_id"] != zone_id) or (season and r["season"] != season):
            continue
        x, y = centre(r["x"], r["y"])
        ex = r.get("extraction") or {}
        out.append({**r, "x": x, "y": y, "marshal_sector": r.get("marshal_sector"), "counts_as_crash": r["incident_id"] in counted,
                    "extraction": {"method": ex.get("method", "regex"), "rule": ex.get("rule"), "model": ex.get("model")}})
    return sorted(out, key=lambda r: r["occurred_at"], reverse=True)


def outline_point(circuit: str, lap_frac: float) -> tuple[float, float]:
    """Centred outline coordinate at a lap fraction (used to place simulated crashes)."""
    d = load(circuit)
    pts = d.track["outline"]
    centre = _centre(pts)
    return centre(*pts[int(lap_frac * len(pts)) % len(pts)])


# ----------------------------------------------------------------------------- insured structures (OSM)
COVERAGE_LINES = {
    "property": ("Property / material damage", "Buildings, grandstands, bridges and towers damaged by a crash, debris or fire."),
    "spectator_liability": ("Spectator liability", "Injury to the public in grandstands, on bridges and in hospitality."),
    "business_interruption": ("Business interruption", "Loss of the event if the pit building, paddock or race control is out of use."),
    "broadcast_equipment": ("Broadcast and timing equipment", "TV and timing towers, masts and media facilities."),
    "participant_accident": ("Participant and marshal accident", "Drivers, marshals at their posts and medical staff."),
    "track_infrastructure": ("Track infrastructure", "Barriers, walls and fences along the track."),
}


def _assets_path(circuit: str) -> Path:
    return DATA_DIR / "tracks" / f"{circuit}_assets.json"


def assets(circuit: str) -> dict:
    """Structures from data/tracks/{circuit}_assets.json (scripts/fetch_osm_assets.py), centred like the outline."""
    d = load(circuit)
    path = _assets_path(circuit)
    if not path.exists():
        raise UnknownCircuit(f"{circuit}: missing {path.name} (run `python -m scripts.fetch_osm_assets {circuit}`)")
    raw = _load_assets(circuit, path.stat().st_mtime)
    centre = _centre(d.track["outline"])
    move = lambda pts: [centre(x, y) for x, y in pts]  # noqa: E731
    return {
        **raw,
        "assets": [{**a, "points": move(a["points"])} for a in raw["assets"]],
        "context": {k: [move(p) for p in v] for k, v in raw["context"].items()},
        "marshal_posts": sum(z["marshal_posts"] for z in d.track["zones"]),
    }


@lru_cache(maxsize=4)
def _load_assets(circuit: str, version: float) -> dict:
    return json.loads(_assets_path(circuit).read_text(encoding="utf-8"))
