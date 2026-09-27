"""Relative-speed detector: is a car much slower than the field at the same place on the lap?

For every sample the car's position is projected onto the circuit's reference lap to get its
*progress* (0-1 around the lap). Two things are compared:

* **Expected speed at that progress**: the median speed of the running cars that passed the same
  50 m slice during a warm-up period (``fit``). Corners are slow and straights fast, so this says
  what "normal" is at each spot without any g-force threshold.
* **Field pace**: the median ratio (speed / expected) of the *other* cars over the last few
  seconds. When everyone slows together (yellows, VSC, safety car) the pace drops with them and
  nobody is flagged.

A car is flagged once its ratio, relative to the field pace, stays below ``threshold`` for
``min_duration_s``. Each car alerts once until it recovers.

Known limits (by design, for now): the pit lane is not treated specially, so a car driving down it
looks slow; and cars that are parked for the whole warm-up (earlier retirements) are ignored, not
reported.
"""
from __future__ import annotations

import json
from collections import deque
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from app.services.samples import Sample


@dataclass(frozen=True)
class RelativeSpeedConfig:
    bin_m: float = 50.0             # width of a progress slice
    threshold: float = 0.5          # flag below this fraction of the field-adjusted expected speed
    min_duration_s: float = 2.0     # ... for at least this long
    recover: float = 0.8            # a flagged car re-arms once it is back above this
    pace_window_s: float = 4.0      # field pace = median ratio of the other cars over this window
    min_pace_samples: int = 10      # ... needing at least this many samples
    min_running_kph: float = 100.0  # a car is "running" if it exceeds this during the warm-up
    min_expected_kph: float = 40.0  # floor on expected speed, so slow corners do not blow up the ratio
    min_bin_samples: int = 3
    warn_gap_m: float = 1500.0      # warn cars up to this far behind (about 20 s at 300 km/h)
    max_age_s: float = 1.5          # ignore a car whose last sample is older than this
    # Violent stop (a car hitting a barrier), reported at once instead of waiting for min_duration_s:
    crash_from_kph: float = 100.0   # the car was at least this fast in the last crash_window_s ...
    crash_to_kph: float = 30.0      # ... and is at or below this now (and was on the previous sample too)
    crash_min_drop_kph: float = 80.0
    crash_min_g: float = 6.0        # average deceleration from the last fast sample (hard braking is about 5 g)
    crash_min_dt_s: float = 0.3     # stops timestamp jitter from inflating the g figure
    crash_window_s: float = 2.0


@dataclass(frozen=True)
class CarWarning:
    car: int
    gap_m: float                    # distance along the track from this car forward to the flagged car
    speed_kph: float
    closing_kph: float              # this car's speed minus the flagged car's speed (negative: not closing)
    eta_s: float | None             # time to reach the flagged car at the current closing speed, if closing


@dataclass(frozen=True)
class SlowCarEvent:
    car: int
    t: float
    progress: float
    speed_kph: float
    expected_kph: float
    relative: float                 # ratio to the field-adjusted expected speed
    below_for_s: float
    kind: str = "slow"              # "slow": well below the field's pace; "crash": a violent stop
    peak_decel_g: float | None = None   # for a crash: average g from the last fast sample


class ReferenceLine:
    """A closed reference lap; projects x/y onto it as a lap fraction."""

    def __init__(self, xy: np.ndarray, length_m: float) -> None:
        pts = np.vstack([xy, xy[:1]]).astype(float)
        self._a, self._b = pts[:-1], pts[1:]
        self._ab = self._b - self._a
        self._l2 = np.maximum((self._ab ** 2).sum(1), 1e-9)
        seg = np.sqrt(self._l2)
        self._seg = seg
        self._cum = np.r_[0.0, np.cumsum(seg)]
        self.length_m = float(length_m)

    @classmethod
    def from_lap_json(cls, path: Path | str, length_m: float) -> ReferenceLine:
        samples = json.loads(Path(path).read_text(encoding="utf-8"))["samples"]
        return cls(np.array([[s["x"], s["y"]] for s in samples], float), length_m)

    def project(self, x: float, y: float) -> float:
        p = np.array([x, y], float)
        u = np.clip(((p - self._a) * self._ab).sum(1) / self._l2, 0.0, 1.0)
        d = np.hypot(*(self._a + self._ab * u[:, None] - p).T)
        j = int(np.argmin(d))
        return float((self._cum[j] + u[j] * self._seg[j]) / self._cum[-1])


class RelativeSpeedDetector:
    def __init__(self, ref: ReferenceLine, cfg: RelativeSpeedConfig | None = None) -> None:
        self.ref = ref
        self.cfg = cfg or RelativeSpeedConfig()
        self.nbins = max(int(ref.length_m / self.cfg.bin_m), 1)
        self.profile: np.ndarray | None = None
        self.ignored: set[int] = set()             # cars parked through the warm-up
        self.neutralised = False                   # set while a SC / VSC is out: everyone is slow on purpose
        self._recent: deque[tuple[float, int, float]] = deque()
        self._below_since: dict[int, float] = {}
        self._alerted: set[int] = set()
        self._latest: dict[int, tuple[float, float, float]] = {}    # car -> (t, progress, speed_kph)
        self._hist: dict[int, deque[tuple[float, float]]] = {}      # car -> recent (t, speed_kph)
        self._crashed: set[int] = set()

    # ------------------------------------------------------------------ warm-up
    def fit(self, samples: Iterable[Sample]) -> None:
        """Build the expected-speed profile from warm-up samples of the running cars."""
        cfg = self.cfg
        by_car: dict[int, list[tuple[float, float]]] = {}
        for s in samples:
            by_car.setdefault(s.car, []).append((self.ref.project(s.x, s.y), s.speed))
        running = {c for c, pts in by_car.items() if max(v for _, v in pts) >= cfg.min_running_kph}
        self.ignored = set(by_car) - running       # parked / retired: would poison the profile with zeros

        slices: list[list[float]] = [[] for _ in range(self.nbins)]
        for c in running:
            for p, v in by_car[c]:
                slices[min(int(p * self.nbins), self.nbins - 1)].append(v)
        med = np.array([np.median(b) if len(b) >= cfg.min_bin_samples else np.nan for b in slices])
        ok = ~np.isnan(med)
        if not ok.any():
            raise ValueError("not enough warm-up samples to build a speed profile")
        self.profile = np.interp(np.arange(self.nbins), np.arange(self.nbins)[ok], med[ok], period=self.nbins)

    # ------------------------------------------------------------------ live
    def set_neutralised(self, on: bool) -> None:
        self.neutralised = on
        if on:
            self._below_since.clear()

    def update(self, s: Sample) -> SlowCarEvent | None:
        if self.profile is None:
            raise RuntimeError("call fit() with warm-up samples first")
        if s.car in self.ignored:
            return None
        cfg = self.cfg
        progress = self.ref.project(s.x, s.y)
        self._latest[s.car] = (s.t, progress, s.speed)
        expected = max(float(self.profile[min(int(progress * self.nbins), self.nbins - 1)]), cfg.min_expected_kph)
        ratio = s.speed / expected

        # A violent stop is reported at once, and even while a SC / VSC is out.
        hist = self._hist.setdefault(s.car, deque())
        hist.append((s.t, s.speed))
        while hist and s.t - hist[0][0] > cfg.crash_window_s:
            hist.popleft()
        if s.car in self._crashed:
            if s.speed >= cfg.crash_from_kph:
                self._crashed.discard(s.car)                # driving again: re-arm
        elif (g := self._crash_g(s, hist)) is not None:
            self._crashed.add(s.car)
            self._alerted.add(s.car)                        # no second, slower "slow car" alert for the same car
            return SlowCarEvent(s.car, s.t, progress, s.speed, expected, ratio, 0.0, kind="crash", peak_decel_g=g)

        self._recent.append((s.t, s.car, ratio))
        while self._recent and s.t - self._recent[0][0] > cfg.pace_window_s:
            self._recent.popleft()
        others = [r for _, c, r in self._recent if c != s.car]
        if self.neutralised or len(others) < cfg.min_pace_samples:
            return None
        rel = ratio / float(np.median(others))

        if rel >= cfg.recover:
            self._alerted.discard(s.car)
        if rel >= cfg.threshold:
            self._below_since.pop(s.car, None)
            return None
        since = self._below_since.setdefault(s.car, s.t)
        if s.car in self._alerted or s.t - since < cfg.min_duration_s:
            return None
        self._alerted.add(s.car)
        return SlowCarEvent(s.car, s.t, progress, s.speed, expected, rel, s.t - since)

    def _crash_g(self, s: Sample, hist: deque[tuple[float, float]]) -> float | None:
        """Average deceleration since the last fast sample, if the car has just stopped dead, else None."""
        cfg = self.cfg
        if s.speed > cfg.crash_to_kph or len(hist) < 3 or hist[-2][1] > cfg.crash_to_kph + 10:
            return None                                     # not slow, or only one low sample (could be a glitch)
        fast = next(((t, v) for t, v in reversed(hist) if v >= cfg.crash_from_kph), None)
        if fast is None or fast[1] - s.speed < cfg.crash_min_drop_kph:
            return None
        g = (fast[1] - s.speed) / 3.6 / max(s.t - fast[0], cfg.crash_min_dt_s) / 9.80665
        return g if g >= cfg.crash_min_g else None

    def warn_behind(self, event: SlowCarEvent) -> list[CarWarning]:
        """The cars that will reach the flagged car next: behind it on the track, within ``warn_gap_m``.

        "Behind" is along the lap (lower progress), not race position, so a lapped car just behind
        counts. Cars ahead of the flagged car are never included: measured forward from a car ahead,
        the gap to the flagged car is almost a whole lap. Nearest first.
        """
        cfg, out = self.cfg, []
        for car, (t, progress, speed) in self._latest.items():
            if car == event.car or event.t - t > cfg.max_age_s:
                continue
            gap_m = ((event.progress - progress) % 1.0) * self.ref.length_m
            if not 0 < gap_m <= cfg.warn_gap_m:
                continue
            closing = speed - event.speed_kph
            eta = gap_m / (closing / 3.6) if closing > 1 else None
            out.append(CarWarning(car, gap_m, speed, closing, eta))
        return sorted(out, key=lambda w: w.gap_m)
