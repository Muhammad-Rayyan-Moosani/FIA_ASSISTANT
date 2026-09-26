from __future__ import annotations

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.config import RagConfig, Settings, TelemetryConfig
from app.main import create_app
from app.services.telemetry import expected_deceleration


@pytest.fixture()
def settings(tmp_path) -> Settings:
    return Settings(rag=RagConfig(index_dir=tmp_path / "rag", embedding_backend="hashing"))


@pytest.fixture()
def app(settings):
    return create_app(settings)


@pytest.fixture()
def client(app):
    with TestClient(app) as c:
        yield c


def braking_run(car_id: str, grip: float, t0: float = 0.0, d0: float = 1000.0,
                v0_kph: float = 300.0, n: int = 20, dt: float = 0.1, brake: float = 100.0) -> list[dict]:
    """Synthetic braking zone. ``grip`` = achieved fraction of the expected deceleration."""
    cfg = TelemetryConfig()
    out, v, d = [], v0_kph / 3.6, d0
    for i in range(n):
        out.append({
            "car_id": car_id, "timestamp": round(t0 + i * dt, 3), "speed_kph": round(v * 3.6, 4),
            "throttle": 0, "brake": brake, "x": d, "y": 0.0, "distance_m": d,
        })
        a = grip * float(expected_deceleration(np.array([v]), np.array([brake / 100]), cfg)[0])
        d += v * dt
        v = max(v - a * dt, 0.0)
    return out
