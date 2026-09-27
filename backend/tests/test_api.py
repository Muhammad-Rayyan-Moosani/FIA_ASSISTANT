"""R3 · API contract tests against the real Monza Step 1 data (offline).

    cd backend && python -m pytest tests/test_api.py -q
"""

from __future__ import annotations

import json
import warnings
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from api import schemas as s
from config.settings import settings
from main import app

ROOT = Path(__file__).resolve().parents[2]

warnings.filterwarnings("ignore", module="insurance_model")
settings.sim_stream_delay_s = 0
client = TestClient(app)
API = "/api/insurance"


def sse_events(body: str) -> list[tuple[str, dict]]:
    out = []
    for block in body.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.splitlines())
        out.append((lines["event"], json.loads(lines["data"])))
    return out


def test_monza_and_montreal_are_the_circuits():
    circuits = client.get(f"{API}/circuits").json()
    assert [c["id"] for c in circuits] == ["monza", "montreal"]
    for c in circuits:
        s.CircuitSummary.model_validate(c)
        assert c["coverage"]["incidents"] > 0


@pytest.mark.parametrize("circuit", ["montreal"])
def test_montreal_track_and_risk_map(circuit):
    t = s.TrackGeometry.model_validate(client.get(f"{API}/tracks/{circuit}").json())
    rm = s.RiskMap.model_validate(client.get(f"{API}/risk-map", params={"circuit": circuit}).json())
    assert {z.zone_id for z in t.zones} == {z.zone_id for z in rm.zones}
    assert t.reference.session_key == 9963


@pytest.mark.parametrize("circuit", ["imola", "suzuka"])
def test_other_circuits_are_out_of_scope(circuit):
    r = client.get(f"{API}/tracks/{circuit}")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "UNKNOWN_CIRCUIT"


def test_track_matches_contract_and_step1_data():
    t = s.TrackGeometry.model_validate(client.get(f"{API}/tracks/monza").json())
    assert len(t.zones) == 11 and t.zones[0].zone_id == "monza-z01"
    xs, ys = [p[0] for p in t.outline], [p[1] for p in t.outline]
    assert abs(min(xs) + max(xs)) < 1e-3 and abs(min(ys) + max(ys)) < 1e-3      # centred on 0
    assert max(max(xs) - min(xs), max(ys) - min(ys)) == pytest.approx(1, abs=1e-3)
    assert t.reference.session_key == 9590 and t.reference.driver_number == 16
    assert {z.short_name for z in t.zones} >= {"Rettifilo", "Parabolica", "Curva Grande", "Ascari"}


def test_incidents_filter_by_zone_and_sort_newest_first():
    rows = client.get(f"{API}/incidents", params={"circuit": "monza", "zone_id": "monza-z10"}).json()
    assert rows and all(r["zone_id"] == "monza-z10" for r in rows)
    assert [r["occurred_at"] for r in rows] == sorted((r["occurred_at"] for r in rows), reverse=True)
    for r in rows:
        s.Incident.model_validate(r)


def test_risk_map_contract_and_series_scaling():
    f1 = s.RiskMap.model_validate(client.get(f"{API}/risk-map", params={"circuit": "monza", "series": "f1"}).json())
    f3 = s.RiskMap.model_validate(client.get(f"{API}/risk-map", params={"circuit": "monza", "series": "f3"}).json())
    assert len(f1.zones) == 11
    assert f1.totals.segmented_premium_eur == pytest.approx(sum(z.premium_eur for z in f1.zones))
    assert f3.totals.eal_eur > f1.totals.eal_eur                     # F3: 2.7× crashes outweigh 0.6× energy
    assert max(z.risk_score for z in f1.zones) == 100
    for z in f1.zones:
        assert z.crash_rate.lo90 <= z.crash_rate.mean <= z.crash_rate.hi90


def test_upgrades_param_changes_the_scenario_and_is_validated():
    base = client.get(f"{API}/risk-map", params={"circuit": "monza"}).json()
    up = client.get(f"{API}/risk-map", params={"circuit": "monza", "upgrades": '{"monza-z02":{"speed_factor":0.7}}'}).json()
    z = lambda rm: next(z for z in rm["zones"] if z["zone_id"] == "monza-z02")  # noqa: E731
    assert z(up)["eal_eur"] < z(base)["eal_eur"]
    bad = client.get(f"{API}/risk-map", params={"circuit": "monza", "upgrades": '{"monza-z02":{"barrier_type":"wood"}}'})
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "INVALID_UPGRADES"


def test_what_if_uses_common_random_numbers():
    body = {"circuit": "monza", "series": "f1", "zone_id": "monza-z02", "changes": {"barrier_type": "tecpro"}, "upgrades": {}}
    w = s.WhatIfResponse.model_validate(client.post(f"{API}/what-if", json=body).json())
    base = client.get(f"{API}/risk-map", params={"circuit": "monza"}).json()
    untouched = [z for z in base["zones"] if z["zone_id"] != "monza-z02"]
    after = {z.zone_id: z for z in w.risk_map.zones}
    for z in untouched:                                   # other zones keep exactly the same simulated losses
        assert after[z["zone_id"]].eal_eur == pytest.approx(z["eal_eur"])
    assert w.after.eal_eur < w.before.eal_eur


def test_what_if_unknown_zone():
    body = {"circuit": "monza", "series": "f1", "zone_id": "monza-z99", "changes": {"speed_factor": 0.9}, "upgrades": {}}
    r = client.post(f"{API}/what-if", json=body)
    assert r.status_code == 404 and r.json()["error"]["code"] == "UNKNOWN_ZONE"


def test_simulation_stream_events_and_final_eal():
    with client.stream("GET", f"{API}/simulate/stream", params={"circuit": "monza", "seasons": 3}) as r:
        events = sse_events("".join(r.iter_text()))
    kinds = [e for e, _ in events]
    assert kinds[0] == "season_start" and kinds[-1] == "done" and kinds.count("season_start") == 3
    crash = next(d for e, d in events if e == "crash")
    assert set(crash) == {"season", "zone_id", "x", "y", "lap_frac", "energy_kj", "loss_eur", "severe"}
    rm = client.get(f"{API}/risk-map", params={"circuit": "monza"}).json()
    assert events[-1][1]["eal_eur"] == pytest.approx(rm["totals"]["eal_eur"])


def test_report_json_and_pdf():
    rep = s.UnderwriterReport.model_validate(client.get(f"{API}/report/export", params={"circuit": "monza"}).json())
    assert rep.narrative_source == "template" and rep.executive_summary
    pdf = client.get(f"{API}/report/export", params={"circuit": "monza", "format": "pdf"})
    assert pdf.headers["content-type"] == "application/pdf" and pdf.content.startswith(b"%PDF")


def test_only_physical_incidents_count_as_crashes():
    from services.crash_filter import CRASH_RULES
    rows = client.get(f"{API}/incidents", params={"circuit": "monza"}).json()
    counted = [r for r in rows if r["counts_as_crash"]]
    assert 0 < len(counted) < sum(r["loss_relevant"] for r in rows)
    assert all(r["extraction"]["rule"] in CRASH_RULES for r in counted)
    assert not any(r["extraction"]["rule"] == "yellow" for r in counted)
    rm = client.get(f"{API}/risk-map", params={"circuit": "monza"}).json()
    assert sum(z["crash_rate"]["n_incidents"] for z in rm["zones"]) == len(counted)


@pytest.mark.parametrize("circuit", ["monza", "montreal"])
def test_assets_are_real_structures_with_exposure(circuit):
    am = s.AssetMap.model_validate(client.get(f"{API}/assets/{circuit}").json())
    assert am.alignment_error_m < 5 and len(am.assets) > 50
    assert {c.line for c in am.coverage} >= {"property", "spectator_liability", "track_infrastructure"}
    zones = {z["zone_id"] for z in client.get(f"{API}/tracks/{circuit}").json()["zones"]}
    assert all(a.nearest_zone_id in zones for a in am.assets)
    far = [a for a in am.assets if a.distance_to_track_m >= 200]
    assert all(a.exposure_score == 0 for a in far)


def test_montreal_surroundings_and_official_grandstands():
    am = s.AssetMap.model_validate(client.get(f"{API}/assets/montreal").json())
    assert {"water", "land", "wood"} <= {g.kind for g in am.context.ground}
    assert am.context.roads and am.context.buildings
    stands = [a for a in am.assets if a.position_source == "official_list"]
    official = json.loads((ROOT / "data/tracks/montreal_inventory.json").read_text())["grandstands"]["stands"]
    assert {a.name for a in stands} <= {st["name"] for st in official} and len(stands) >= 10
    assert all(a.category == "grandstand" and a.height_source == "assumed" and a.distance_to_track_m >= 10 for a in stands)
    assert "official grandstand list" in am.sources["structures"].detail
    monza = s.AssetMap.model_validate(client.get(f"{API}/assets/monza").json())
    assert all(a.position_source == "osm" for a in monza.assets)   # Monza's stands are all mapped in OSM


def test_track_has_real_speed_profile():
    t = client.get(f"{API}/tracks/monza").json()
    assert len(t["speed_kph"]) == len(t["outline"]) and max(t["speed_kph"]) > 300 and min(t["speed_kph"]) < 100
    assert 2000 < t["extent_m"] < 2400
