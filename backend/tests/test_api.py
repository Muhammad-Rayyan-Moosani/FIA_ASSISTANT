"""R3 · API contract tests against the real Monza Step 1 data (offline).

    cd backend && python -m pytest tests/test_api.py -q
"""

from __future__ import annotations

import json
import warnings

import pytest
from fastapi.testclient import TestClient

from api import schemas as s
from config.settings import settings
from main import app

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


def test_monza_is_the_only_circuit():
    circuits = client.get(f"{API}/circuits").json()
    assert [c["id"] for c in circuits] == ["monza"]
    s.CircuitSummary.model_validate(circuits[0])
    assert circuits[0]["coverage"]["incidents"] > 0


@pytest.mark.parametrize("circuit", ["spa", "silverstone", "imola"])
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
