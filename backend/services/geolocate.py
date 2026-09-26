"""R1 · Geolocation with car positions (OpenF1 `location`).

Two-car incidents: find where the two cars were closest in the minutes before the steward note
(race-control notices lag the event by 1-3 minutes, so search backwards). When that contact point
agrees with the turn named in the message, the incident gets the exact contact spot
(`driver_location`, high). When it doesn't, or the cars never got close, the named turn is kept
(`turn_in_message`, high).

Results are cached in data/openf1/{circuit}_contacts.json so ingestion runs offline after the first run.
"""

import json
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np

from services.zones import circular_gap, nearest_index, zone_for_frac

TRACKS_DIR = Path(__file__).resolve().parents[2] / "data" / "tracks"
LOOKBACK_S = 240          # how far before the message to search for the contact
CONTACT_UNITS = 30.0      # cars within 3 m (0.1 m units) count as contact
AGREE_TOL = 0.05          # contact point must be within 5% of a lap of the named turn


def iso(d: datetime) -> str:
    return d.isoformat().replace("+00:00", "")     # OpenF1 wants no offset


def load_turn_map(circuit: str) -> dict[int, float]:
    """turn number -> lap fraction, written by scripts/build_turn_map.py."""
    path = TRACKS_DIR / f"turns_{circuit}.json"
    if not path.exists():
        return {}
    return {int(t): v["lap_frac"] for t, v in json.load(open(path)).items()}


_circ = circular_gap                                  # kept for existing callers


def closest_approach(cars: list[int], date: str, client, session_key: int,
                     lookback_s: int = LOOKBACK_S, contact_units: float = CONTACT_UNITS) -> tuple[float, float] | None:
    """Raw (x, y) where the first two cars were closest before `date`, or None if they never got
    within contact_units (or there is no location data)."""
    if len(cars) < 2:
        return None
    t0 = datetime.fromisoformat(date)
    lo, hi = iso(t0 - timedelta(seconds=lookback_s)), iso(t0)
    a = client.location(session_key, cars[0], lo, hi)
    b = client.location(session_key, cars[1], lo, hi)
    if not a or not b:
        return None

    ts = lambda pts: np.array([datetime.fromisoformat(p["date"]).timestamp() for p in pts])  # noqa: E731
    ta, tb = ts(a), ts(b)
    # Put car B onto car A's timestamps so the two are compared at the same instant.
    bx = np.interp(ta, tb, [p["x"] for p in b])
    by = np.interp(ta, tb, [p["y"] for p in b])
    ax = np.array([p["x"] for p in a], dtype=float)
    ay = np.array([p["y"] for p in a], dtype=float)
    d = np.hypot(ax - bx, ay - by)
    d[(ta < tb[0]) | (ta > tb[-1])] = np.inf         # no interpolating outside B's samples

    i = int(np.argmin(d))
    if d[i] > contact_units:
        return None
    return float(ax[i]), float(ay[i])


def _cache_key(r: dict) -> str:
    return f"{r['session_key']}|{r['occurred_at']}|{','.join(map(str, r['car_numbers'][:2]))}"


def refine_with_location(records: list[dict], circuit: str, geo: dict, norm, zones: list[dict],
                         refresh: bool = False, client=None) -> dict[str, int]:
    """Upgrade two-car, loss-relevant incidents to their exact contact point where it agrees
    with the named turn. Uses the cache; calls OpenF1 only for uncached incidents (and only when
    `client` is given). Returns counts for the coverage summary."""
    from services.data_loader import DATA_DIR, kinetic_energy_kj

    cache_path = DATA_DIR / f"{circuit}_contacts.json"
    cache = {} if refresh or not cache_path.exists() else json.loads(cache_path.read_text())
    stats = {"candidates": 0, "contact_found": 0, "agrees_with_turn": 0, "not_checked": 0}

    for r in records:
        if not (r["loss_relevant"] and r["geo_method"] == "turn_in_message" and len(r["car_numbers"]) >= 2):
            continue
        stats["candidates"] += 1
        key = _cache_key(r)
        if key not in cache:
            if client is None:
                stats["not_checked"] += 1
                continue
            try:
                cache[key] = closest_approach(r["car_numbers"], r["occurred_at"], client, r["session_key"])
            except Exception as exc:                          # network trouble: keep the named turn
                print(f"[{circuit}] location lookup failed for {r['incident_id']}: {exc}")
                stats["not_checked"] += 1
                continue
        point = cache[key]
        if point is None:
            continue
        stats["contact_found"] += 1
        i = nearest_index(geo, *point)
        frac = float(geo["frac"][i])
        if circular_gap(frac, r["lap_frac"]) > AGREE_TOL:
            continue                                          # contact elsewhere: trust the named turn
        stats["agrees_with_turn"] += 1
        zone = zone_for_frac(zones, frac)
        nx, ny = norm(*point)
        r.update({
            "x": round(float(nx), 4), "y": round(float(ny), 4), "lap_frac": round(frac, 4),
            "zone_id": zone["zone_id"], "geo_method": "driver_location", "geo_confidence": "high",
            "entry_speed_kph": zone["v_entry_kph"],
            "kinetic_energy_kj": round(kinetic_energy_kj(zone["v_entry_kph"]), 1),
        })

    cache_path.write_text(json.dumps(cache, indent=1))
    return stats
