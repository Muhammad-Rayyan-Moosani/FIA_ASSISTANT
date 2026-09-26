"""Thin OpenF1 REST wrapper that produces μMap ``TelemetrySample`` frames.

OpenF1 serves car data (~3.7 Hz: speed, throttle, brake) and location (~3.7 Hz:
x, y, z) as separate streams; we align them per driver with ``merge_asof``.
Note: OpenF1's ``brake`` channel is binary (0/100), so residuals from it are a
coarser signal than line-pressure telemetry from a team or FIA feed.
"""
from __future__ import annotations

import httpx
import pandas as pd

from app.schemas.umap import TelemetrySample

BASE_URL = "https://api.openf1.org/v1"


async def fetch_samples(
    session_key: int,
    driver_numbers: list[int],
    start_iso: str | None = None,
    end_iso: str | None = None,
    position_scale: float = 0.1,
    client: httpx.AsyncClient | None = None,
) -> list[TelemetrySample]:
    own = client is None
    client = client or httpx.AsyncClient(base_url=BASE_URL, timeout=30)
    try:
        frames = []
        for drv in driver_numbers:
            # OpenF1 range filters are written literally (``date>2023-...``), not as key=value.
            query = f"session_key={session_key}&driver_number={drv}"
            if start_iso:
                query += f"&date>{start_iso}"
            if end_iso:
                query += f"&date<{end_iso}"
            car = (await client.get(f"/car_data?{query}")).raise_for_status().json()
            loc = (await client.get(f"/location?{query}")).raise_for_status().json()
            if not car or not loc:
                continue
            car_df = pd.DataFrame(car)[["date", "speed", "throttle", "brake"]]
            loc_df = pd.DataFrame(loc)[["date", "x", "y"]]
            for d in (car_df, loc_df):
                d["date"] = pd.to_datetime(d["date"], utc=True, format="ISO8601")
                d.sort_values("date", inplace=True)
            merged = pd.merge_asof(car_df, loc_df, on="date", direction="nearest",
                                   tolerance=pd.Timedelta("500ms")).dropna()
            merged["car_id"] = str(drv)
            frames.append(merged)
        if not frames:
            return []
        df = pd.concat(frames, ignore_index=True)
        t0 = df["date"].min()
        df["timestamp"] = (df["date"] - t0).dt.total_seconds()
        return [
            TelemetrySample(
                car_id=r.car_id,
                timestamp=float(r.timestamp),
                speed_kph=float(min(max(r.speed, 0), 450)),
                throttle=float(min(max(r.throttle, 0), 100)),
                brake=float(min(max(r.brake, 0), 100)),
                x=float(r.x) * position_scale,
                y=float(r.y) * position_scale,
            )
            for r in df.itertuples()
        ]
    finally:
        if own:
            await client.aclose()
