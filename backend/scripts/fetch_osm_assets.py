"""Step 1 · Insured structures around each circuit from OpenStreetMap, aligned to the OpenF1 track frame.

    cd backend && python -m scripts.fetch_osm_assets                 # monza and montreal
    cd backend && python -m scripts.fetch_osm_assets monza --offline  # re-align from the cached download

1. Download buildings, grandstands, barriers, towers, bridges, raceways, woods and water around the
   circuit from the Overpass API -> data/osm/{circuit}.json (raw cache, © OpenStreetMap contributors, ODbL).
2. Align: OSM lat/lon -> local metres -> the OpenF1 x/y frame of the reference lap, by fitting a similarity
   transform (rotation, scale, shift, optional mirror) that lays OSM's raceway onto the real lap (trimmed ICP).
3. Classify every structure within reach of the track into what a circuit's insurance programme covers
   (property, spectator liability, business interruption, broadcast equipment, track infrastructure).
4. Write data/tracks/{circuit}_assets.json in the same [0, 1]² frame as data/tracks/{circuit}.json.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import time
from pathlib import Path

import httpx
import numpy as np
from scipy.spatial import cKDTree

from services.data_loader import CIRCUITS, ROOT_DIR
from services.zones import lap_geometry, normaliser, zone_for_frac

OSM_DIR = ROOT_DIR / "osm"
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
ATTRIBUTION = "© OpenStreetMap contributors (ODbL)"

# south, west, north, east around each circuit
BBOX = {"monza": (45.600, 9.265, 45.640, 9.300), "montreal": (45.492, -73.540, 45.515, -73.515)}

KEEP_BUILDING_M = 220        # buildings within this distance of the track centreline
KEEP_BARRIER_M = 45          # barriers, walls, fences along the track
KEEP_TOWER_M = 250
LEVEL_M = 3.2
DEFAULT_HEIGHT_M = {"grandstand": 12.0, "pit_building": 11.0, "paddock": 8.0, "hospitality": 9.0, "medical": 6.0,
                    "race_control": 14.0, "media": 9.0, "podium": 7.0, "building": 6.0}

# What an event / venue insurance programme typically covers, by structure type.
COVERAGE = {
    "grandstand": ["property", "spectator_liability"],
    "pit_building": ["property", "business_interruption"],
    "paddock": ["property", "business_interruption"],
    "hospitality": ["property", "spectator_liability", "business_interruption"],
    "race_control": ["property", "business_interruption"],
    "media": ["property", "broadcast_equipment"],
    "medical": ["property", "participant_accident"],
    "podium": ["property"],
    "building": ["property"],
    "tower": ["broadcast_equipment", "property"],
    "bridge": ["property", "spectator_liability"],
    "barrier": ["track_infrastructure"],
}

NAME_RULES = [  # first match wins; matched against the lower-cased OSM name
    (r"box|pit build|garage", "pit_building"),
    (r"paddock", "paddock"),
    (r"hospitality|club|lounge|vip", "hospitality"),
    (r"race control|direzione gara|control tower|torre", "race_control"),
    (r"media|press|stampa|broadcast|tv", "media"),
    (r"medic|clinic|infermeria|ambul", "medical"),
    (r"podi", "podium"),
    (r"tribun|grandstand|gradin", "grandstand"),
]

QUERY = """[out:json][timeout:120];
(
  way["highway"="raceway"]({b});
  way["building"]({b});
  way["barrier"~"^(guard_rail|wall|fence|jersey_barrier|kerb)$"]({b});
  way["man_made"~"^(tower|mast)$"]({b});
  node["man_made"~"^(tower|mast)$"]({b});
  way["bridge"]({b});
  way["natural"~"^(wood|water)$"]({b});
  way["landuse"="forest"]({b});
  way["water"]({b});
);
out tags geom;"""


# ----------------------------------------------------------------------------- download
def fetch(circuit: str) -> dict:
    s, w, n, e = BBOX[circuit]
    q = QUERY.replace("{b}", f"{s},{w},{n},{e}")
    for attempt in range(4):
        r = httpx.post(OVERPASS_URL, data={"data": q}, headers={"User-Agent": "FIA-Assistant/1.0"}, timeout=180)
        if r.status_code not in (429, 504):
            break
        time.sleep(10 * (attempt + 1))
    r.raise_for_status()
    data = r.json()
    OSM_DIR.mkdir(parents=True, exist_ok=True)
    (OSM_DIR / f"{circuit}.json").write_text(json.dumps({"source": ATTRIBUTION, "bbox": BBOX[circuit], **data}))
    return data


# ----------------------------------------------------------------------------- alignment
def _local_metres(lat: np.ndarray, lon: np.ndarray, lat0: float, lon0: float) -> np.ndarray:
    k = math.pi / 180 * 6_371_000
    return np.column_stack([(lon - lon0) * k * math.cos(math.radians(lat0)), (lat - lat0) * k])


def _procrustes(src: np.ndarray, dst: np.ndarray) -> tuple[float, np.ndarray, np.ndarray]:
    """Similarity transform (scale, rotation matrix, translation) minimising |s R src + t - dst|."""
    mu_s, mu_d = src.mean(0), dst.mean(0)
    a, b = src - mu_s, dst - mu_d
    u, sig, vt = np.linalg.svd(a.T @ b)
    d = np.sign(np.linalg.det(u @ vt))
    r = (u @ np.diag([1, d]) @ vt).T
    scale = (sig * [1, d]).sum() / (a ** 2).sum()
    return scale, r, mu_d - scale * (r @ mu_s)


def densify(line_m: np.ndarray, step_m: float = 4.0) -> np.ndarray:
    """Points every `step_m` along a polyline (OSM straights are often a single long segment)."""
    seg = np.hypot(*np.diff(line_m, axis=0).T)
    d = np.r_[0, np.cumsum(seg)]
    if d[-1] == 0:
        return line_m
    s = np.arange(0, d[-1], step_m)
    return np.column_stack([np.interp(s, d, line_m[:, 0]), np.interp(s, d, line_m[:, 1])])


def align(lap_xy: np.ndarray, osm_lines_m: list[np.ndarray]) -> tuple[callable, float]:
    """Fit the lap (OpenF1 units) onto OSM's raceways (metres) with trimmed ICP from the lap's side, so every
    lap point matches the Grand Prix line and extra raceways (old oval, pit lane) are simply never matched.
    Returns (OSM metres -> OpenF1 units transform, median residual in metres)."""
    osm = np.vstack([densify(line) for line in osm_lines_m])
    tree = cKDTree(osm)
    best = None
    for mirror in (1, -1):
        src = lap_xy * [1, mirror]
        for deg in range(0, 360, 10):
            th = math.radians(deg)
            r = np.array([[math.cos(th), -math.sin(th)], [math.sin(th), math.cos(th)]])
            s = 0.1                                               # OpenF1 ≈ 0.1 m per unit
            t = osm.mean(0) - s * (r @ src.mean(0))
            for _ in range(40):
                dist, idx = tree.query((s * (r @ src.T)).T + t)
                keep = dist <= np.quantile(dist, 0.85)
                s, r, t = _procrustes(src[keep], osm[idx[keep]])
            dist, _ = tree.query((s * (r @ src.T)).T + t)
            score = float(np.median(dist))
            if best is None or score < best[0]:
                best = (score, s, r, t, mirror)
    score, s, r, t, mirror = best
    inverse = lambda m: ((r.T @ (np.asarray(m, float) - t).T).T / s) * [1, mirror]  # noqa: E731
    return inverse, score


# ----------------------------------------------------------------------------- classification
def _height(tags: dict, category: str) -> tuple[float, str]:
    """(height in metres, source): OSM `height`, OSM `building:levels` × 3.2 m, or an assumed default by type."""
    for key in ("height", "building:height"):
        m = re.match(r"[\d.]+", tags.get(key, ""))
        if m:
            return float(m.group()), "osm_height"
    m = re.match(r"\d+", tags.get("building:levels", ""))
    if m:
        return int(m.group()) * LEVEL_M, "osm_levels"
    return DEFAULT_HEIGHT_M.get(category, 6.0), "assumed"


def _category(tags: dict) -> str | None:
    name = (tags.get("name") or "").lower()
    if tags.get("building") == "grandstand" or tags.get("leisure") == "stadium":
        return "grandstand"
    for pattern, cat in NAME_RULES:
        if name and re.search(pattern, name):
            return cat
    if tags.get("building") in ("residential", "house", "apartments", "detached", "terrace", "church", "school",
                                "farm", "farm_auxiliary", "villa", "greenhouse"):
        return None                      # not circuit property
    return "building" if "building" in tags else None


def build(circuit: str, osm: dict) -> dict:
    cfg = CIRCUITS[circuit]
    lap = json.loads((ROOT_DIR / "openf1" / cfg.reference_lap).read_text())["samples"]
    geo = lap_geometry(lap, cfg.length_m)
    norm = normaliser(geo)
    lap_xy = np.column_stack([geo["x"], geo["y"]])
    track = json.loads((ROOT_DIR / "tracks" / f"{circuit}.json").read_text())

    els = osm["elements"]
    lat0 = (BBOX[circuit][0] + BBOX[circuit][2]) / 2
    lon0 = (BBOX[circuit][1] + BBOX[circuit][3]) / 2
    to_m = lambda g: _local_metres(np.array([p["lat"] for p in g]), np.array([p["lon"] for p in g]), lat0, lon0)  # noqa: E731

    raceways = [e for e in els if e.get("tags", {}).get("highway") == "raceway" and e.get("geometry")]
    race_lines = [to_m(e["geometry"]) for e in raceways]
    to_f1, rms_m = align(lap_xy, race_lines)
    units_per_m = float(np.linalg.norm(to_f1([[1, 0]]) - to_f1([[0, 0]])))

    lap_tree = cKDTree(lap_xy)
    extent_units = max(np.ptp(geo["x"]), np.ptp(geo["y"]))

    def project(geom):
        f1 = to_f1(to_m(geom))
        nx, ny = norm(f1[:, 0], f1[:, 1])
        return f1, [[round(float(a), 5), round(float(b), 5)] for a, b in zip(nx, ny)]

    def track_distance(f1_pts) -> tuple[float, float]:
        dist, idx = lap_tree.query(f1_pts)
        i = int(np.argmin(dist))
        return float(dist[i] / units_per_m), float(geo["frac"][idx[i]])

    assets, context = [], {"woods": [], "water": [], "pit_lane": [], "other_raceways": []}
    for e in els:
        tags, geom = e.get("tags", {}), e.get("geometry")
        if e["type"] == "node":
            geom = [{"lat": e["lat"], "lon": e["lon"]}]
        if not geom:
            continue
        f1, pts = project(geom)
        dist_m, frac = track_distance(f1)
        closed = len(geom) > 3 and geom[0] == geom[-1]

        if tags.get("highway") == "raceway":
            name = (tags.get("name") or "").lower()
            if "pit" in name or tags.get("service") == "pit_lane":
                context["pit_lane"].append(pts)
            elif dist_m > 15:                               # old oval, junior loops: not the Grand Prix line
                context["other_raceways"].append(pts)
            continue
        if tags.get("natural") == "wood" or tags.get("landuse") == "forest":
            if closed:
                context["woods"].append(pts)
            continue
        if tags.get("natural") == "water" or "water" in tags:
            if closed:
                context["water"].append(pts)
            continue

        if tags.get("man_made") in ("tower", "mast"):
            category = "tower"
            if dist_m > KEEP_TOWER_M:
                continue
        elif "barrier" in tags:
            category = "barrier"
            if dist_m > KEEP_BARRIER_M or closed:
                continue
        elif tags.get("bridge") and "building" not in tags:
            category = "bridge"
            if dist_m > 30:
                continue
        else:
            category = _category(tags)
            if category is None or dist_m > KEEP_BUILDING_M or not closed:
                continue

        zone = zone_for_frac(track["zones"], frac)
        if category == "barrier":
            height, height_source = (1.2, "assumed") if "height" not in tags else _height(tags, category)
        elif category == "bridge":
            height, height_source = 6.0, "assumed"
        else:
            height, height_source = _height(tags, category)
        assets.append({
            "asset_id": f"osm-{e['type']}-{e['id']}",
            "name": tags.get("name"),
            "category": category,
            "osm_tag": next((f"{k}={tags[k]}" for k in ("building", "barrier", "man_made", "bridge") if k in tags), ""),
            "coverage": COVERAGE[category],
            "geometry": "polygon" if closed and category not in ("barrier",) else ("point" if len(pts) == 1 else "line"),
            "points": pts,
            "height_m": round(height, 1),
            "height_source": height_source,
            "distance_to_track_m": round(dist_m, 1),
            "nearest_lap_frac": round(frac, 4),
            "nearest_zone_id": zone["zone_id"],
        })

    by_cat: dict[str, int] = {}
    for a in assets:
        by_cat[a["category"]] = by_cat.get(a["category"], 0) + 1
    return {
        "circuit": circuit,
        "source": ATTRIBUTION,
        "alignment": {"method": "similarity transform, trimmed ICP of the OpenF1 reference lap onto OSM raceways",
                      "median_error_m": round(rms_m, 1), "raceways": len(race_lines)},
        "extent_m": round(float(extent_units / units_per_m), 1),
        "counts": dict(sorted(by_cat.items())),
        "assets": sorted(assets, key=lambda a: (a["category"], a["distance_to_track_m"])),
        "context": context,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("circuits", nargs="*", default=list(BBOX))
    ap.add_argument("--offline", action="store_true", help="use data/osm/{circuit}.json instead of downloading")
    args = ap.parse_args()
    for circuit in args.circuits:
        osm = json.loads((OSM_DIR / f"{circuit}.json").read_text()) if args.offline else fetch(circuit)
        out = build(circuit, osm)
        path = ROOT_DIR / "tracks" / f"{circuit}_assets.json"
        path.write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")
        print(f"[{circuit}] alignment median error {out['alignment']['median_error_m']} m · {len(out['assets'])} assets {out['counts']} · "
              f"woods {len(out['context']['woods'])}, water {len(out['context']['water'])}, "
              f"pit lane {len(out['context']['pit_lane'])} -> {path.name}")


if __name__ == "__main__":
    main()
