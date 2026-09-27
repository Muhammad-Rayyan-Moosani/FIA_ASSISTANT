"""Follow a flagged car and escalate the suggested flag as its stop is confirmed.

The detector (``relative_speed``) opens an incident when a car is much slower than the field ("slow")
or has just stopped dead ("crash"). This tracker then watches that one car:

    slow   -> YELLOW              (the car is far below the field's pace)
    crash  -> DOUBLE_YELLOW       (a violent stop)
    stopped                       (speed <= 15 km/h for ~1 s)         slow -> VSC, crash -> SC
    engine_off                    (RPM ~0 and gear 0, stationary)     -> SC
    moving_again                  (back above 60 km/h)                -> YELLOW, incident closed

If RPM is not available, a slow car that stays stationary for ``sc_after_stopped_s`` is escalated to SC
anyway. Flag names are the keys of ``plain_alerts.FLAG_TEXT``. Everything is a suggestion; race control decides.

Not modelled (a known limit): whether the stopped car is on the racing line or in the run-off, and pit stops.
"""
from __future__ import annotations

from dataclasses import dataclass

from app.services.relative_speed import SlowCarEvent
from app.services.samples import Sample


@dataclass(frozen=True)
class EscalationConfig:
    stopped_kph: float = 15.0
    stop_samples: int = 4               # about 1 s at 3.7 Hz
    engine_off_rpm: float = 100.0       # at or below this counts as the engine being off
    engine_off_samples: int = 3
    sc_after_stopped_s: float = 8.0     # fallback when there is no RPM: SC after this long stationary
    moving_kph: float = 60.0
    moving_samples: int = 4


@dataclass(frozen=True)
class IncidentUpdate:
    car: int
    t: float
    stage: str                          # "slow" | "crash" | "stopped" | "engine_off" | "moving_again"
    flag: str                           # YELLOW | DOUBLE_YELLOW | VSC | SC
    reason: str
    stopped_for_s: float = 0.0


@dataclass
class _Track:
    origin: str                         # "slow" or "crash"
    stage: str
    still: int = 0                      # consecutive stationary samples
    still_since: float | None = None
    engine_off: int = 0                 # consecutive engine-off samples while stationary
    moving: int = 0
    sc_sent: bool = False


class IncidentTracker:
    def __init__(self, cfg: EscalationConfig | None = None) -> None:
        self.cfg = cfg or EscalationConfig()
        self._tracks: dict[int, _Track] = {}

    def open(self, event: SlowCarEvent) -> IncidentUpdate:
        """Start following the car the detector just flagged; returns the first suggestion."""
        self._tracks[event.car] = _Track(origin=event.kind, stage=event.kind)
        if event.kind == "crash":
            return IncidentUpdate(event.car, event.t, "crash", "DOUBLE_YELLOW",
                                  f"sudden stop from a high speed (about {event.peak_decel_g:.0f} g)")
        return IncidentUpdate(event.car, event.t, "slow", "YELLOW",
                              f"{event.speed_kph:.0f} km/h where cars normally do {event.expected_kph:.0f}")

    def is_open(self, car: int) -> bool:
        return car in self._tracks

    def update(self, s: Sample) -> IncidentUpdate | None:
        tr = self._tracks.get(s.car)
        if tr is None:
            return None
        cfg = self.cfg
        if s.speed <= cfg.stopped_kph:
            tr.still += 1
            tr.still_since = s.t if tr.still_since is None else tr.still_since
            tr.moving = 0
        else:
            tr.still, tr.still_since, tr.engine_off = 0, None, 0
            tr.moving = tr.moving + 1 if s.speed >= cfg.moving_kph else 0
        stopped_for = 0.0 if tr.still_since is None else s.t - tr.still_since

        off = s.rpm is not None and s.gear is not None and s.rpm <= cfg.engine_off_rpm and s.gear == 0
        tr.engine_off = tr.engine_off + 1 if (off and tr.still) else 0

        if tr.stage in ("stopped", "engine_off") and tr.moving >= cfg.moving_samples:
            del self._tracks[s.car]
            return IncidentUpdate(s.car, s.t, "moving_again", "YELLOW", "moving again")
        if tr.stage != "engine_off" and tr.engine_off >= cfg.engine_off_samples:
            tr.stage = "engine_off"
            return IncidentUpdate(s.car, s.t, "engine_off", "SC", "engine off and the car is stationary", stopped_for)
        if tr.stage in ("slow", "crash") and tr.still >= cfg.stop_samples:
            tr.stage = "stopped"
            return IncidentUpdate(s.car, s.t, "stopped", "SC" if tr.origin == "crash" else "VSC",
                                  f"stationary for {stopped_for:.1f} s", stopped_for)
        if tr.stage == "stopped" and not tr.sc_sent and stopped_for >= cfg.sc_after_stopped_s:
            tr.sc_sent = True
            return IncidentUpdate(s.car, s.t, "stopped", "SC", f"stationary for {stopped_for:.0f} s", stopped_for)
        return None
