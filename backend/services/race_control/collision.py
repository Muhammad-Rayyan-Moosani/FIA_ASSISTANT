"""Physics collision estimator: telemetry deltas -> impact, energy and hazard level.

Inputs are one car's real OpenF1 samples (~3.7 Hz speed, ~3.7 Hz position). From them:

* longitudinal g   = −Δv / Δt / g
* lateral g        = v² κ / g, with κ the curvature of the car's own path (heading change per metre)
* impacts          = the existing Step 1 detector (openf1_extract.detect_impacts): a hard hit (≥10 g with
                     ≥60 km/h lost in one step) or a stop from ≥100 km/h within 10 s with ≥2.5 g on the way down;
                     a dip that recovers to 80% of entry speed is discarded as a telemetry glitch
* impact energy    = ½ m v² at impact speed, m = 800 kg (car + driver, as the insurance model)

Hazard level: "incident" (impact, car moving on or a soft stop) or "crash" (hard hit, or a stop carrying
≥0.6 MJ). Low grip without an impact is the grip engine's job (grip.py), not this estimator's: at 3.7 Hz
heavy braking and a spin look alike in the speed trace. Coarse by nature: 3.7 Hz cannot resolve
a real impact pulse, so g values are lower bounds and the level thresholds are set for OpenF1 rates.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass

import numpy as np

from openf1_extract import detect_impacts

G = 9.80665
CAR_MASS_KG = 800.0
STOP_WINDOW_S = 10.0
STOP_MIN_G = 2.5


@dataclass
class CollisionEstimate:
    driver: str
    t: float                      # seconds from the replay start
    level: str                    # "incident" | "crash"
    kind: str                     # detector kind: hit / stop / stop+hit
    entry_speed_kph: float
    impact_speed_kph: float
    speed_drop_kph: float
    peak_long_g: float
    peak_lat_g: float
    energy_mj: float
    stopped: bool
    telemetry_score: float        # 0..1, the telemetry leg of the multimodal severity

    def to_dict(self) -> dict:
        return {k: (round(v, 3) if isinstance(v, float) else v) for k, v in asdict(self).items()}


def lateral_g(t: np.ndarray, v_kph: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """v² κ / g from the car's own path (positions in metres)."""
    if len(t) < 3:
        return np.zeros_like(t)
    dx, dy = np.gradient(x), np.gradient(y)
    ds = np.hypot(dx, dy)
    heading = np.unwrap(np.arctan2(dy, dx))
    with np.errstate(divide="ignore", invalid="ignore"):
        kappa = np.where(ds > 0.5, np.gradient(heading) / ds, 0.0)
    v = v_kph / 3.6
    return np.clip(np.abs(v * v * kappa) / G, 0, 8)          # beyond ~6 g at 3.7 Hz is position noise


def telemetry_score(peak_long_g: float, energy_mj: float, stopped: bool, drop_kph: float) -> float:
    """0..1 severity from the physics alone: impact load, kinetic energy, whether the car stopped."""
    s = 0.4 * min(1.0, peak_long_g / 18) + 0.35 * min(1.0, energy_mj / 2.5) + 0.15 * min(1.0, drop_kph / 200)
    return round(min(1.0, s + (0.1 if stopped else 0.0)), 3)


def estimate(driver: str, t, v_kph, x_m, y_m) -> list[CollisionEstimate]:
    """All impacts in one car's samples, in time order."""
    t, v = np.asarray(t, float), np.asarray(v_kph, float)
    x, y = np.asarray(x_m, float), np.asarray(y_m, float)
    if len(t) < 4:
        return []
    lat = lateral_g(t, v, x, y)
    out: list[CollisionEstimate] = []
    # 10 s / 2.5 g stop window (Step 1 uses 4 s / 5 g): a car that slides along a wall for several seconds
    # before stopping (e.g. Norris, Canada 2025, lap 67) is still one impact at OpenF1's 3.7 Hz
    for ev in detect_impacts(t, v, stop_window_s=STOP_WINDOW_S, min_decel_g=STOP_MIN_G):
        i = int(np.searchsorted(t, ev["t"]))
        after = v[i: int(np.searchsorted(t, ev["t"] + STOP_WINDOW_S, side="right"))]
        stopped = bool(len(after) and after.min() <= 15)
        # a one-sample speed dip that recovers is a telemetry glitch, not an impact: a real hit leaves the
        # car well below its entry speed for the next seconds (or stopped)
        later = v[int(np.searchsorted(t, ev["t"] + 1.0)): int(np.searchsorted(t, ev["t"] + 4.0, side="right"))]
        if not stopped and len(later) and later.max() >= 0.8 * ev["entry_speed_kph"]:
            continue
        lo = int(np.searchsorted(t, ev["t"] - 3.0))
        e = 0.5 * CAR_MASS_KG * (ev["impact_speed_kph"] / 3.6) ** 2 / 1e6
        drop = ev["entry_speed_kph"] - (float(after.min()) if len(after) else ev["impact_speed_kph"])
        hard = ev["peak_decel_g"] >= 10 or (stopped and e >= 0.6)
        level = "crash" if hard else "incident"
        out.append(CollisionEstimate(driver, float(ev["t"]), level, ev["kind"], ev["entry_speed_kph"],
                                     ev["impact_speed_kph"], drop, ev["peak_decel_g"], float(lat[lo:i + 1].max(initial=0)),
                                     e, stopped, telemetry_score(ev["peak_decel_g"], e, stopped, drop)))
    return out
