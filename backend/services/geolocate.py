import json
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np

from services.data_loader import Incident
from services.zones import snap

TRACKS_DIR = Path(__file__).resolve().parents[2] / "data" / "tracks"


def iso(d: datetime) -> str:
    return d.isoformat().replace("+00:00", "")     # OpenF1 wants no offset


def load_turn_map(circuit: str) -> dict[int, float]:
    """turn number -> lap fraction, written by scripts/build_turn_map.py."""
    path = TRACKS_DIR / f"turns_{circuit}.json"
    if not path.exists():
        return {}
    return {int(t): v["lap_frac"] for t, v in json.load(open(path)).items()}


def _circ(a: float, b: float) -> float:
    d = abs(a - b)
    return min(d, 1 - d)                            # distance on a loop


def _closest_approach(inc: Incident, client, session_key: int, xy, frac,
                      lookback_s: int = 240, contact_units: float = 30.0) -> float | None:
    """Where two cars were closest in the lookback window before the message time.

    Race-control notices lag the event by 1-3 minutes, so search backwards. Returns
    None for single-car incidents, or when the cars never got within contact_units.
    """
    if len(inc.cars) < 2:
        return None
    t0 = datetime.fromisoformat(inc.date)
    lo, hi = iso(t0 - timedelta(seconds=lookback_s)), iso(t0)
    a = client.location(session_key, inc.cars[0], lo, hi)
    b = client.location(session_key, inc.cars[1], lo, hi)
    if not a or not b:
        return None

    ts = lambda pts: np.array([datetime.fromisoformat(p["date"]).timestamp() for p in pts])
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
    inc.x, inc.y = float(ax[i]), float(ay[i])
    return snap(xy, frac, ax[i], ay[i])[0]


def locate(inc: Incident, client, session_key: int, xy, frac,
           turn_map: dict[int, float], tol: float = 0.05) -> None:
    gps = _closest_approach(inc, client, session_key, xy, frac)
    turn = turn_map.get(inc.turn) if inc.turn is not None else None

    if gps is not None and turn is not None and _circ(gps, turn) <= tol:
        inc.lap_frac, inc.geo_method, inc.geo_confidence = gps, "driver_location", "high"
    elif turn is not None:
        inc.lap_frac, inc.geo_method, inc.geo_confidence = turn, "turn_number", "high"
    elif gps is not None:
        inc.lap_frac, inc.geo_method, inc.geo_confidence = gps, "driver_location", "low"
