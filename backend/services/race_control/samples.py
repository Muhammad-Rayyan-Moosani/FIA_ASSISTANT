"""The common shape of one car's telemetry at one instant, consumed by the live detectors."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Sample:
    t: float                    # epoch seconds, UTC
    car: int                    # car number
    speed: float                # km/h
    x: float                    # OpenF1 position units (0.1 m)
    y: float
    rpm: float | None = None
    gear: int | None = None
