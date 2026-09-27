from __future__ import annotations

from app.services import demo_data as demo
from app.services.plain_alerts import crash_payload, merge_nearby, plain_alert
from tests.conftest import braking_run

WATCH = {"type": "hazard", "sector_id": "grid_23_0", "coordinates": {"x": 586.1, "y": 10.4},
         "severity_level": "WATCH", "previous_level": "NONE",
         "evidence_card_data": {"hazard_types": ["grip_cliff"], "cars_flagged": ["1"], "min_residual": 0.4566,
                                "vision": []}, "timestamp": 31.6}
ALERT = {**WATCH, "severity_level": "ALERT", "previous_level": "WATCH",
         "evidence_card_data": {**WATCH["evidence_card_data"], "cars_flagged": ["1", "2"]}}
CONFIRMED = {**ALERT, "evidence_card_data": {**ALERT["evidence_card_data"],
             "vision": [{"hazard_type": "oil_streak", "confidence": 0.6}]}}


def test_watch_alert_and_camera_confirmation():
    w = plain_alert(WATCH, "Turn 1")
    assert (w["headline"], w["flag"], w["colour"]) == ("SLIPPERY at Turn 1", "YELLOW_READY", "amber")
    assert "Car 1 is getting very little grip (46% of normal)" in w["why"]
    a = plain_alert(ALERT, "Turn 1")
    assert (a["flag"], a["colour"]) == ("YELLOW", "red") and "Car 1 and Car 2 are" in a["why"]
    c = plain_alert(CONFIRMED, "Turn 1")
    assert c["headline"] == "OIL at Turn 1" and c["flag"] == "VSC" and "Camera sees oil" in c["why"]
    assert all(x["note"] == "Suggestion only. Race control decides." for x in (w, a, c))


def test_location_falls_back_to_distance_mark():
    assert plain_alert(WATCH)["where"] == "the 586 m mark"


def test_cleared_event_does_not_ask_for_flags():
    clear = {**ALERT, "severity_level": "NONE", "previous_level": "ALERT"}
    msg = plain_alert(clear, "Turn 1")
    assert msg["flag"] == "CLEAR" and msg["headline"] == "CLEAR at Turn 1" and "YELLOW" not in msg["action"]


def test_crash():
    soft = plain_alert(crash_payload({"driver": 11, "driver_code": "PER", "impact_speed_kph": 172,
                                      "peak_decel_g": 8.3}, "Turn 1"))
    assert soft["flag"] == "DOUBLE_YELLOW" and soft["why"].startswith("PER hit something at about 172 km/h")
    hard = plain_alert(crash_payload({"driver": 2, "impact_speed_kph": 172, "peak_decel_g": 18.4}, "Turn 1"))
    assert hard["flag"] == "SC" and "very hard hit" in hard["why"] and hard["cars"] == ["2"]


def test_merge_nearby_keeps_worst_per_patch():
    other = {**ALERT, "sector_id": "grid_22_0", "coordinates": {"x": 561.0, "y": 10.1}}
    far = {**WATCH, "sector_id": "grid_40_0", "coordinates": {"x": 1010.0, "y": 10.0}}
    kept = merge_nearby([WATCH, other, ALERT, far])
    assert [k["sector_id"] for k in kept] == ["grid_22_0", "grid_40_0"]


def test_feed_payloads_carry_plain_messages(client):
    with client.websocket_connect("/ws/alerts") as ws:
        ws.receive_json()  # snapshot
        client.post("/api/v1/umap/telemetry", json={"samples": braking_run("44", grip=0.5, d0=520, n=6)})
        msg = ws.receive_json()
        assert msg["type"] == "hazard" and msg["plain"]["where"] == "Turn 1"
        assert msg["plain"]["headline"] == "SLIPPERY at Turn 1"


def test_demo_crash_endpoint(client):
    m = client.post("/api/v1/demo/crash").json()
    assert m["type"] == "crash" and m["plain"]["headline"] == "CRASH at Turn 1" and m["plain"]["flag"] == "SC"
    assert demo.locate(m["coordinates"]) == "Turn 1"


def test_demo_vision_reports_oil_after_alert(client):
    client.post("/api/v1/demo/reset")
    for _, _, run in demo.scenario_runs():
        client.post("/api/v1/demo/telemetry", json={"samples": run})
    events = client.post("/api/v1/umap/demo-vision?include_images=false").json()["events"]
    kinds = {t for e in events for t in e["evidence_card_data"]["hazard_types"]}
    assert {"oil_streak", "water_sheen"} <= kinds and all(e["severity_level"] == "ALERT" for e in events)
