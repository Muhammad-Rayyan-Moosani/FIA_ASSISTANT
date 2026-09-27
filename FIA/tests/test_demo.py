from __future__ import annotations

from fastapi.testclient import TestClient

from app.config import RagConfig, Settings
from app.main import create_app
from app.services import demo_data as demo


def test_dashboard_and_scenario(client):
    assert "μMap Race Control" in client.get("/demo").text
    s = client.get("/api/v1/demo/scenario").json()
    assert len(s["centerline"]) > 100 and len(s["zones"]) == 6
    assert s["oil_zone"]["grip"] == demo.LOW_GRIP


def test_trajectory_watch_then_alert(client):
    client.post("/api/v1/demo/reset")
    levels = {}
    for car_id, _, run in demo.scenario_runs():
        r = client.post("/api/v1/demo/telemetry", json={"samples": run}).json()
        assert r["positions_broadcast"] == len(run)
        levels[car_id] = {e["sector_id"]: e["severity_level"] for e in r["events"]}
    assert levels["44"] == {}                                  # clean reference car
    assert set(levels["1"].values()) == {"WATCH"}             # one car on the oil
    assert set(levels["2"].values()) == {"ALERT"}             # second car, same x/y cells
    assert levels["1"].keys() == levels["2"].keys()
    assert all(k.startswith("grid_") for k in levels["2"])    # keyed on x/y, not lap distance


def test_server_side_run_streams_positions_and_alerts(client):
    with client.websocket_connect("/ws/alerts") as ws:
        assert client.post("/api/v1/demo/run-trajectory?speedup=20").status_code == 200
        seen = set()
        for _ in range(2000):
            m = ws.receive_json()
            seen.add(m["type"])
            if m["type"] == "hazard" and m["severity_level"] == "ALERT":
                break
        assert {"car_position", "demo_narration", "hazard"} <= seen


def test_demo_vision_finds_oil_and_water(client):
    r = client.post("/api/v1/umap/demo-vision").json()
    found = {d["hazard_type"]: d["map_coordinates"] for d in r["detections"]}
    assert set(found) == {"water_sheen", "oil_streak"}
    for kind, spec in (("water_sheen", demo.WATER), ("oil_streak", demo.OIL)):
        assert abs(found[kind]["x"] - spec["center"][0]) < 2.5
        assert abs(found[kind]["y"] - spec["center"][1]) < 1.5
    assert all(len(b["polygon_px"]) == 4 for b in r["camera_boxes"])
    assert r["camera_png_b64"] and r["overhead_png_b64"]
    assert client.post("/api/v1/umap/demo-vision?include_images=false").json()["camera_png_b64"] is None


def test_demo_transcribe_matches_rules(client):
    client.post("/api/v1/demo/reset")
    r = client.post("/api/v1/fia-assistant/demo-transcribe").json()
    assert "Oil at Turn 1" in r["text"] and len(r["segments"]) == 4
    assert r["related_rules"] and r["related_rules"][0]["article"].startswith("7.")


def test_demo_rulebook_queries(client):
    client.post("/api/v1/demo/reset")
    expected = ["6.1", "5.3", "7.2", "8.2"]
    for q, art in zip(demo.SAMPLE_QUERIES, expected):
        top = client.post("/api/v1/fia-assistant/query-rules", json={"incident_description": q, "top_k": 1}).json()
        assert top["citations"][0]["article"] == art, q


def test_monza_what_if(client):
    w = client.post("/api/insurance/what-if", json={"zones": demo.MONZA_ZONES, "modifications": demo.WHAT_IF}).json()
    assert w["annual_premium_saving"] > 0 and w["payback_years"] > 0


def test_demo_endpoints_can_be_disabled(tmp_path):
    s = Settings(rag=RagConfig(index_dir=tmp_path, rulebook_dir=tmp_path / "none", embedding_backend="hashing"),
                 demo_endpoints=False)
    with TestClient(create_app(s)) as c:
        assert c.get("/demo").status_code == 404
        assert c.post("/api/v1/umap/demo-vision").status_code in (404, 405)
