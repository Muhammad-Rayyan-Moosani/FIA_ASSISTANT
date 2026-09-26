import json
import numpy as np
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parents[2] / "data" / "openf1"
TRACKS_DIR = Path(__file__).resolve().parents[2] / "data" / "tracks"

LENGTH_M = {"monza": 5793, "silverstone": 5891, "spa": 7004}
TRACK_NAME = {
    "monza": "Autodromo Nazionale Monza",
    "silverstone": "Silverstone Circuit",
    "spa": "Circuit de Spa-Francorchamps",
}
# Names for the braking zones, in lap order. Anything not listed gets a generic name.
BRAKING_NAMES = {
    "monza": [
        "Variante del Rettifilo (T1-T2)",
        "Variante della Roggia (T4-T5)",
        "Curva di Lesmo 1 (T6)",
        "Curva di Lesmo 2 (T7)",
        "Variante Ascari (T8-T10)",
        "Curva Alboreto (Parabolica, T11)",
    ],
}

# Placeholder inventory: the real values are hand-authored (ARCHITECTURE.md §13 A2).
INVENTORY_FIELDS = (
    "barrier_type", "runoff_type", "runoff_depth_m", "fence_height_m",
    "grandstand_capacity", "distance_to_stand_m", "marshal_posts", "asset_value_eur", "inventory_source",
)
INVENTORY_DEFAULTS = {
    "barrier_type": "tyre_wall", "runoff_type": "gravel", "runoff_depth_m": 30, "fence_height_m": 4.0,
    "grandstand_capacity": 0, "distance_to_stand_m": 100, "marshal_posts": 1, "asset_value_eur": 500_000,
    "inventory_source": "PLACEHOLDER - not yet authored",
}


def load_outline(circuit: str):
    samples = json.load(open(DATA_DIR / f"{circuit}_2024.json"))["samples"]
    xy = np.array([[p["x"], p["y"]] for p in samples], dtype=float)
    seg = np.linalg.norm(np.diff(xy, axis=0), axis=1)     # length of each step
    dist = np.concatenate([[0.0], np.cumsum(seg)])        # cumulative distance
    frac = dist / dist[-1]                                # 0.0 -> 1.0
    return xy, frac


def snap(xy: np.ndarray, frac: np.ndarray, x: float, y: float):
    d = np.linalg.norm(xy - np.array([x, y]), axis=1)     # distance to every point
    i = int(np.argmin(d))
    return float(frac[i]), float(d[i])                    # lap fraction, snap distance


def load_speed(circuit: str) -> np.ndarray:
    samples = json.load(open(DATA_DIR / f"{circuit}_2024.json"))["samples"]
    return np.array([p["speed"] for p in samples], dtype=float)


def normalise(xy: np.ndarray) -> np.ndarray:
    """Fit the outline into [0,1]^2, keeping the aspect ratio."""
    lo = xy.min(axis=0)
    scale = (xy.max(axis=0) - lo).max()
    return (xy - lo) / scale


def point_at(xy_norm: np.ndarray, frac: np.ndarray, f: float) -> tuple[float, float]:
    """Normalised (x, y) of the outline at lap fraction f."""
    return float(np.interp(f, frac, xy_norm[:, 0])), float(np.interp(f, frac, xy_norm[:, 1]))


def _braking_apexes(dist_m, speed, window=3, vmax=260, merge_m=300):
    """Speed local minima below vmax; minima closer than merge_m are merged (lowest wins)."""
    n = len(speed)
    apexes = [i for i in range(window, n - window)
              if speed[i] == speed[i - window:i + window + 1].min() and speed[i] < vmax]
    kept: list[list[int]] = []                            # [first, apex, last] per merged cluster
    for i in apexes:
        if kept and dist_m[i] - dist_m[kept[-1][1]] < merge_m:
            kept[-1][2] = i
            if speed[i] < speed[kept[-1][1]]:
                kept[-1][1] = i
        else:
            kept.append([i, i, i])
    return kept


def build_zones(circuit: str) -> list[dict]:
    """Cut the reference lap into braking zones and the straight / high-speed gaps between them."""
    xy, frac = load_outline(circuit)
    speed = load_speed(circuit)
    n = len(speed)
    dist_m = frac * LENGTH_M[circuit]                     # outline length is calibrated to the real lap length

    spans = []                                            # (start_idx, end_idx, apex_idx, "braking")
    prev_end = 0
    for first, a, last in _braking_apexes(dist_m, speed):
        s = first
        while s > prev_end and speed[s - 1] >= speed[s]:  # walk back to the braking point
            s -= 1
        target = speed[a] + 0.5 * (speed[s] - speed[a])   # corner exit = half the speed regained
        e = last
        while e < n - 1 and speed[e] < target:
            e += 1
        spans.append((s, e, a, "braking"))
        prev_end = e

    segments, cursor = [], 0
    for s, e, a, kind in spans:
        if s - cursor >= 2:
            segments.append((cursor, s, None, None))      # gap before this braking zone
        segments.append((s, e, a, kind))
        cursor = e
    if n - 1 - cursor >= 2:
        segments.append((cursor, n - 1, None, None))

    names = iter(BRAKING_NAMES.get(circuit, []))
    zones, gap_no = [], 0
    for k, (s, e, a, kind) in enumerate(segments, start=1):
        seg_speed = speed[s:e + 1]
        if kind == "braking":
            ztype, name = "braking", next(names, f"Braking zone {k}")
        else:
            ztype = "straight" if seg_speed.mean() > 250 else "high_speed"
            gap_no += 1
            name = f"{'Straight' if ztype == 'straight' else 'High-speed section'} {gap_no}"
        zones.append({
            "zone_id": f"{circuit}-z{k:02d}",
            "name": name,
            "zone_type": ztype,
            "start_frac": round(float(frac[s]), 4),
            "end_frac": round(float(frac[e]), 4),
            "v_entry_kph": round(float(speed[s])),
            "v_apex_kph": round(float(seg_speed.min())),
            **INVENTORY_DEFAULTS,
        })
    return zones


def build_track(circuit: str) -> dict:
    xy, frac = load_outline(circuit)
    zones = build_zones(circuit)

    # Keep any hand-authored inventory from an earlier run (matched by zone_id).
    path = TRACKS_DIR / f"{circuit}.json"
    if path.exists():
        old = {z["zone_id"]: z for z in json.load(open(path)).get("zones", [])}
        for z in zones:
            if z["zone_id"] in old and not str(old[z["zone_id"]].get("inventory_source", "")).startswith("PLACEHOLDER"):
                z.update({f: old[z["zone_id"]][f] for f in INVENTORY_FIELDS if f in old[z["zone_id"]]})

    return {
        "circuit": circuit,
        "name": TRACK_NAME[circuit],
        "length_m": LENGTH_M[circuit],
        "outline": [[round(float(x), 4), round(float(y), 4)] for x, y in normalise(xy)],
        "zones": zones,
    }


def zone_for(zones: list[dict], f: float) -> dict | None:
    for z in zones:
        if z["start_frac"] <= f < z["end_frac"]:
            return z
    return zones[-1] if zones and f >= zones[-1]["end_frac"] else None   # f == 1.0
