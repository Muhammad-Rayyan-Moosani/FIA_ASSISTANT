"""μMap grip-anomaly engine (ported from FIA/app/services/telemetry.py, telemetry-only).

For every braking interval we compare the deceleration the car *achieved* with what it *should* achieve:

    residual = actual deceleration / expected deceleration

A residual well below 1 means the tyres could not transmit the braking the driver asked for (oil, water,
debris, marbles). Residuals are bucketed into 25 m along-track segments:

* 1 car below threshold in a segment         -> WATCH
* 2+ distinct cars below threshold, same seg -> ALERT

Expected deceleration: the FIA service used a physics curve a(v, b) = b (A0 + A2 v²) + D2 v² on every sample
interval. On real OpenF1 data that flags almost every braking zone: the brake channel is on/off and sampled at
3.7 Hz (a car covers ~80 m between samples at 300 km/h), so brake onset and release smear into every interval.
Here each *braking event* is scored instead: the mean deceleration from brake-on to brake-off, compared with
the median of the other cars' events starting in the same 100 m braking zone inside the last two minutes
(at least 4 of them). A car is flagged below 60% of its peers; the physics curve stays as a sanity bound.
Zones are keyed by distance along the real lap, so every one maps to a marshal sector.
"""
from __future__ import annotations

import threading
from dataclasses import dataclass, field

import numpy as np

SEGMENT_M = 100.0
RESIDUAL_THRESHOLD = 0.60
MIN_PEERS = 4
MIN_SPEED_KPH_BRAKING = 150.0
MIN_EVENT_S, MIN_DROP_KPH = 0.5, 40.0
FLAG_WINDOW_S = 120.0
# Expected deceleration a(v, b) = b (A0 + A2 v²) + D2 v² (m/s²): ~5 g from 300 km/h, ~2 g from 90 km/h.
DECEL_A0, DECEL_A2, DECEL_D2 = 16.7, 0.00324, 0.00145


def expected_deceleration(speed_ms: np.ndarray, brake_frac: np.ndarray) -> np.ndarray:
    v2 = np.square(speed_ms)
    return brake_frac * (DECEL_A0 + DECEL_A2 * v2) + DECEL_D2 * v2


@dataclass
class _Flag:
    car: str
    t: float
    residual: float


@dataclass
class _Segment:
    index: int
    flags: list[_Flag] = field(default_factory=list)
    observed: list[tuple[str, float, float]] = field(default_factory=list)   # (car, decel m/s², t)
    level: str = "NONE"


@dataclass
class GripEvent:
    segment: int
    distance_m: float
    level: str
    previous: str
    cars: list[str]
    min_residual: float | None
    t: float


class GripEngine:
    def __init__(self, lap_length_m: float) -> None:
        self.lap_length_m = lap_length_m
        self._lock = threading.Lock()
        self._segments: dict[int, _Segment] = {}
        self._runs: dict[str, tuple[float, float, float, float, float]] = {}  # car -> (t0, v0, frac0, t1, v1)
        self._clock = 0.0

    def reset(self) -> None:
        with self._lock:
            self._segments.clear()
            self._runs.clear()
            self._clock = 0.0

    def ingest(self, car: str, t: float, speed_kph: float, brake: float, lap_frac: float) -> list[GripEvent]:
        """Feed one sample; a braking event is scored when the brake is released. Returns segment changes."""
        with self._lock:
            self._clock = max(self._clock, t)
            run = self._runs.get(car)
            braking = brake >= 99
            if braking and run is None and speed_kph >= MIN_SPEED_KPH_BRAKING:
                self._runs[car] = (t, speed_kph, lap_frac, t, speed_kph)
            elif braking and run is not None:
                self._runs[car] = (*run[:3], t, speed_kph)
            elif not braking and run is not None:
                del self._runs[car]
                t0, v0, f0, t1, v1 = run
                dur, drop = t1 - t0, v0 - v1
                if dur >= MIN_EVENT_S and drop >= MIN_DROP_KPH:
                    actual = drop / 3.6 / dur
                    physics = float(expected_deceleration(np.array([v0 / 3.6]), np.array([1.0]))[0])
                    if actual <= 1.6 * physics:                   # beyond that it is an impact, not braking
                        idx = int((f0 * self.lap_length_m) // SEGMENT_M)
                        seg = self._segments.setdefault(idx, _Segment(idx))
                        peers = [d for c, d, ts in seg.observed if c != car and ts >= t - FLAG_WINDOW_S]
                        if len(peers) >= MIN_PEERS:
                            residual = actual / float(np.median(peers))
                            if residual < RESIDUAL_THRESHOLD:
                                seg.flags.append(_Flag(car, t, round(residual, 3)))
                        seg.observed = [*seg.observed, (car, actual, t)][-40:]
            return self._reevaluate()

    def _reevaluate(self) -> list[GripEvent]:
        horizon = self._clock - FLAG_WINDOW_S
        events = []
        for seg in self._segments.values():
            seg.flags = [f for f in seg.flags if f.t >= horizon]
            cars = sorted({f.car for f in seg.flags})
            level = "ALERT" if len(cars) >= 2 else "WATCH" if cars else "NONE"
            if level != seg.level:
                res = [f.residual for f in seg.flags]
                events.append(GripEvent(seg.index, (seg.index + 0.5) * SEGMENT_M, level, seg.level, cars,
                                        min(res) if res else None, self._clock))
                seg.level = level
        return events
