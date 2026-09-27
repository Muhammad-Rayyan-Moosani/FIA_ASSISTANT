"""Race control: real incident packs, collision physics, grip engine, severity fusion, replay loop."""
from __future__ import annotations

import asyncio

import numpy as np
import pytest
from fastapi.testclient import TestClient

from main import app
from services import multimodal_severity as ms
from services.race_control import alerts, collision, packs
from services.race_control import frame as fr
from services.race_control.grip import GripEngine
from services.race_control.session import RaceControlSession

client = TestClient(app)
API = "/api/fia"
NORRIS = "montreal-2025-R-0014"          # Canada 2025, lap 67: Norris into the wall on the pit straight


@pytest.mark.parametrize("circuit", ["monza", "montreal"])
def test_marshal_masts_are_real_sectors_on_the_map(circuit):
    body = client.get(f"{API}/{circuit}/marshal-sectors").json()
    sectors = body["sectors"]
    assert len(sectors) >= 10 and "MultiViewer" in body["source"]
    assert [s["sector"] for s in sectors] == sorted(s["sector"] for s in sectors)
    assert all(-0.6 <= s["x"] <= 0.6 and -0.6 <= s["y"] <= 0.6 for s in sectors)


@pytest.mark.parametrize("circuit", ["monza", "montreal"])
def test_incidents_are_real_openf1_packs(circuit):
    body = client.get(f"{API}/{circuit}/incidents").json()
    assert body["incidents"] and "OpenF1" in body["source"]
    for inc in body["incidents"]:
        assert inc["season"] >= 2023 and inc["rule"] in ("double_yellow", "collision", "crash_or_stopped", "debris")
        assert inc["location_source"] in ("telemetry", "marshal_sector", "zone")
        if inc["impact"]:
            assert inc["impact"]["level"] in ("incident", "crash") and inc["location_source"] == "telemetry"


def test_norris_canada_2025_is_a_stopped_crash_with_radio():
    pack = packs.get("montreal", NORRIS)
    imp = packs.primary_impact(pack)
    assert imp["driver"] == "4" and imp["level"] == "crash" and imp["stopped"]
    assert imp["impact_speed_kph"] > 250 and pack["radio"] and pack["radio"][0]["url"].startswith(ms.RADIO_HOST)
    advice = alerts.crash_advice(imp, "Car 4 (NOR)", "Straight to the line", 1, pack["raw_message"])
    assert advice["flag"] == "SC"


def test_collision_estimator_ignores_a_recovering_glitch_and_catches_a_stop():
    t = np.arange(0, 20, 0.27)
    x = t * 80.0
    y = np.zeros_like(t)
    glitch = np.full_like(t, 300.0)
    glitch[30] = 120.0                                   # one bad sample, speed recovers at once
    assert collision.estimate("1", t, glitch, x, y) == []
    stop = np.where(t < 10, 300.0, np.maximum(0.0, 300.0 - (t - 10) * 90))
    est = collision.estimate("1", t, stop, x, y)
    assert len(est) == 1 and est[0].stopped and est[0].level == "crash"


def test_grip_engine_flags_a_car_braking_far_below_its_peers():
    eng = GripEngine(5000)
    events = []
    for k, car in enumerate(["1", "2", "3", "4", "5", "6"]):
        decel = 0.35 if car in ("5", "6") else 1.0         # two cars get a third of the braking
        t0 = k * 3.0
        for i, dt in enumerate(np.arange(0, 1.6, 0.27)):
            events += eng.ingest(car, t0 + dt, 300 - 150 * decel * dt / 1.5, 100, 0.2)
        events += eng.ingest(car, t0 + 1.9, 150, 0, 0.21)
    assert events and events[-1].level == "ALERT" and set(events[-1].cars) == {"5", "6"}


def test_severity_fusion_weights_and_labels():
    assert ms.fuse(0.9, None, None) == {"score": 0.9, "label": "Critical crash", "weights": {"telemetry": 1.0}}
    f = ms.fuse(0.5, 0.2, 0.1)
    assert f["weights"] == {"telemetry": 0.6, "voice": 0.25, "audio": 0.15} and f["label"] == "Medium incident"
    assert ms.fuse(0.1, 0.1, 0.1)["label"] == "Low slip"
    with pytest.raises(ValueError):
        ms.fetch_radio("https://example.com/clip.mp3")      # radio only from F1's live-timing server


def test_replay_runs_the_whole_safety_loop(monkeypatch):
    async def no_radio(*_):                                 # keep the test offline
        return None
    monkeypatch.setattr(RaceControlSession, "_severity_with_radio", no_radio)
    monkeypatch.setattr(RaceControlSession, "_rules", no_radio)

    async def run():
        s = RaceControlSession("montreal")
        q = s.subscribe()
        await s.start_replay(NORRIS, speed=8, lead_s=3)
        while not (s.replay and not s.replay["running"]):
            await asyncio.sleep(0.05)
        kinds = set()
        while not q.empty():
            kinds.add(q.get_nowait()["type"])
        assert {"replay_start", "cars", "incident", "masts", "severity", "replay_end"} <= kinds
        assert s.incident["advice"]["flag"] == "SC" and s.incident["insurance"]["estimated_cost_eur"] > 0
        assert s.masts[1] == "double_yellow"
        assert s.masts[fr.previous_sector("montreal", 1)] == "yellow"
        assert s.warning and s.warning["tone"] == "double_yellow" and s.warning["driver"] != "4"
        await s.deploy("sc")
        assert set(s.masts.values()) == {"sc"} and s.warning["tone"] == "sc"
        await s.deploy("clear")
        assert set(s.masts.values()) == {"green"} and s.incident is None
        await s.reset()

    asyncio.run(run())


def test_evaluate_without_an_incident_in_the_sector_is_a_404():
    body = client.post(f"{API}/montreal/evaluate", json={"zone_id": "montreal-nowhere"})
    assert body.status_code == 404 and body.json()["error"]["code"] == "NO_INCIDENT_HERE"


def test_deploy_rejects_unknown_actions():
    assert client.post(f"{API}/montreal/deploy", json={"action": "launch"}).status_code == 422
