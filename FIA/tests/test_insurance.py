from __future__ import annotations

import math

import numpy as np
import pytest

from app.schemas.insurance import ZoneInput
from app.services import risk

ZONE = dict(zone_id="Z1", crashes=2, yellow_flags=3, warnings=10, approach_speed_kph=300,
            top_speed_kph=100, grandstand_dist_m=50, marshal_dist_m=100)


def test_risk_formula_exact(client):
    body = client.post("/api/v1/insurance/risk-score", json={"zones": [ZONE]}).json()
    z = body["zones"][0]
    people = 1 + 2 * math.exp(-50 / 50) + 0.5 * math.exp(-100 / 50)
    assert z["events"] == pytest.approx(2 + 3 + 1.0)
    assert z["speed_factor"] == pytest.approx(200 ** 2)
    assert z["people_factor"] == pytest.approx(people, rel=1e-5)
    assert z["risk"] == pytest.approx(6 * 40_000 * people, rel=1e-6)
    assert z["rank"] == 1 and z["risk_share"] == pytest.approx(1.0)


def test_demo_track_risk_ranking(client):
    body = client.post("/api/v1/insurance/risk-score", json={}).json()
    assert len(body["zones"]) == 6
    assert sorted(z["rank"] for z in body["zones"]) == list(range(1, 7))
    assert sum(z["risk_share"] for z in body["zones"]) == pytest.approx(1.0, abs=1e-4)


def test_posterior_is_conjugate_update():
    a, b = risk.poisson_gamma_posterior(np.array([0.0, 10.0]), np.array([5.0, 5.0]), prior_strength=2.0)
    pooled = 10 / 10
    assert a.tolist() == [2.0, 12.0]
    assert b == pytest.approx([2 / pooled + 5, 2 / pooled + 5])
    # shrinkage: zero-crash zone still gets a positive rate, high-crash zone shrinks toward pooled
    assert 0 < a[0] / b[0] < pooled < a[1] / b[1] < 10 / 5


def test_monte_carlo_matches_analytic_mean():
    zones = [ZoneInput(**ZONE), ZoneInput(**(ZONE | {"zone_id": "Z2", "crashes": 6}))]
    df = risk.zones_frame(zones)
    comps = risk.risk_components(df)
    a, b = risk.poisson_gamma_posterior(df["crashes"].to_numpy(float), df["seasons_observed"].to_numpy(float), 2.0)
    sev = risk.severity_means(df, comps, risk.Series.F1)
    losses = risk.simulate_losses(risk.draw_simulation(a, b, 1.0, 100_000, seed=7), sev)
    analytic = a / b * sev
    assert losses.mean(axis=0) == pytest.approx(analytic, rel=0.03)


def test_risk_map_defaults(client):
    r = client.post("/api/insurance/risk-map", json={"series": "F1"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["n_seasons"] == 10_000 and len(body["zones"]) == 6
    for z in body["zones"]:
        assert 0 < z["crash_probability"] < 1
        s = z["loss"]
        assert s["var_99"] >= s["expected_annual_loss"] > 0
        assert s["tvar_99"] >= s["var_99"]
        assert s["recommended_premium"] > s["expected_annual_loss"]
    assert body["diversification_benefit"] >= 0
    # reproducible under a fixed seed, and v1 path == alias path
    again = client.post("/api/v1/insurance/risk-map", json={"series": "F1"}).json()
    assert again["portfolio"] == body["portfolio"]


def test_series_toggle(client):
    eal = {
        s: client.post("/api/insurance/risk-map", json={"series": s}).json()["portfolio"]["expected_annual_loss"]
        for s in ("F1", "F2", "F3")
    }
    assert eal["F1"] > eal["F2"] > eal["F3"]


def test_what_if_barrier_and_grandstand(client):
    body = client.post("/api/insurance/what-if", json={
        "modifications": [
            {"zone_id": "T8", "barrier_upgrade": "tecpro", "grandstand_shift_m": 20},
            {"zone_id": "T3", "barrier_upgrade": "safer"},
        ]
    })
    assert body.status_code == 200, body.text
    body = body.json()
    assert body["annual_eal_reduction"] > 0 and body["annual_premium_saving"] > 0
    assert body["modified"]["var_99"] < body["baseline"]["var_99"]
    t8 = next(z for z in body["zones"] if z["zone_id"] == "T8")
    assert t8["upgrade_cost_usd"] == pytest.approx(350_000 + 20 * 25_000)
    assert t8["payback_years"] == pytest.approx(t8["upgrade_cost_usd"] / t8["premium_reduction"], abs=1e-3)
    assert body["payback_years"] > 0
    assert any("tecpro" in c for c in t8["changes"])


def test_what_if_validation(client):
    assert client.post("/api/insurance/what-if", json={"modifications": [{"zone_id": "NOPE", "marshal_shift_m": 5}]}).status_code == 422
    assert client.post("/api/insurance/what-if", json={"modifications": [{"zone_id": "T1"}]}).status_code == 422
    dup = [ZONE, ZONE]
    assert client.post("/api/insurance/risk-map", json={"zones": dup}).status_code == 422
