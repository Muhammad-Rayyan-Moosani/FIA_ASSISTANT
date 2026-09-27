"""Third-party exposure endpoint: numbers counted from the Step 1 data, checked by hand.

    cd backend && python -m pytest tests/test_exposure.py -q
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from api import schemas as s
from main import app
from services.data_loader import ROOT_DIR

client = TestClient(app)


def raw(circuit: str) -> tuple[dict, list[dict]]:
    track = json.loads((ROOT_DIR / "tracks" / f"{circuit}.json").read_text(encoding="utf-8"))
    incidents = json.loads((ROOT_DIR / "incidents" / f"{circuit}.json").read_text(encoding="utf-8"))
    return track, incidents


@pytest.mark.parametrize("circuit", ["monza", "montreal"])
def test_exposure_matches_the_raw_data(circuit):
    e = client.get(f"/api/insurance/exposure/{circuit}").json()
    s.ExposureMap.model_validate(e)
    track, incidents = raw(circuit)
    serious = [r for r in incidents if r["loss_relevant"]]
    weekends = len(track["data_coverage"]["seasons"])
    assert e["serious_total"] == len(serious)
    assert e["marshals_out_total"] == sum(r["incident_type"] == "stopped" for r in serious)
    assert e["marshals_out_per_weekend"] == pytest.approx(e["marshals_out_total"] / weekends)
    crowd = {z["zone_id"] for z in track["zones"] if z["grandstands"]}
    assert e["near_crowd_total"] == sum(r["zone_id"] in crowd for r in serious)
    assert sum(z["serious_total"] for z in e["zones"]) == len(serious)


@pytest.mark.parametrize("circuit", ["monza", "montreal"])
def test_backtest_only_looks_at_earlier_years(circuit):
    e = client.get(f"/api/insurance/exposure/{circuit}").json()
    b = e["backtest"]
    assert [y["season"] for y in b["years"]] == e["seasons"][1:]
    assert b["hits"] == sum(y["hits"] for y in b["years"]) and b["total"] == sum(y["total"] for y in b["years"])
    assert b["chance_share"] == pytest.approx(b["top_k"] / len(e["zones"]))
    assert b["share"] > b["chance_share"]           # the busy corners stay busy


def test_zones_are_ranked_and_coloured_by_serious_incidents():
    e = client.get("/api/insurance/exposure/monza").json()
    per = [z["serious_per_weekend"] for z in e["zones"]]
    assert per == sorted(per, reverse=True) and e["zones"][0]["score"] == 100
    assert e["top_zones"] == [z["zone_id"] for z in e["zones"][:3]]


def test_every_context_fact_has_a_source():
    for circuit in ("monza", "montreal"):
        c = client.get(f"/api/insurance/exposure/{circuit}").json()["context"]
        assert c["attendance"] and c["attendance_source"].startswith("https://")
        assert c["history"] and c["history_source"].startswith("https://")
        assert c["task_force_source"].startswith("https://")


def test_unknown_circuit_is_404():
    assert client.get("/api/insurance/exposure/imola").status_code == 404
