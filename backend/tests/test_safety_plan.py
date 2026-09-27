"""Safety plan endpoint: low-cost options at the corners next to the crowd, and the insurer report.

    cd backend && python -m pytest tests/test_safety_plan.py -q
"""

from __future__ import annotations

import math

import pytest
from fastapi.testclient import TestClient

from api import schemas as s
from main import app
from services.safety_plan import ASSUMPTIONS, FX, PRICES

client = TestClient(app)


@pytest.mark.parametrize("circuit", ["monza", "montreal"])
def test_plan_covers_the_busiest_corners_next_to_the_crowd(circuit):
    plan = client.get(f"/api/insurance/safety-plan/{circuit}").json()
    s.SafetyPlan.model_validate(plan)
    exposure = client.get(f"/api/insurance/exposure/{circuit}").json()
    crowd = [z["zone_id"] for z in exposure["zones"] if z["near_crowd"]]
    assert [c["zone_id"] for c in plan["corners"]] == crowd[:3]
    for c in plan["corners"]:
        assert [o["key"] for o in c["options"]] == ["crews", "marshal_training", "move_crowd", "cameras", "guardrail"]


def test_prices_follow_the_stated_rates():
    plan = client.get("/api/insurance/safety-plan/montreal").json()
    c = plan["corners"][0]
    opt = {o["key"]: o for o in c["options"]}
    m = c["frontage_m"]
    assert opt["crews"]["cost"]["low"] == 0 and opt["marshal_training"]["cost"]["low"] == 0
    assert opt["cameras"]["cost"]["low"] == pytest.approx(round(ASSUMPTIONS["cameras_per_corner"] * 199.99 * FX["USD"], -2))
    panels = math.ceil(m / 3.5)
    assert opt["move_crowd"]["cost"]["low"] == pytest.approx(round(panels * 5.50 * FX["GBP"], -2))
    g = m * 2 * 28 * FX["GBP"]
    assert opt["guardrail"]["cost"]["low"] == pytest.approx(round(g, -2 if g < 10_000 else -3))


def test_paid_options_are_sourced():
    plan = client.get("/api/insurance/safety-plan/monza").json()
    for c in plan["corners"]:
        for o in c["options"]:
            if o["cost"]["low"] > 0:
                assert o["source"] and o["source"].startswith("https://")
    assert all(p["source"].startswith("https://") for p in PRICES.values())


def test_report_trend_counts_serious_incidents_at_the_plan_corners():
    plan = client.get("/api/insurance/safety-plan/monza").json()
    exposure = client.get("/api/insurance/exposure/monza").json()
    ids = {c["zone_id"] for c in plan["corners"]}
    expected = {y: 0 for y in exposure["seasons"]}
    for z in exposure["zones"]:
        if z["zone_id"] in ids:
            for bs in z["by_season"]:
                expected[bs["season"]] += bs["count"]
    assert {t["season"]: t["count"] for t in plan["report"]["trend"]} == expected
    assert plan["report"]["cost"]["low"] == 0
