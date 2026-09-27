"""Step 1 · Insured structures around each circuit from OpenStreetMap, aligned to the OpenF1 track frame.

    cd backend && python -m scripts.fetch_osm_assets                 # monza and montreal
    cd backend && python -m scripts.fetch_osm_assets monza --offline  # re-align from the cached download

1. Download buildings, grandstands, barriers, towers, bridges, raceways, woods and water around the
   circuit from the Overpass API -> data/osm/{circuit}.json, plus the surroundings (rivers and lakes as full
   multipolygons, islands, beaches, grass, parking, roads, rail, city buildings) -> data/osm/{circuit}_context.json
   (raw caches, © OpenStreetMap contributors, ODbL).
2. Align: OSM lat/lon -> local metres -> the OpenF1 x/y frame of the reference lap, by fitting a similarity
   transform (rotation, scale, shift, optional mirror) that lays OSM's raceway onto the real lap (trimmed ICP).
3. Classify every structure within reach of the track into what a circuit's insurance programme covers
   (property, spectator liability, business interruption, broadcast equipment, track infrastructure).
4. Grandstands missing from OSM (temporary F1 stands) are placed from the official grandstand list in
   data/tracks/{circuit}_inventory.json: the corner is official, the footprint and exact offset are assumed.
5. Write data/tracks/{circuit}_assets.json in the same [0, 1]² frame as data/tracks/{circuit}.json.
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
OVERPASS_URLS = ("https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter",
                 "https://maps.mail.ru/osm/tools/overpass/api/interpreter")
ATTRIBUTION = "© OpenStreetMap contributors (ODbL)"

# south, west, north, east around each circuit
BBOX = {"monza": (45.600, 9.265, 45.640, 9.300), "montreal": (45.492, -73.540, 45.515, -73.515)}

CONTEXT_PAD_DEG = 0.006      # surroundings are fetched a little beyond the circuit bbox
WATER_REACH_M = 8000         # rivers and lakes are clipped this far from the circuit (into the distance haze)
RIVER_AREA_M2 = 2e6          # water bigger than this is a river / open water, drawn beneath everything else
CONTEXT_BUILDING_M = 1200    # city buildings (context only, not insured) this close to the track
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

CONTEXT_QUERIES = ("""[out:json][timeout:240];
(
  relation["natural"="water"]({b});
  way["place"~"^(island|islet)$"]({b});
  relation["place"~"^(island|islet)$"]({b});
  way["natural"~"^(beach|sand|grassland|scrub)$"]({b});
  way["landuse"~"^(grass|meadow|recreation_ground|village_green)$"]({b});
  way["leisure"~"^(pitch|garden|golf_course)$"]({b});
  way["amenity"="parking"]({b});
);
out geom;""", """[out:json][timeout:240];
(
  way["highway"]["highway"!~"^(raceway|proposed|construction|steps|elevator|platform|bus_stop|corridor|services)$"]["area"!="yes"]({b});
  way["railway"~"^(rail|light_rail)$"]["tunnel"!="yes"]({b});
);
out geom;""", """[out:json][timeout:240];
way["building"]({b});
out geom;""")

# Road widths by class (typical carriageway widths; OSM rarely tags width). Context only, not insured.
ROAD_WIDTH_M = {"motorway": 22, "trunk": 18, "primary": 13, "secondary": 11, "tertiary": 9, "unclassified": 7,
                "residential": 7, "living_street": 6, "service": 5, "pedestrian": 5, "track": 3.5, "cycleway": 2.5,
                "footway": 2.2, "path": 2.2, "bridleway": 2.2}
ROAD_KIND = {"motorway": "major", "trunk": "major", "primary": "major", "secondary": "major", "tertiary": "minor",
             "unclassified": "minor", "residential": "minor", "living_street": "minor", "service": "service",
             "pedestrian": "path", "track": "path", "cycleway": "path", "footway": "path", "path": "path",
             "bridleway": "path"}
ROAD_REACH_M = {"major": 3000, "rail": 3000, "minor": 1500, "service": 900, "path": 500}

# Temporary grandstands placed from the official list (when OSM has none): assumed footprint.
STAND_DEPTH_M = 20
STAND_MAX_LEN_M = 60
STAND_MIN_LEN_M = 24
STAND_CLEAR_OF_TRACK_M = 11

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
def _overpass(query: str, bbox: tuple[float, float, float, float]) -> dict:
    q = query.replace("{b}", ",".join(str(round(v, 4)) for v in bbox))
    for attempt in range(6):
        url = OVERPASS_URLS[attempt % len(OVERPASS_URLS)]
        try:
            r = httpx.post(url, data={"data": q}, headers={"User-Agent": "FIA-Assistant/1.0"}, timeout=300)
        except httpx.HTTPError:
            continue
        if r.status_code == 200:
            return r.json()
        time.sleep(5 * (attempt + 1))
    r.raise_for_status()
    raise RuntimeError("Overpass unavailable")


def context_bbox(circuit: str) -> tuple[float, float, float, float]:
    s, w, n, e = BBOX[circuit]
    return s - CONTEXT_PAD_DEG, w - CONTEXT_PAD_DEG, n + CONTEXT_PAD_DEG, e + CONTEXT_PAD_DEG


def fetch(circuit: str) -> tuple[dict, dict]:
    OSM_DIR.mkdir(parents=True, exist_ok=True)
    data = _overpass(QUERY, BBOX[circuit])
    (OSM_DIR / f"{circuit}.json").write_text(json.dumps({"source": ATTRIBUTION, "bbox": BBOX[circuit], **data}))
    time.sleep(2)
    ctx = {"elements": []}
    for q in CONTEXT_QUERIES:
        time.sleep(2)
        ctx["elements"] += _overpass(q, context_bbox(circuit))["elements"]
    (OSM_DIR / f"{circuit}_context.json").write_text(json.dumps({"source": ATTRIBUTION, "bbox": context_bbox(circuit), **ctx}))
    return data, ctx


def load_cached(circuit: str) -> tuple[dict, dict]:
    read = lambda name: json.loads((OSM_DIR / name).read_text())  # noqa: E731
    return read(f"{circuit}.json"), read(f"{circuit}_context.json")


# ----------------------------------------------------------------------------- polygons
def _rings(members: list[dict], roles: tuple[str, ...]) -> list[list[tuple[float, float]]]:
    """Join a multipolygon's member ways (by shared end nodes) into closed rings of (lat, lon)."""
    ways = [[(p["lat"], p["lon"]) for p in m["geometry"] if p] for m in members
            if m.get("type") == "way" and (m.get("role") or "outer") in roles and m.get("geometry")]
    rings = []
    while ways:
        cur = ways.pop()
        joined = True
        while cur[0] != cur[-1] and joined:
            joined = False
            for i, w in enumerate(ways):
                if w[0] == cur[-1]:
                    cur = cur + w[1:]
                elif w[-1] == cur[-1]:
                    cur = cur + w[::-1][1:]
                elif w[-1] == cur[0]:
                    cur = w + cur[1:]
                elif w[0] == cur[0]:
                    cur = w[::-1] + cur[1:]
                else:
                    continue
                ways.pop(i)
                joined = True
                break
        if cur[0] == cur[-1] and len(cur) > 3:
            rings.append(cur)
    return rings


def clip_box(poly: np.ndarray, r: float) -> np.ndarray:
    """Sutherland–Hodgman clip of a polygon (metres) to the square [-r, r]²."""
    out = poly
    for axis, sign in ((0, 1), (0, -1), (1, 1), (1, -1)):
        if len(out) == 0:
            break
        inside = lambda p: sign * p[axis] <= r  # noqa: E731
        res = []
        for i in range(len(out)):
            a, b = out[i - 1], out[i]
            if inside(b):
                if not inside(a):
                    t = (sign * r - a[axis]) / (b[axis] - a[axis])
                    res.append(a + t * (b - a))
                res.append(b)
            elif inside(a):
                t = (sign * r - a[axis]) / (b[axis] - a[axis])
                res.append(a + t * (b - a))
        out = np.array(res)
    return out


def _area(poly: np.ndarray) -> float:
    x, y = poly[:, 0], poly[:, 1]
    return float(abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))) / 2)


def inside_poly(pt: np.ndarray, poly: np.ndarray) -> bool:
    x, y = pt
    xs, ys = poly[:, 0], poly[:, 1]
    xj, yj = np.roll(xs, 1), np.roll(ys, 1)
    cross = ((ys > y) != (yj > y)) & (x < (xj - xs) * (y - ys) / np.where(yj == ys, 1e-12, yj - ys) + xs)
    return bool(np.count_nonzero(cross) % 2)


def _ground_kind(tags: dict) -> str | None:
    if tags.get("natural") == "water" or ("water" in tags and "building" not in tags):
        return "water"
    if tags.get("place") in ("island", "islet"):
        return "land"
    if tags.get("natural") == "wood" or tags.get("landuse") == "forest":
        return "wood"
    if tags.get("natural") in ("beach", "sand"):
        return "beach"
    if tags.get("amenity") == "parking":
        return "parking"
    if tags.get("leisure") == "pitch":
        return "pitch"
    if tags.get("natural") in ("grassland", "scrub") or tags.get("leisure") in ("garden", "golf_course") or \
            tags.get("landuse") in ("grass", "meadow", "recreation_ground", "village_green"):
        return "grass"
    return None


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


def _official_stands(circuit, track, geo, lap_xy, lap_tree, units_per_m, surface_at, pit_f1, norm) -> list[dict]:
    """Place each officially listed grandstand beside the corner it overlooks (official), on land and clear of the
    track: outside of the corner unless the official text says inside; on a straight, opposite the pit lane.
    Footprint (20 m deep, up to 60 m long) and the offset from the track are assumptions."""
    inv_path = ROOT_DIR / "tracks" / f"{circuit}_inventory.json"
    if not inv_path.exists():
        return []
    official = {s["name"]: s.get("official", "") for s in json.loads(inv_path.read_text())["grandstands"]["stands"]}
    x, y, frac = np.asarray(geo["x"], float), np.asarray(geo["y"], float), np.asarray(geo["frac"], float)
    n = len(x)
    tang = np.column_stack([np.roll(x, -1) - np.roll(x, 1), np.roll(y, -1) - np.roll(y, 1)])
    tang /= np.linalg.norm(tang, axis=1)[:, None]
    left = np.column_stack([-tang[:, 1], tang[:, 0]])
    # which side of the track the pit lane runs on, per stretch of the lap (votes from the OSM pit lane)
    bucket = max(1, n // 40)
    pit_side: dict[int, list[float]] = {}
    for line in pit_f1:
        dist, idx = lap_tree.query(line)
        for p, i, d in zip(line, idx, dist):
            if d / units_per_m < 40:
                pit_side.setdefault(int(i) // bucket, []).append(float(np.sign((p - lap_xy[i]) @ left[i])))

    def side_of_pits(i: int) -> float:
        votes = pit_side.get(i // bucket, [])
        return float(np.sign(sum(votes))) if votes else 0.0

    out = []
    for zone in track["zones"]:
        names = zone.get("grandstands") or []
        if not names:
            continue
        idx = np.where((frac >= zone["start_frac"]) & (frac <= zone["end_frac"]))[0]
        if len(idx) < 2:
            continue
        # turning direction over the zone (+1 left, -1 right); outside is the opposite side
        ta, tb = tang[idx[:-1]], tang[idx[1:]]
        turn = float(np.sum(ta[:, 0] * tb[:, 1] - ta[:, 1] * tb[:, 0]))
        corner = abs(turn) > 0.15
        k = len(names)
        length = float(np.clip(zone["length_m"] / k - 6, STAND_MIN_LEN_M, STAND_MAX_LEN_M))
        front0 = float(zone.get("distance_to_stand_m") or 40)
        for j, name in enumerate(names):
            text = official.get(name, "").lower()
            if corner:
                pref = float(np.sign(turn)) if "inside" in text else -float(np.sign(turn))
            else:
                ps = side_of_pits(int(idx[len(idx) // 2]))
                pref = -ps if ps else -float(np.sign(turn) or 1)
            best = None
            for shift in (0.0, 0.12, -0.12, 0.24, -0.24):
                t = min(0.95, max(0.05, (j + 0.5) / k + shift))
                i = int(idx[int(t * (len(idx) - 1))])
                for side in (pref, -pref):
                    for front in (front0, front0 - 10, front0 - 18, front0 + 12, front0 + 25):
                        c = lap_xy[i] + left[i] * side * (front + STAND_DEPTH_M / 2) * units_per_m
                        hl, hd = tang[i] * length / 2 * units_per_m, left[i] * side * STAND_DEPTH_M / 2 * units_per_m
                        corners = np.array([c - hl - hd, c + hl - hd, c + hl + hd, c - hl + hd])
                        probes = np.vstack([corners, c, (corners + c) / 2])
                        if any(surface_at(p) == "water" for p in probes):
                            continue
                        if np.min(lap_tree.query(probes)[0]) / units_per_m < STAND_CLEAR_OF_TRACK_M:
                            continue
                        if any(np.min(np.linalg.norm(o["f1"] - c, axis=1)) < STAND_DEPTH_M * units_per_m for o in out):
                            continue
                        best = corners
                        break
                    if best is not None:
                        break
                if best is not None:
                    break
            if best is None:
                continue
            nx, ny = norm(best[:, 0], best[:, 1])
            ring = [[round(float(a), 5), round(float(b), 5)] for a, b in zip(nx, ny)]
            out.append({"asset_id": f"official-{re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')}", "name": name,
                        "f1": best, "points": ring + [ring[0]]})
    return out


def build(circuit: str, osm: dict, ctx: dict) -> dict:
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

    pit_f1: list[np.ndarray] = []
    assets, context = [], {"woods": [], "pit_lane": [], "other_raceways": [], "ground": [], "roads": [], "buildings": []}
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
                pit_f1.append(f1)
            elif dist_m > 15:                               # old oval, junior loops: not the Grand Prix line
                context["other_raceways"].append(pts)
            continue
        if tags.get("natural") == "wood" or tags.get("landuse") == "forest":
            if closed:
                context["woods"].append(pts)
            continue
        if tags.get("natural") == "water" or "water" in tags:
            continue                                        # drawn from the ground layers below

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
            "position_source": "osm",
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

    # ---- surroundings: ground layers in painter's order. Tiers: open water, then land (islands), then land cover
    # (woods, grass, beaches, parking), then lakes and basins on top, then islands in those lakes; largest first.
    def norm_m(poly_m: np.ndarray) -> list[list[float]]:
        f1 = to_f1(poly_m)
        nx, ny = norm(f1[:, 0], f1[:, 1])
        return [[round(float(a), 5), round(float(b), 5)] for a, b in zip(nx, ny)]

    seen, ground = set(), []
    for e in [*els, *ctx["elements"]]:
        key = (e["type"], e["id"])
        if key in seen:
            continue
        seen.add(key)
        tags = e.get("tags", {})
        kind = _ground_kind(tags)
        if kind is None:
            continue
        if e["type"] == "relation":
            outers = _rings(e.get("members", []), ("outer",))
            inners = _rings(e.get("members", []), ("inner",))
        elif e.get("geometry") and len(e["geometry"]) > 3 and e["geometry"][0] == e["geometry"][-1]:
            outers, inners = [[(p["lat"], p["lon"]) for p in e["geometry"]]], []
        else:
            continue
        to_poly = lambda ring: clip_box(_local_metres(np.array([p[0] for p in ring]), np.array([p[1] for p in ring]), lat0, lon0), WATER_REACH_M)  # noqa: E731
        polys = [p for p in map(to_poly, outers) if len(p) >= 3 and _area(p) > 150]
        if kind == "water":
            river = sum(map(_area, polys)) >= RIVER_AREA_M2
            tier, inner_tier = (0, 1) if river else (3, 4)
        else:
            tier, inner_tier = (1 if kind == "land" else 2), None
        ground += [(tier, _area(p), kind, p) for p in polys]
        if inner_tier is not None:
            ground += [(inner_tier, _area(p), "land", p) for p in map(to_poly, inners) if len(p) >= 3 and _area(p) > 150]
    ground.sort(key=lambda g: (g[0], -g[1]))
    context["ground"] = [{"kind": k, "points": norm_m(p)} for _, _, k, p in ground]
    ground_f1 = [(k, to_f1(p)) for _, _, k, p in ground]

    def surface_at(pt: np.ndarray) -> str:
        kind = "land"
        for k, poly in ground_f1:
            if inside_poly(pt, poly):
                kind = k
        return kind

    asset_ids = {a["asset_id"] for a in assets}
    for e in ctx["elements"]:
        tags, geom = e.get("tags", {}), e.get("geometry")
        if e["type"] != "way" or not geom or f"osm-way-{e['id']}" in asset_ids:
            continue
        if "highway" in tags or "railway" in tags:
            hw = tags.get("highway")
            kind = "rail" if "railway" in tags else ROAD_KIND.get(hw or "")
            if kind is None:
                continue
            f1, pts = project(geom)
            if track_distance(f1)[0] > ROAD_REACH_M[kind]:
                continue
            m = re.match(r"[\d.]+", tags.get("width", ""))
            width = float(m.group()) if m and hw not in ("footway", "path", "cycleway") else (4.0 if kind == "rail" else ROAD_WIDTH_M[hw])
            context["roads"].append({"kind": kind, "width_m": round(min(width, 30.0), 1), "bridge": "bridge" in tags and tags["bridge"] != "no",
                                     "points": pts})
        elif "building" in tags and len(geom) > 3 and geom[0] == geom[-1]:
            f1, pts = project(geom)
            if track_distance(f1)[0] > CONTEXT_BUILDING_M:
                continue
            h, _ = _height(tags, "building")
            context["buildings"].append({"height_m": round(min(h, 120.0), 1), "points": pts})

    # ---- temporary grandstands from the official list (only when OSM maps none around the track)
    placed_stands = []
    if not any(a["category"] == "grandstand" for a in assets):
        placed_stands = _official_stands(circuit, track, geo, lap_xy, lap_tree, units_per_m, surface_at, pit_f1, norm)
    for st in placed_stands:
        dist_m, frac = track_distance(st["f1"])
        zone = zone_for_frac(track["zones"], frac)
        assets.append({
            "asset_id": st["asset_id"],
            "position_source": "official_list",
            "name": st["name"],
            "category": "grandstand",
            "osm_tag": "",
            "coverage": COVERAGE["grandstand"],
            "geometry": "polygon",
            "points": st["points"],
            "height_m": DEFAULT_HEIGHT_M["grandstand"],
            "height_source": "assumed",
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
        "official_stands": len(placed_stands),
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
        osm, ctx = load_cached(circuit) if args.offline else fetch(circuit)
        out = build(circuit, osm, ctx)
        path = ROOT_DIR / "tracks" / f"{circuit}_assets.json"
        path.write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
        print(f"[{circuit}] alignment median error {out['alignment']['median_error_m']} m · {len(out['assets'])} assets {out['counts']} · "
              f"official stands {out['official_stands']} · ground {len(out['context']['ground'])}, "
              f"roads {len(out['context']['roads'])}, city buildings {len(out['context']['buildings'])} -> {path.name}")


if __name__ == "__main__":
    main()
