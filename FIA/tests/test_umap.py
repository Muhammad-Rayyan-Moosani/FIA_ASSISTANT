from __future__ import annotations

from app.schemas.umap import HazardType, Point2D, Severity, VisionDetection
from tests.conftest import braking_run

URL = "/api/v1/umap/telemetry"


def test_normal_grip_raises_nothing(client):
    r = client.post(URL, json={"samples": braking_run("44", grip=1.0)})
    body = r.json()
    assert r.status_code == 200
    assert body["evaluated"] > 10
    assert body["flagged"] == 0
    assert body["events"] == []
    residuals = [p["residual"] for p in body["residuals"]]
    assert min(residuals) > 0.9 and max(residuals) < 1.1


def test_single_car_below_threshold_is_watch(client):
    body = client.post(URL, json={"samples": braking_run("44", grip=0.5)}).json()
    assert body["flagged"] > 0
    assert {e["severity_level"] for e in body["events"]} == {"WATCH"}
    card = body["events"][0]["evidence_card_data"]
    assert card["cars_flagged"] == ["44"]
    assert card["hazard_types"] == ["grip_cliff"]
    assert 0.4 < card["min_residual"] < 0.6


def test_two_cars_same_segment_is_alert(client):
    client.post(URL, json={"samples": braking_run("44", grip=0.5)})
    body = client.post(URL, json={"samples": braking_run("1", grip=0.55, t0=5.0)}).json()
    alerts = [e for e in body["events"] if e["severity_level"] == "ALERT"]
    assert alerts, body["events"]
    assert all(e["previous_level"] == "WATCH" for e in alerts)
    assert set(alerts[0]["evidence_card_data"]["cars_flagged"]) == {"1", "44"}
    seg = client.get("/api/v1/umap/segments").json()["segments"]
    assert any(s["severity_level"] == "ALERT" for s in seg)


def test_residuals_across_batch_boundaries(client):
    run = braking_run("16", grip=1.0)
    evaluated = sum(client.post(URL, json={"samples": [s]}).json()["evaluated"] for s in run)
    assert evaluated == len(run) - 1


def test_off_brake_samples_not_scored(client):
    body = client.post(URL, json={"samples": braking_run("4", grip=0.3, brake=10)}).json()
    assert body["evaluated"] == 0 and body["events"] == []


def test_flags_expire_after_window(client, settings):
    client.post(URL, json={"samples": braking_run("44", grip=0.5)})
    later = braking_run("44", grip=1.0, t0=settings.telemetry.flag_window_s + 10, d0=3000)
    body = client.post(URL, json={"samples": later}).json()
    assert body["events"] and {e["severity_level"] for e in body["events"]} == {"NONE"}


def test_spatial_grid_used_without_lap_distance(client):
    samples = [s | {"distance_m": None} for s in braking_run("44", grip=0.5)]
    body = client.post(URL, json={"samples": samples}).json()
    assert body["events"] and all(e["sector_id"].startswith("grid_") for e in body["events"])


def test_websocket_streams_alerts(client):
    with client.websocket_connect("/ws/alerts") as ws:
        assert ws.receive_json()["type"] == "snapshot"
        client.post(URL, json={"samples": braking_run("44", grip=0.5)})
        msg = ws.receive_json()
        assert msg["type"] == "hazard"
        assert msg["severity_level"] == "WATCH"
        assert {"sector_id", "coordinates", "severity_level", "evidence_card_data"} <= msg.keys()
        ws.send_text("ping")
        # drain any further hazard events for other segments, then expect the pong
        while (m := ws.receive_json())["type"] == "hazard":
            pass
        assert m == {"type": "pong"}


def test_vision_evidence_escalates_watch(app, client):
    body = client.post(URL, json={"samples": braking_run("44", grip=0.5, n=4)}).json()
    ev = body["events"][0]
    det = VisionDetection(
        hazard_type=HazardType.OIL_STREAK, confidence=0.9,
        map_coordinates=Point2D(**ev["coordinates"]), area_m2=3.0,
        bbox_px=(0, 0, 10, 10), detector="test",
    )
    events = app.state.engine.register_vision([det])
    target = [e for e in events if e.sector_id == ev["sector_id"]]
    assert [e.severity_level for e in target] == [Severity.ALERT]
    assert HazardType.OIL_STREAK in target[0].evidence_card_data.hazard_types


def test_reset(client):
    client.post(URL, json={"samples": braking_run("44", grip=0.5)})
    assert client.post("/api/v1/umap/reset").status_code == 204
    assert client.get("/api/v1/umap/segments").json()["segments"] == []


def test_validation_rejects_bad_sample(client):
    s = braking_run("44", grip=1.0)[0] | {"brake": 150}
    assert client.post(URL, json={"samples": [s]}).status_code == 422


def test_camera_confirmation_reemits_active_alert(app, client):
    client.post(URL, json={"samples": braking_run("44", grip=0.5, n=4)})
    body = client.post(URL, json={"samples": braking_run("1", grip=0.5, n=4, t0=5)}).json()
    ev = next(e for e in body["events"] if e["severity_level"] == "ALERT")
    det = VisionDetection(
        hazard_type=HazardType.OIL_STREAK, confidence=0.9,
        map_coordinates=Point2D(**ev["coordinates"]), area_m2=3.0,
        bbox_px=(0, 0, 10, 10), detector="test",
    )
    events = app.state.engine.register_vision([det])
    same = [e for e in events if e.sector_id == ev["sector_id"]]
    assert len(same) == 1 and same[0].previous_level == same[0].severity_level == Severity.ALERT
    assert HazardType.OIL_STREAK in same[0].evidence_card_data.hazard_types
    assert app.state.engine.register_vision([det]) == []  # same hazard again: nothing new to say
