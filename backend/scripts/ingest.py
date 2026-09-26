"""R1 pipeline (Step 1): OpenF1 -> zones + placed incidents.

    cd backend && python -m scripts.ingest monza              # cache in data/openf1, look up new contacts online
    cd backend && python -m scripts.ingest monza --offline    # cache only, no network at all
    cd backend && python -m scripts.ingest monza --refresh    # re-download everything first

Writes:
    data/tracks/{circuit}.json      outline + zones + safety inventory + data coverage (§4.3)
    data/incidents/{circuit}.json   placed incident records (§4.4)
"""

from __future__ import annotations

import argparse
import json

from services.data_loader import CIRCUITS, ROOT_DIR, coverage, extract_events, fetch_raw, load_raw, to_records
from services.geolocate import refine_with_location
from services.openf1_client import OpenF1Client
from services.zones import build_zones, lap_geometry, nearest_index, normaliser, outline


def ingest(circuit: str, refresh: bool = False, offline: bool = False) -> tuple[dict, list[dict]]:
    cfg = CIRCUITS[circuit]
    if not offline:
        fetch_raw(cfg, refresh=refresh)
    sessions, points, lap = load_raw(cfg)
    inventory = json.loads((ROOT_DIR / "tracks" / f"{cfg.id}_inventory.json").read_text(encoding="utf-8"))

    geo = lap_geometry(lap, cfg.length_m)
    norm = normaliser(geo)
    zones = build_zones(cfg, geo, points["turns"], points["marshal_sectors"], inventory)
    events, skipped = extract_events(sessions, len(points["marshal_sectors"]))
    records = to_records(cfg, events, zones, geo, norm, points["turns"], points["marshal_sectors"])

    # Two-car incidents: exact contact point from car positions where it agrees with the named turn.
    if offline:
        location_stats = refine_with_location(records, cfg.id, geo, norm, zones)
    else:
        with OpenF1Client() as client:
            location_stats = refine_with_location(records, cfg.id, geo, norm, zones, refresh=refresh, client=client)

    for z in zones:
        z["n_incidents"] = sum(r["zone_id"] == z["zone_id"] for r in records)
        z["n_loss_relevant"] = sum(r["zone_id"] == z["zone_id"] and r["loss_relevant"] for r in records)

    turn_frac = {t["number"]: float(geo["frac"][nearest_index(geo, t["x"], t["y"])]) for t in points["turns"]}
    track = {
        "circuit": cfg.id,
        "name": cfg.name,
        "length_m": round(geo["length_m"]),
        "reference_lap": f"data/openf1/{cfg.reference_lap}",
        "rotation_deg": points.get("rotation_deg", 0),
        "outline": outline(geo, norm),
        "turns": [{"number": t["number"], "name": cfg.turn_names.get(t["number"]),
                   "x": round(float(norm(t["x"], t["y"])[0]), 4), "y": round(float(norm(t["x"], t["y"])[1]), 4),
                   "lap_frac": round(turn_frac[t["number"]], 4)} for t in points["turns"]],
        "zones": zones,
        "grandstands_unmapped": inventory["grandstands"].get("unmapped", []),
        "data_coverage": {**coverage(sessions, records, skipped), "car_location_check": location_stats},
        "sources": {
            "incidents_and_lap": "OpenF1 (openf1.org)",
            "turns_and_marshal_sectors": points["source"],
            "grandstands": inventory["grandstands"]["source"],
            "barrier_runoff_fence_asset": inventory["defaults_by_zone_type"]["source"],
        },
    }
    for folder, payload in (("tracks", track), ("incidents", records)):
        path = ROOT_DIR / folder / f"{cfg.id}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, indent=1, ensure_ascii=False), encoding="utf-8")
    return track, records


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("circuits", nargs="*", default=["monza"], help=f"any of {sorted(CIRCUITS)}")
    parser.add_argument("--refresh", action="store_true", help="re-download from OpenF1 / MultiViewer")
    parser.add_argument("--offline", action="store_true", help="use cached data only (no network)")
    args = parser.parse_args()
    for circuit in args.circuits:
        track, records = ingest(circuit, args.refresh, args.offline)
        cov = track["data_coverage"]
        print(f"[{circuit}] {len(track['zones'])} zones, {cov['incidents']} incidents "
              f"({cov['loss_relevant']} loss-relevant) from {len(cov['sessions'])} sessions "
              f"{cov['seasons'][0]}–{cov['seasons'][-1]}; car-location check: {cov['car_location_check']}")
        for z in track["zones"]:
            print(f"  {z['zone_id']:<10} {z['zone_type']:<10} {z['n_incidents']:>3} incidents "
                  f"({z['n_loss_relevant']:>2} loss-relevant)  {z['name']}")


if __name__ == "__main__":
    main()
