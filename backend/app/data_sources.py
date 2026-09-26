"""Telemetry data sources: OpenF1 REST API (default) and an optional FastF1 adapter.

The live demo replays pre-fetched JSON from /data so it works offline. These
clients are used by the scripts in backend/scripts/ to refresh that data, and
can be pointed at a live session for real-time use.
"""

from __future__ import annotations

import time
from typing import Any

import httpx

OPENF1_BASE_URL = "https://api.openf1.org/v1"


class OpenF1Client:
    """Thin synchronous wrapper around https://openf1.org endpoints."""

    def __init__(self, base_url: str = OPENF1_BASE_URL, timeout: float = 30.0) -> None:
        self._http = httpx.Client(base_url=base_url, timeout=timeout)

    def _get(self, path: str, **params: Any) -> list[dict[str, Any]]:
        # OpenF1 uses operators in the key (e.g. "date>"), so build the query manually.
        query = "&".join(f"{k}={v}" for k, v in params.items() if v is not None)
        url = f"/{path}?{query}" if query else f"/{path}"
        for attempt in range(5):
            resp = self._http.get(url)
            if resp.status_code != 429:
                break
            # Free tier is rate limited; back off and retry.
            time.sleep(float(resp.headers.get("retry-after", 2 ** attempt)))
        resp.raise_for_status()
        return resp.json()

    def sessions(self, **filters: Any) -> list[dict[str, Any]]:
        return self._get("sessions", **filters)

    def laps(self, session_key: int, driver_number: int | None = None, lap_number: int | None = None):
        return self._get("laps", session_key=session_key, driver_number=driver_number, lap_number=lap_number)

    def race_control(self, session_key: int) -> list[dict[str, Any]]:
        return self._get("race_control", session_key=session_key)

    def drivers(self, session_key: int) -> list[dict[str, Any]]:
        return self._get("drivers", session_key=session_key)

    def location(self, session_key: int, driver_number: int, date_from: str, date_to: str):
        return self._get(
            "location",
            session_key=session_key,
            driver_number=driver_number,
            **{"date>": date_from, "date<": date_to},
        )

    def car_data(self, session_key: int, driver_number: int, date_from: str, date_to: str):
        return self._get(
            "car_data",
            session_key=session_key,
            driver_number=driver_number,
            **{"date>": date_from, "date<": date_to},
        )

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "OpenF1Client":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


def load_fastf1_session(year: int, event: str, session: str = "R", cache_dir: str = ".fastf1-cache"):
    """Load a FastF1 session (lazy import: install requirements-fastf1.txt first)."""
    try:
        import fastf1  # type: ignore[import-not-found]
    except ImportError as exc:  # pragma: no cover - optional dependency
        raise RuntimeError("FastF1 is not installed. Run: pip install -r requirements-fastf1.txt") from exc

    fastf1.Cache.enable_cache(cache_dir)
    s = fastf1.get_session(year, event, session)
    s.load(telemetry=True, laps=True, messages=True, weather=False)
    return s
