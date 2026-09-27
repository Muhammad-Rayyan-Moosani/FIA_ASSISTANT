"""Race control: real incident packs, collision physics, grip engine, severity fusion, replay loop."""
from __future__ import annotations

import asyncio
import json

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
    monkeypatch.setattr(RaceControlSession, "_rules_then_advisory", no_radio)

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


def test_wet_hairpin_demo_drives_the_safety_loop(monkeypatch):
    async def offline(*_):
        return None
    monkeypatch.setattr(RaceControlSession, "_rules_then_advisory", offline)

    async def run():
        s = RaceControlSession("montreal")
        q = s.subscribe()
        zone = next(z for z in fr.frame("montreal").zones if z["zone_id"] == "montreal-z10")
        frac = (zone["start_frac"] + zone["end_frac"]) / 2
        summary = await s.start_demo("montreal-z10", 0.1, 0.1, frac)
        assert summary["session_type"] == "Demo" and summary["raw_message"].startswith("Simulated")
        await s.demo_event({"kind": "slip", "t": 4.5, "speed_kph": 264, "measured_g": 1.1, "expected_g": 2.85,
                            "distance_m": 480, "b_speed_kph": 176})
        assert s.incident["advice"]["flag"] == "SLIPPERY" and s.incident["demo"]
        assert s.masts[summary["marshal_sector"]] == "slippery"
        assert s.warning["driver"] == "B" and s.warning["distance_m"] == 480 and s.warning["demo"]
        card = alerts.rules_advisory(s.incident, s.incident["cars_behind"], "no key")
        assert card["driver_messages"][0]["message"].startswith("STANDING WATER") and "slippery" in card["steward_steps"][0]
        await s.demo_event({"kind": "spin", "t": 5.0, "speed_kph": 210, "slide_deg": 21})
        assert "sideways" in s.log[0]["text"]
        await s.demo_event({"kind": "impact", "t": 6.9, "speed_kph": 146, "impact_speed_kph": 146, "entry_speed_kph": 171, "peak_g": 30})
        assert s.incident["collision"]["impact_speed_kph"] == 146 and s.incident["insurance"]["impact_speed_source"] == "simulated"
        assert s.incident["advice"]["flag"] == "DOUBLE_YELLOW" and s.warning["tone"] == "double_yellow"
        await s.demo_event({"kind": "stopped", "t": 8.4, "peak_g": 57})
        assert s.incident["advice"]["flag"] == "SC" and s.incident["collision"]["stopped"]
        assert s.severity["score"] > 0.5
        await s.demo_event({"kind": "passed", "t": 23.7, "speed_kph": 113, "min_speed_kph": 39})
        await s.demo_event({"kind": "end", "t": 26})
        assert not s.replay["running"]
        kinds = []
        while not q.empty():
            kinds.append(q.get_nowait()["type"])
        assert kinds.count("incident") == 1 and "incident_update" in kinds and kinds[-1] == "replay_end"
        await s.reset()
        assert not await s.demo_event({"kind": "tick", "t": 1})

    asyncio.run(run())


def test_demo_api_validates_events():
    assert client.post(f"{API}/montreal/demo/start", json={"zone_id": "montreal-nowhere", "x": 0, "y": 0, "lap_frac": 0.5}).status_code == 404
    assert client.post(f"{API}/montreal/demo/event", json={"kind": "slip", "t": 1}).status_code == 422
    assert client.post(f"{API}/montreal/demo/event", json={"kind": "warp"}).status_code == 422


def test_evaluate_without_an_incident_in_the_sector_is_a_404():
    body = client.post(f"{API}/montreal/evaluate", json={"zone_id": "montreal-nowhere"})
    assert body.status_code == 404 and body.json()["error"]["code"] == "NO_INCIDENT_HERE"


def test_deploy_rejects_unknown_actions():
    assert client.post(f"{API}/montreal/deploy", json={"action": "launch"}).status_code == 422


# ----------------------------------------------------------------------------- Claude steward agent
from types import SimpleNamespace

from config.settings import settings
from services.race_control import steward_agent


def _incident() -> dict:
    pack = packs.get("montreal", NORRIS)
    imp = packs.primary_impact(pack)
    summary = packs.summary("montreal", pack)
    advice = alerts.crash_advice(imp, "Car 4 (NOR)", summary["zone_name"], summary["marshal_sector"], pack["raw_message"])
    return {**summary, "advice": advice, "collision": imp,
            "insurance": {"structures_at_risk": [{"name": "Grandstand 1", "category": "grandstand", "distance_m": 98}]}}


CARS_BEHIND = [{"driver": "30", "code": "LAW", "distance_m": 235, "speed_kph": 290}, {"driver": "16", "code": "LEC", "distance_m": 1400, "speed_kph": 300}]
RULES = [{"article": "B5.13.1", "text": "The Safety Car may be used..."}, {"article": "B5.12.1", "text": "VSC..."}]


def test_steward_agent_without_a_key_falls_back_to_the_rule_engine(monkeypatch):
    monkeypatch.setattr(settings, "anthropic_api_key", None)
    out = steward_agent.advise(_incident(), None, CARS_BEHIND, RULES)
    assert out["source"] == "rules" and "ANTHROPIC_API_KEY" in out["reason"]
    card = alerts.rules_advisory(_incident(), CARS_BEHIND, out["reason"])
    assert card["recommended_action"] == "SAFETY_CAR" and [m["driver"] for m in card["driver_messages"]] == ["30", "16"]


def test_steward_agent_sends_only_real_facts_and_keeps_only_retrieved_articles(monkeypatch):
    sent = {}
    card = {"headline": "Stopped car on the pit straight", "recommended_action": "SAFETY_CAR",
            "reasoning": "Car 4 stopped at 286 km/h impact; B5.13.1 allows the Safety Car.", "citations": ["B5.13.1", "B99.9"],
            "driver_messages": [{"driver": "30", "message": "CRASH AHEAD S1", "avoidance": "Lift now, keep left"}],
            "steward_steps": ["Deploy SC"], "marshal_instructions": "Recover car 4", "spectator_safety": "Grandstand 1 is 98 m away",
            "confidence": "high"}

    def create(**kw):
        sent.update(kw)
        return SimpleNamespace(stop_reason="end_turn", model="claude-opus-5", content=[SimpleNamespace(type="text", text=json.dumps(card))])

    monkeypatch.setattr(settings, "anthropic_api_key", "test")
    monkeypatch.setattr(steward_agent, "_get_client", lambda: SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(create=create))))
    out = steward_agent.advise(_incident(), {"label": "Medium incident", "score": 0.55, "radio": None}, CARS_BEHIND, RULES)
    assert out["source"] == "claude" and out["recommended_action"] == "SAFETY_CAR"
    assert out["citations"] == ["B5.13.1"]                         # an article we did not retrieve is dropped
    facts = json.loads(sent["messages"][0]["content"].split("\n", 1)[1])
    assert facts["telemetry"]["impact_speed_kph"] == 286 and facts["cars_behind"] == CARS_BEHIND
    assert [r["article"] for r in facts["regulation_excerpts"]] == ["B5.13.1", "B5.12.1"]
    assert sent["model"] == settings.anthropic_model and sent["output_config"]["format"]["type"] == "json_schema"
    assert sent["fallbacks"] == "default"


def test_steward_agent_refusal_falls_back(monkeypatch):
    monkeypatch.setattr(settings, "anthropic_api_key", "test")
    refused = SimpleNamespace(stop_reason="refusal", model="claude-opus-5", content=[])
    monkeypatch.setattr(steward_agent, "_get_client", lambda: SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(create=lambda **_: refused))))
    assert steward_agent.advise(_incident(), None, CARS_BEHIND, RULES)["source"] == "rules"
