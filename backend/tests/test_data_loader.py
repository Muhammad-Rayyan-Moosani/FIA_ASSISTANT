"""R1 tests: zones, incident extraction and placement. Run offline against the cached data.

    cd backend && python -m pytest tests/test_data_loader.py -q
"""

from __future__ import annotations

import json

import pytest

from services.data_loader import (CIRCUITS, ROOT_DIR, classify, extract_events, kinetic_energy_kj, load_raw,
                                  sector_to_turn, to_records)
from services.geolocate import refine_with_location
from services.zones import build_zones, lap_geometry, load_outline, nearest_index, normaliser, snap

SCHEMA_KEYS = {"incident_id", "circuit", "season", "session_type", "session_key", "lap", "occurred_at",
               "raw_message", "car_numbers", "turn_number", "incident_type", "severity_score", "loss_relevant",
               "x", "y", "lap_frac", "zone_id", "geo_method", "geo_confidence", "entry_speed_kph",
               "kinetic_energy_kj", "extraction"}
INCIDENT_TYPES = {"crash", "spin", "stopped", "debris", "collision", "track_limits", "flag_only", "administrative"}


@pytest.fixture(scope="module")
def monza():
    cfg = CIRCUITS["monza"]
    sessions, points, lap = load_raw(cfg)
    inventory = json.loads((ROOT_DIR / "tracks" / "monza_inventory.json").read_text(encoding="utf-8"))
    geo = lap_geometry(lap, cfg.length_m)
    zones = build_zones(cfg, geo, points["turns"], points["marshal_sectors"], inventory)
    events, skipped = extract_events(sessions, len(points["marshal_sectors"]))
    records = to_records(cfg, events, zones, geo, normaliser(geo), points["turns"], points["marshal_sectors"])
    return {"cfg": cfg, "points": points, "geo": geo, "zones": zones, "records": records, "skipped": skipped,
            "sessions": sessions, "norm": normaliser(geo)}


def msg(t: str, text: str, flag: str | None = None, sector: int | None = None) -> dict:
    return {"date": f"2025-09-07T13:{t}+00:00", "message": text, "flag": flag, "sector": sector, "lap_number": 5}


def session(*messages: dict) -> list[dict]:
    return [{"session_key": 1, "year": 2025, "session_name": "Race", "messages": list(messages)}]


# ----------------------------------------------------------------------------- zones
def test_zone_count_in_target_range(monza):
    assert 10 <= len(monza["zones"]) <= 16


def test_zones_cover_the_lap_without_gaps(monza):
    zones = monza["zones"]
    assert zones[0]["start_frac"] == 0.0 and zones[-1]["end_frac"] == 1.0
    for a, b in zip(zones, zones[1:]):
        assert a["end_frac"] == b["start_frac"]


def test_every_official_turn_is_in_exactly_one_zone(monza):
    placed = [t for z in monza["zones"] for t in z["turns"]]
    assert sorted(placed) == [t["number"] for t in monza["points"]["turns"]]


def test_monza_braking_zones_are_the_real_corners(monza):
    braking = {z["name"] for z in monza["zones"] if z["zone_type"] == "braking"}
    assert braking == {"Variante del Rettifilo", "Variante della Roggia", "Lesmo 1", "Lesmo 2",
                       "Variante Ascari", "Curva Alboreto (Parabolica)"}


def test_marshal_posts_all_counted(monza):
    assert sum(z["marshal_posts"] for z in monza["zones"]) == len(monza["points"]["marshal_sectors"])


# ----------------------------------------------------------------------------- extraction
@pytest.mark.parametrize("text, kind, loss", [
    ("CAR 22 (TSU) TIME 1:22.241 DELETED - TRACK LIMITS AT TURN 11 LAP 5 15:09:44", "track_limits", False),
    ("TURN 1 INCIDENT INVOLVING CARS 1 (VER) AND 4 (NOR) NOTED - CAUSING A COLLISION", "collision", True),
    ("TURN 4 INCIDENT INVOLVING CAR 55 (SAI) NOTED - FORCING ANOTHER DRIVER OFF THE TRACK", "collision", True),
    ("CAR 2 (SAR) OFF TRACK AND CONTINUED AT TURN 10", "spin", False),
    ("TURN 1 INCIDENT INVOLVING CAR 10 (GAS) NOTED - FAILING TO FOLLOW RACE DIRECTORS INSTRUCTIONS", "administrative", False),
    ("PIT LANE INCIDENT INVOLVING CAR 4 (NOR) NOTED - UNSAFE RELEASE", "administrative", False),
])
def test_classification(text, kind, loss):
    got_kind, _, got_loss, _ = classify(text)
    assert (got_kind, got_loss) == (kind, loss)


def test_steward_incident_counted_once_and_takes_the_later_reason():
    events, _ = extract_events(session(
        msg("00:00", "TURN 1 INCIDENT INVOLVING CARS 1 (VER) AND 4 (NOR) NOTED"),
        msg("02:00", "FIA STEWARDS: TURN 1 INCIDENT INVOLVING CARS 1 (VER) AND 4 (NOR) UNDER INVESTIGATION - CAUSING A COLLISION"),
    ), n_sectors=17)
    assert len(events) == 1
    assert events[0].rule == "collision" and events[0].message["date"].endswith("13:00:00+00:00")


def test_spin_and_its_correction_count_once():
    events, _ = extract_events(session(
        msg("00:00", "CAR 44 (HAM) SPUN AND CONTINUED AT TURN 4"),
        msg("00:30", "CORRECTION: CAR 44 (HAM) OFF TRACK AND CONTINUED TURN 4 - LAP 21"),
    ), n_sectors=17)
    assert len(events) == 1


def test_yellows_merge_and_warning_yellow_dropped():
    events, _ = extract_events(session(
        msg("00:00", "YELLOW IN TRACK SECTOR 7", "YELLOW", 7),          # warning for sector 8
        msg("00:01", "YELLOW IN TRACK SECTOR 8", "YELLOW", 8),
        msg("00:10", "DOUBLE YELLOW IN TRACK SECTOR 8", "DOUBLE YELLOW", 8),
        msg("04:00", "DOUBLE YELLOW IN TRACK SECTOR 8", "DOUBLE YELLOW", 8),
        msg("40:00", "YELLOW IN TRACK SECTOR 8", "YELLOW", 8),          # much later: a new event
    ), n_sectors=17)
    assert [(e.sector, e.incident_type) for e in events] == [(8, "stopped"), (8, "flag_only")]


def test_admin_messages_without_a_place_are_counted_not_placed():
    events, skipped = extract_events(session(
        msg("00:00", "PIT LANE INCIDENT INVOLVING CAR 4 (NOR) NOTED - UNSAFE RELEASE"),
        msg("01:00", "SAFETY CAR DEPLOYED"),
    ), n_sectors=17)
    assert events == [] and skipped["no_location_admin"] == 1 and skipped["safety_car"] == 1


# ----------------------------------------------------------------------------- records
def test_records_follow_the_schema(monza):
    zone_ids = {z["zone_id"] for z in monza["zones"]}
    for r in monza["records"]:
        assert SCHEMA_KEYS <= set(r)
        assert r["incident_type"] in INCIDENT_TYPES
        assert r["zone_id"] in zone_ids
        assert 0 <= r["lap_frac"] <= 1 and 0 <= r["x"] <= 1 and 0 <= r["y"] <= 1
        assert r["geo_method"] in {"turn_in_message", "marshal_sector", "driver_location"}


def test_incident_ids_unique(monza):
    ids = [r["incident_id"] for r in monza["records"]]
    assert len(ids) == len(set(ids))


def test_every_loss_relevant_message_is_placed(monza):
    assert monza["skipped"]["no_location_loss_relevant"] == 0


def test_every_marshal_sector_maps_to_a_turn(monza):
    mapping = sector_to_turn(monza["geo"], monza["points"]["turns"], monza["points"]["marshal_sectors"])
    assert set(mapping) == {m["number"] for m in monza["points"]["marshal_sectors"]}


def test_kinetic_energy_matches_architecture_example():
    assert kinetic_energy_kj(331) == pytest.approx(3372.4, rel=1e-3)   # ARCHITECTURE.md §4.4


def test_all_seasons_and_sessions_cached(monza):
    assert len(monza["sessions"]) == 20 and {s["year"] for s in monza["sessions"]} == {2023, 2024, 2025, 2026}


# ----------------------------------------------------------------------------- car location (from Yash's step)
class FakeLocations:
    """Stands in for OpenF1Client.location: two cars that meet at (x, y) 10 s before the note."""

    def __init__(self, x: float, y: float):
        self.x, self.y = x, y

    def location(self, session_key, driver, date_from, date_to):
        from datetime import datetime, timedelta

        t = datetime.fromisoformat(date_to + "+00:00") - timedelta(seconds=10)
        offset = 0 if driver % 2 else 20                  # the cars are 2 m apart at the contact moment
        return [{"date": (t + timedelta(seconds=k)).isoformat(), "x": self.x + offset + 500 * abs(k), "y": self.y}
                for k in range(-3, 4)]


def _two_car_record(monza):
    r = next(r for r in monza["records"] if r["loss_relevant"] and len(r["car_numbers"]) >= 2)
    return dict(r)


def _run(monza, record, client, tmp_path, monkeypatch):
    import services.data_loader as dl
    monkeypatch.setattr(dl, "DATA_DIR", tmp_path)         # keep the real contact cache untouched
    return refine_with_location([record], "monza", monza["geo"], monza["norm"], monza["zones"], client=client)


def test_contact_near_named_turn_gives_exact_spot(monza, tmp_path, monkeypatch):
    r = _two_car_record(monza)
    turn = next(t for t in monza["points"]["turns"] if t["number"] == r["turn_number"])
    stats = _run(monza, r, FakeLocations(turn["x"], turn["y"]), tmp_path, monkeypatch)
    assert stats["agrees_with_turn"] == 1
    assert r["geo_method"] == "driver_location" and r["geo_confidence"] == "high"


def test_contact_far_from_named_turn_keeps_the_turn(monza, tmp_path, monkeypatch):
    r = _two_car_record(monza)
    far = monza["geo"]["x"][nearest_index(monza["geo"], 0, 0) - 60], monza["geo"]["y"][0]
    stats = _run(monza, r, FakeLocations(*far), tmp_path, monkeypatch)
    assert stats["agrees_with_turn"] == 0 and r["geo_method"] == "turn_in_message"


def test_offline_without_cache_keeps_the_turn(monza, tmp_path, monkeypatch):
    r = _two_car_record(monza)
    stats = _run(monza, r, None, tmp_path, monkeypatch)
    assert stats["not_checked"] == 1 and r["geo_method"] == "turn_in_message"


def test_build_turn_map_helpers_still_work():
    # scripts/build_turn_map.py relies on these
    xy, frac = load_outline("monza")
    f, d = snap(xy, frac, xy[100, 0], xy[100, 1])
    assert f == pytest.approx(frac[100]) and d == 0


@pytest.mark.parametrize("circuit", ["monza", "montreal"])
def test_every_circuit_builds_valid_zones(circuit):
    cfg = CIRCUITS[circuit]
    sessions, points, lap = load_raw(cfg)
    inventory = json.loads((ROOT_DIR / "tracks" / f"{circuit}_inventory.json").read_text(encoding="utf-8"))
    zones = build_zones(cfg, lap_geometry(lap, cfg.length_m), points["turns"], points["marshal_sectors"], inventory)
    assert 10 <= len(zones) <= 16
    assert sorted(t for z in zones for t in z["turns"]) == [t["number"] for t in points["turns"]]
    assert len(sessions) == 20
