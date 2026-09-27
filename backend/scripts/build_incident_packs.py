"""Race control · real incident packs for replay on the unified map.

    cd backend && python -m scripts.build_incident_packs              # monza and montreal
    cd backend && python -m scripts.build_incident_packs montreal --max 14

For each counted crash in the Step 1 incident data (services/crash_filter.py: double yellows, confirmed
collisions, crashes / stopped cars, debris) from seasons OpenF1 has car telemetry for (2023+):

1. car_data (speed, throttle, brake) and location for every car on track from 45 s before the race-control
   message to 20 s after it (one request per stream, all drivers at once)
2. the physics collision estimator (services/race_control/collision.py) on each car -> who crashed, when,
   at what speed and load
3. team radio clips of the involved drivers released within 5 minutes after (URL only; the audio stays on
   F1's server and is fetched on demand for the multimodal severity model)
4. driver names and team colours for the session

-> data/race_control/{circuit}_incidents.json. Everything is real OpenF1 data; nothing is synthesised.
Incidents are picked round-robin across zones, newest first, so the pack covers the whole lap.
"""
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from datetime import datetime, timedelta

import numpy as np

from openf1_extract import OpenF1Client
from services import crash_filter
from services.data_loader import CIRCUITS, ROOT_DIR
from services.race_control import collision
from services.zones import UNITS_PER_M

OUT_DIR = ROOT_DIR / "race_control"
CACHE_DIR = ROOT_DIR / "replay" / "openf1_cache"
BEFORE_S, AFTER_S = 45.0, 20.0
RADIO_AFTER_S, RADIO_BEFORE_S = 300.0, 30.0
MIN_SEASON = 2023


def _iso(d: datetime) -> str:
    return d.strftime("%Y-%m-%dT%H:%M:%S")


def _ts(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


SESSION_ORDER = {"Race": 0, "Sprint": 1, "Qualifying": 2, "Sprint Qualifying": 3, "Sprint Shootout": 3}


def pick(incidents: list[dict], max_packs: int) -> list[dict]:
    """Candidates round-robin across zones: races before sprints, qualifying and practice; newest first."""
    events = [e for e in crash_filter.crash_events(incidents) if e.get("season", 0) >= MIN_SEASON and e.get("session_key")]
    by_zone: dict[str, list[dict]] = defaultdict(list)
    for e in sorted(events, key=lambda e: (SESSION_ORDER.get(e["session_type"], 4), -e["season"], e["occurred_at"])):
        by_zone[e["zone_id"]].append(e)
    chosen: list[dict] = []
    while len(chosen) < max_packs and any(by_zone.values()):
        for z in sorted(by_zone, key=lambda z: -len(by_zone[z])):
            if by_zone[z] and len(chosen) < max_packs:
                chosen.append(by_zone[z].pop(0))
    return sorted(chosen, key=lambda e: e["occurred_at"])


def build_pack(client: OpenF1Client, inc: dict) -> dict | None:
    at = _ts(inc["occurred_at"])
    t0, t1 = at - timedelta(seconds=BEFORE_S), at + timedelta(seconds=AFTER_S)
    sk = inc["session_key"]
    # the client writes key=value, so ("date>", t) becomes date>=t
    window = (("session_key", sk), ("date>", _iso(t0)), ("date<", _iso(t1)))
    car = client.get("car_data", *window)
    loc = client.get("location", *window)
    if not car or not loc:
        return None

    # align position to each car_data sample (nearest location sample of the same driver)
    loc_by: dict[int, tuple[np.ndarray, np.ndarray, np.ndarray]] = {}
    grouped: dict[int, list[dict]] = defaultdict(list)
    for r in loc:
        grouped[r["driver_number"]].append(r)
    for d, rows in grouped.items():
        rows.sort(key=lambda r: r["date"])
        loc_by[d] = (np.array([(_ts(r["date"]) - t0).total_seconds() for r in rows]),
                     np.array([r["x"] for r in rows], float), np.array([r["y"] for r in rows], float))

    samples: dict[str, list[list[float]]] = {}
    per_car: dict[str, tuple] = {}
    by_driver: dict[int, list[dict]] = defaultdict(list)
    for r in car:
        by_driver[r["driver_number"]].append(r)
    for d, rows in by_driver.items():
        if d not in loc_by:
            continue
        rows.sort(key=lambda r: r["date"])
        lt, lx, ly = loc_by[d]
        t = np.array([(_ts(r["date"]) - t0).total_seconds() for r in rows])
        idx = np.clip(np.searchsorted(lt, t), 0, len(lt) - 1)
        x, y = lx[idx], ly[idx]
        keep = ~((x == 0) & (y == 0))
        if keep.sum() < 8:
            continue
        v = np.array([r["speed"] for r in rows], float)
        thr = np.array([r["throttle"] for r in rows], float)
        brk = np.array([r["brake"] for r in rows], float)
        samples[str(d)] = [[round(float(a), 2), float(b), float(c), float(e), float(f), float(g)]
                           for a, b, c, e, f, g in zip(t[keep], v[keep], thr[keep], brk[keep], x[keep], y[keep])]
        per_car[str(d)] = (t[keep], v[keep], x[keep] / UNITS_PER_M, y[keep] / UNITS_PER_M)

    detected = []
    for d, (t, v, x, y) in per_car.items():
        for est in collision.estimate(d, t, v, x, y):
            detected.append(est.to_dict())
    named = [str(c) for c in inc.get("car_numbers") or []]
    detected.sort(key=lambda e: (e["driver"] not in named, {"crash": 0, "incident": 1}[e["level"]], -e["telemetry_score"]))
    involved = list(dict.fromkeys(named + [e["driver"] for e in detected][:2]))

    radio = []
    if involved:
        rows = client.get("team_radio", ("session_key", sk))
        for r in rows:
            dt = (_ts(r["date"]) - at).total_seconds()
            if str(r["driver_number"]) in involved and -RADIO_BEFORE_S <= dt <= RADIO_AFTER_S:
                radio.append({"driver": str(r["driver_number"]), "date": r["date"], "offset_s": round(dt, 1),
                              "url": r["recording_url"]})
    drivers = {}
    for r in client.get("drivers", ("session_key", sk)):
        if str(r["driver_number"]) in samples:
            drivers[str(r["driver_number"])] = {"code": r.get("name_acronym"), "name": r.get("full_name"),
                                                "team": r.get("team_name"), "colour": r.get("team_colour")}
    return {
        "incident_id": inc["incident_id"], "season": inc["season"], "session_key": sk,
        "session_type": inc["session_type"], "occurred_at": inc["occurred_at"], "raw_message": inc["raw_message"],
        "rule": crash_filter._rule(inc), "zone_id": inc["zone_id"], "marshal_sector": inc.get("marshal_sector"),
        "car_numbers": named, "window_start": t0.isoformat(), "message_offset_s": BEFORE_S,
        "involved": involved, "detected": detected[:6], "radio": sorted(radio, key=lambda r: r["offset_s"]),
        "drivers": drivers, "samples": samples,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("circuits", nargs="*", default=["monza", "montreal"])
    ap.add_argument("--max", type=int, default=12)
    args = ap.parse_args()
    client = OpenF1Client(CACHE_DIR, requests_per_minute=25)   # OpenF1 free tier: 30 requests / minute
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for circuit in args.circuits:
        incidents = json.loads((ROOT_DIR / "incidents" / f"{circuit}.json").read_text())
        packs = []
        for inc in pick(incidents, args.max * 2):
            pack = build_pack(client, inc)
            if pack:
                packs.append(pack)
                crash = pack["detected"][0] if pack["detected"] else None
                print(f"[{circuit}] {inc['incident_id']:32s} {inc['raw_message'][:48]:48s} "
                      f"involved={pack['involved']} impact={crash and round(crash['impact_speed_kph'])} radio={len(pack['radio'])}")
        # keep the packs where the telemetry shows who crashed (then the rest), up to --max
        seen = lambda p: bool(p["detected"])  # noqa: E731
        packs = sorted(sorted(packs, key=lambda p: (not seen(p), not p["radio"], not p["involved"]))[: args.max],
                       key=lambda p: p["occurred_at"])
        out = {"circuit": circuit, "source": "OpenF1 car_data, location, team_radio, drivers; race control via Step 1",
               "built_from": f"{len(packs)} counted crashes (crash_filter), seasons {MIN_SEASON}+",
               "incidents": packs}
        path = OUT_DIR / f"{circuit}_incidents.json"
        path.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
        print(f"[{circuit}] {len(packs)} packs -> {path} ({path.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
