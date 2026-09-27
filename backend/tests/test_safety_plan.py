"""Safety plan endpoint: corners next to the crowd, options with estimated prices.

    cd backend && python -m pytest tests/test_safety_plan.py -q
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from api import schemas as s
from main import app
from services.safety_plan import ASSUMPTIONS, FX, PRICES, TICKETS

client = TestClient(app)


@pytest.mark.parametrize("circuit", ["monza", "montreal"])
def test_plan_covers_the_busiest_corners_next_to_the_crowd(circuit):
    plan = client.get(f"/api/insurance/safety-plan/{circuit}").json()
    s.SafetyPlan.model_validate(plan)
    exposure = client.get(f"/api/insurance/exposure/{circuit}").json()
    crowd = [z["zone_id"] for z in exposure["zones"] if z["near_crowd"]]
    assert [c["zone_id"] for c in plan["corners"]] == crowd[:3]
    for c in plan["corners"]:
        assert sum(o["recommended"] for o in c["options"]) == 1
        assert c["options"][0]["recommended"]                       # recommended option listed first


def test_prices_follow_the_stated_rates():
    plan = client.get("/api/insurance/safety-plan/montreal").json()
    c = plan["corners"][0]
    opt = {o["key"]: o for o in c["options"]}
    m = c["frontage_m"]
    assert opt["guardrail"]["cost"]["low"] == pytest.approx(round(m * 2 * 28 * FX["GBP"], -3))
    assert opt["tecpro"]["cost"]["low"] == pytest.approx(round(m * 1_600 * FX["USD"], -3))
    assert opt["debris_fence"]["cost"] == {"low": round(m * 1_000, -3), "high": round(m * 1_000, -3)}   # low end only
    seats = ASSUMPTIONS["rows_closed"] * ASSUMPTIONS["seats_per_row"] * len(c["grandstands"])
    assert opt["close_rows"]["cost"]["low"] == pytest.approx(round(seats * TICKETS["montreal"]["price"], -3))


def test_estimates_are_labelled_and_sourced():
    assert PRICES["tecpro"]["provenance"] == "estimate" and PRICES["debris_fence"]["provenance"] == "estimate"
    plan = client.get("/api/insurance/safety-plan/monza").json()
    for c in plan["corners"]:
        for o in c["options"]:
            assert o["source"] and o["source"].startswith("https://")


def test_recommendation_rule():
    plan = {c["name"]: c for c in client.get("/api/insurance/safety-plan/monza").json()["corners"]}
    rec = {n: next(o["key"] for o in c["options"] if o["recommended"]) for n, c in plan.items()}
    assert rec["Rettifilo"] == "tecpro"          # cars stop here often (2 call-outs / weekend)
    assert rec["Ascari"] == "debris_fence"       # still ~167 km/h through the corner
    assert rec["Roggia"] == "close_rows"         # slow corner, few stops
