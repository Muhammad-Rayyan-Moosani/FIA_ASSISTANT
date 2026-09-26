"""R1 · Zones: reference lap -> ~10–16 zones per circuit, merged with the safety inventory.

Method (ARCHITECTURE.md §4.3):
  1. Resample the reference lap evenly by distance (calibrated to the official lap length);
     normalise the outline to [0, 1]² (aspect kept). Zone ids are {circuit}-z01, -z02, ... in lap order.
  2. Braking zones: speed local minima (window ±3 samples, v < 260 km/h), minima closer than 300 m
     merged. Each zone runs from the braking point (the speed peak before it) to the corner exit
     (speed back halfway to the entry speed). Stretches under 150 m join the zone before.
  3. The stretches between braking zones become `high_speed` (they contain an official turn, e.g.
     Curva Grande) or `straight` zones. A zone never wraps past the start/finish line, so the main
     straight is split at the line.
  4. v_entry_kph = speed at the braking point (braking zones) or the zone's top speed (others).
  5. Each zone is named after the official turns inside it, gets real marshal-post counts
     (MultiViewer marshal sectors inside it) and official grandstands, plus inventory defaults.
"""

from __future__ import annotations

import numpy as np

UNITS_PER_M = 10            # OpenF1 x/y are in decimetres
MIN_WINDOW = 3              # ±samples for a local speed minimum
BRAKING_MAX_KPH = 260       # only minima slower than this are braking zones
MERGE_M = 300               # minima closer than this are one zone (chicanes)
EXIT_RECOVERY = 0.5         # corner exit = speed back halfway from the apex to the entry speed
MIN_GAP_M = 150             # shorter stretches between braking zones join the zone before
BRAKING_POINT_SHARE = 0.97  # braking point = last sample at >= 97% of the speed peak before a corner
OUTLINE_POINTS = 400


def lap_geometry(samples: list[dict], length_m: float | None = None) -> dict[str, np.ndarray]:
    """x, y (raw units), speed and cumulative distance (m) of the reference lap samples.

    With `length_m` (the official lap length) distances are calibrated to it: the sampled outline
    cuts corners slightly, so its own length comes out a little short (Monza: 5,740 m vs 5,793 m).
    """
    x = np.array([s["x"] for s in samples], float)
    y = np.array([s["y"] for s in samples], float)
    v = np.array([s["speed"] for s in samples], float)
    steps = np.r_[0, np.cumsum(np.hypot(np.diff(x), np.diff(y)))]
    frac = steps / steps[-1]
    length = float(length_m or steps[-1] / UNITS_PER_M)
    return {"x": x, "y": y, "v": v, "dist": frac * length, "frac": frac, "length_m": length}


def normaliser(geo: dict[str, np.ndarray]):
    """Function mapping raw (x, y) to the [0, 1]² outline frame, aspect ratio kept."""
    x0, y0 = geo["x"].min(), geo["y"].min()
    scale = max(np.ptp(geo["x"]), np.ptp(geo["y"]))
    return lambda x, y: ((np.asarray(x, float) - x0) / scale, (np.asarray(y, float) - y0) / scale)


def outline(geo: dict[str, np.ndarray], norm, n: int = OUTLINE_POINTS) -> list[list[float]]:
    d = np.linspace(0, geo["dist"][-1], n, endpoint=False)
    nx, ny = norm(np.interp(d, geo["dist"], geo["x"]), np.interp(d, geo["dist"], geo["y"]))
    return [[round(float(a), 4), round(float(b), 4)] for a, b in zip(nx, ny)]


def nearest_index(geo: dict[str, np.ndarray], x: float, y: float) -> int:
    return int(np.hypot(geo["x"] - x, geo["y"] - y).argmin())


def braking_groups(geo: dict[str, np.ndarray]) -> list[list[int]]:
    """Speed minima below BRAKING_MAX_KPH, grouped when closer than MERGE_M (a chicane = one group)."""
    v, dist = geo["v"], geo["dist"]
    mins = [i for i in range(len(v))
            if v[i] == v[max(0, i - MIN_WINDOW):i + MIN_WINDOW + 1].min() and v[i] < BRAKING_MAX_KPH]
    groups: list[list[int]] = []
    for i in mins:
        if groups and dist[i] - dist[groups[-1][-1]] < MERGE_M:
            groups[-1].append(i)
        else:
            groups.append([i])
    return groups


def _braking_span(v: np.ndarray, group: list[int]) -> tuple[int, int]:
    """From the braking point before the first minimum to the exit after the last one."""
    peak = group[0]
    while peak > 0 and v[peak - 1] >= v[peak]:
        peak -= 1                                      # walk back up to the speed peak
    # The braking point is the last moment the car is still near that peak: at Monza the speed
    # is almost flat for hundreds of metres before the brakes go on, and that belongs to the straight.
    start = max(i for i in range(peak, group[0] + 1) if v[i] >= BRAKING_POINT_SHARE * v[peak])
    apex_v = v[group].min()
    target = apex_v + EXIT_RECOVERY * (v[start] - apex_v)   # halfway back to the entry speed
    end = group[-1]
    while end < len(v) - 1 and v[end] < target:
        end += 1
    return start, end


def build_zones(cfg, geo: dict[str, np.ndarray], turns: list[dict], marshals: list[dict],
                inventory: dict) -> list[dict]:
    """Zones in lap order, each with its turns, speeds, marshal posts, grandstands and inventory."""
    v, frac = geo["v"], geo["frac"]
    n = len(v)
    turn_idx = {t["number"]: nearest_index(geo, t["x"], t["y"]) for t in turns}
    marshal_idx = [nearest_index(geo, m["x"], m["y"]) for m in marshals]

    spans = [_braking_span(v, g) for g in braking_groups(geo)]
    # Fill the gaps between braking zones (and before the first / after the last) with other zones.
    # A gap shorter than MIN_GAP_M is not a useful zone: it joins the braking zone before it.
    cuts: list[list] = []
    cursor = 0
    for s, e in spans:
        s = max(s, cursor)
        if s > cursor:
            if cuts and geo["dist"][s] - geo["dist"][cursor] < MIN_GAP_M:
                cuts[-1][1] = s
            else:
                cuts.append([cursor, s, "gap"])
        cuts.append([s, e, "braking"])
        cursor = e
    if cursor < n - 1:
        cuts.append([cursor, n - 1, "gap"])

    zones = []
    for s, e, kind in cuts:
        inside = sorted(t for t, i in turn_idx.items() if s <= i < e or (e == n - 1 and i == e))
        if kind == "gap":
            kind = "high_speed" if inside else "straight"
        zones.append({"s": s, "e": e, "zone_type": kind, "turns": inside})

    stands = inventory["grandstands"]
    defaults = inventory["defaults_by_zone_type"]
    out = []
    for k, z in enumerate(zones):
        s, e = z["s"], z["e"]
        names = list(dict.fromkeys(cfg.turn_names[t] for t in z["turns"]))
        if names:
            name = " / ".join(names)
        elif k == 0:
            name = "Start/finish straight"
        elif k == len(zones) - 1:
            name = f"Straight to the line (after {out[-1]['name']})"
        else:
            name = f"Straight after {out[-1]['name']}"
        zone_stands = [g["name"] for g in stands["stands"]
                       if set(g.get("turns", [])) & set(z["turns"]) or (g.get("where") == "main_straight" and k == 0)]
        out.append({
            "zone_id": f"{cfg.id}-z{k + 1:02d}",
            "name": name,
            "zone_type": z["zone_type"],
            "turns": z["turns"],
            "start_frac": round(float(frac[s]), 4),
            "end_frac": round(float(frac[e]), 4) if e < n - 1 else 1.0,
            "length_m": round(float(geo["dist"][e] - geo["dist"][s])),
            # braking zone: speed at the braking point; elsewhere: the fastest a car goes in the zone
            "v_entry_kph": round(float(v[s] if z["zone_type"] == "braking" else v[s:e + 1].max())),
            "v_apex_kph": round(float(v[s:e + 1].min())),
            "marshal_posts": int(sum(s <= i < e for i in marshal_idx)),
            "grandstands": zone_stands,
            "grandstand_capacity": len(zone_stands) * stands["assumed_seats_per_stand"],
            "distance_to_stand_m": stands["assumed_distance_m"] if zone_stands else None,
            **defaults[z["zone_type"]],
            "inventory_source": ("grandstands: official list (monzanet.it), seats and distance assumed; "
                                 "marshal_posts: MultiViewer marshal sectors (real); "
                                 "barrier / run-off / fence / asset value: assumed default by zone type"),
        })
    return out


def zone_for_frac(zones: list[dict], f: float) -> dict:
    for z in zones:
        if z["start_frac"] <= f < z["end_frac"]:
            return z
    return zones[-1]


# ----------------------------------------------------------------------------- outline helpers
# Array-based helpers used by services/geolocate.py and scripts/build_turn_map.py.
def load_outline(circuit: str) -> tuple[np.ndarray, np.ndarray]:
    """Reference-lap points (raw x, y) and their lap fraction 0 -> 1."""
    import json

    from services.data_loader import CIRCUITS, DATA_DIR

    samples = json.loads((DATA_DIR / CIRCUITS[circuit].reference_lap).read_text())["samples"]
    geo = lap_geometry(samples)
    return np.column_stack([geo["x"], geo["y"]]), geo["frac"]


def snap(xy: np.ndarray, frac: np.ndarray, x: float, y: float) -> tuple[float, float]:
    """Nearest outline point to (x, y): its lap fraction and the snap distance (raw units)."""
    d = np.linalg.norm(xy - np.array([x, y]), axis=1)
    i = int(np.argmin(d))
    return float(frac[i]), float(d[i])


def circular_gap(a: float, b: float) -> float:
    """Distance between two lap fractions on a loop."""
    d = abs(a - b)
    return min(d, 1 - d)
