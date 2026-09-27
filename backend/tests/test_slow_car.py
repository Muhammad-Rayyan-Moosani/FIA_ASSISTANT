"""Relative-speed detector: synthetic circuit (always runs) and the cached Canada 2025 window (if present)."""
from __future__ import annotations

import json
from dataclasses import replace
from datetime import datetime
from pathlib import Path

import numpy as np
import pytest

from services.race_control.slow_car import ReferenceLine, RelativeSpeedConfig, RelativeSpeedDetector
from services.race_control.window import epoch, load_window
from services.race_control.samples import Sample
from services.race_control.turns import TurnLocator

ROOT = Path(__file__).resolve().parents[2]
HZ = 3.7


# ----------------------------------------------------------------------------- synthetic circuit
R = 6366.0                                  # units of 0.1 m: a 4 km lap
LENGTH_M = 2 * np.pi * R / 10


def _ref() -> ReferenceLine:
    ang = np.linspace(0, 2 * np.pi, 200, endpoint=False)
    return ReferenceLine(np.column_stack([R * np.cos(ang), R * np.sin(ang)]), LENGTH_M)


def _drive(speeds: dict[int, callable], t_from: float, t_to: float, start_ang: dict[int, float]) -> list[Sample]:
    """Cars circling the track; speeds[car](t) gives km/h."""
    out, ang = [], dict(start_ang)
    dt = 1 / HZ
    t = t_from
    while t < t_to:
        for car, fn in speeds.items():
            v = fn(t)
            ang[car] += (v / 3.6 * 10) * dt / R          # m/s -> units/s, then radians
            out.append(Sample(t, car, v, R * np.cos(ang[car]), R * np.sin(ang[car])))
        t += dt
    return out


def _field(n=6):
    return {c: 2 * np.pi * c / n for c in range(1, n + 1)}


def test_projection_progress_is_monotonic_around_the_lap():
    ref = _ref()
    ps = [ref.project(R * np.cos(a), R * np.sin(a)) for a in np.linspace(0.1, 6.2, 30)]
    assert all(b > a for a, b in zip(ps, ps[1:])) and 0 <= ps[0] < ps[-1] <= 1


def test_flags_the_slow_car_and_only_that_car():
    det = RelativeSpeedDetector(_ref())
    speeds = {c: (lambda t: 200.0) for c in range(1, 7)}
    speeds[3] = lambda t: 200.0 if t < 90 else 50.0
    warm = _drive(speeds, 0, 80, _field())
    det.fit(warm)
    ang = _field()
    live = _drive(speeds, 80, 100, {c: ang[c] + (200 / 3.6 * 10) * 80 / R for c in ang})
    events = [e for s in live if (e := det.update(s))]
    assert [e.car for e in events] == [3]
    assert 90 <= events[0].t <= 93.5 and events[0].relative < 0.5


def test_whole_field_slowing_together_flags_nobody():
    det = RelativeSpeedDetector(_ref())
    speeds = {c: (lambda t: 200.0 if t < 90 else 60.0) for c in range(1, 7)}
    det.fit(_drive(speeds, 0, 80, _field()))
    ang = _field()
    live = _drive(speeds, 80, 110, {c: ang[c] + (200 / 3.6 * 10) * 80 / R for c in ang})
    assert [e for s in live if (e := det.update(s))] == []


def test_parked_cars_are_ignored_and_do_not_poison_the_profile():
    det = RelativeSpeedDetector(_ref())
    speeds = {c: (lambda t: 200.0) for c in range(1, 6)}
    speeds[9] = lambda t: 0.0                            # parked at one spot the whole warm-up
    det.fit(_drive(speeds, 0, 80, {**{c: a for c, a in _field(5).items()}, 9: 1.0}))
    assert det.ignored == {9}
    assert det.profile.min() > 150                       # no zero-speed slice from the parked car


def test_no_alerts_while_neutralised_and_alert_once_when_not():
    det = RelativeSpeedDetector(_ref())
    speeds = {c: (lambda t: 200.0) for c in range(1, 7)}
    speeds[2] = lambda t: 200.0 if t < 90 else 40.0
    det.fit(_drive(speeds, 0, 80, _field()))
    ang = {c: a + (200 / 3.6 * 10) * 80 / R for c, a in _field().items()}
    det.set_neutralised(True)
    live = _drive(speeds, 80, 100, ang)
    assert [e for s in live if (e := det.update(s))] == []
    det.set_neutralised(False)
    ang = {c: a + (200 / 3.6 * 10) * 80 / R for c, a in _field().items()}
    live = _drive(speeds, 80, 110, ang)
    assert len([e for s in live if (e := det.update(s))]) == 1


def test_only_cars_behind_are_warned_nearest_first():
    # Six cars 60 degrees (about 667 m) apart, all moving in the direction of increasing angle. Car 3 slows.
    det = RelativeSpeedDetector(_ref())
    speeds = {c: (lambda t: 200.0) for c in range(1, 7)}
    speeds[3] = lambda t: 200.0 if t < 90 else 50.0
    det.fit(_drive(speeds, 0, 80, _field()))
    ang = {c: a + (200 / 3.6 * 10) * 80 / R for c, a in _field().items()}
    warned = None
    for s in _drive(speeds, 80, 100, ang):
        if e := det.update(s):
            warned = det.warn_behind(e)
    assert warned is not None
    # Within 1500 m behind car 3 are car 2 (about 667 m back) and car 1 (about 1333 m back).
    assert [w.car for w in warned] == [2, 1]
    assert warned[0].gap_m < warned[1].gap_m <= 1500
    # Car 4 is 667 m AHEAD, and cars 5 and 6 are further ahead: none of them may be warned.
    assert not {4, 5, 6} & {w.car for w in warned}
    assert all(w.closing_kph > 0 and w.eta_s and w.eta_s > 0 for w in warned)


def _warmed(crash_speed):
    """A field of six at 200 km/h, car 3 following crash_speed(t) after t=90; returns (detector, live samples)."""
    det = RelativeSpeedDetector(_ref())
    speeds = {c: (lambda t: 200.0) for c in range(1, 7)}
    speeds[3] = crash_speed
    det.fit(_drive(speeds, 0, 80, _field()))
    ang = {c: a + (200 / 3.6 * 10) * 80 / R for c, a in _field().items()}
    return det, _drive(speeds, 80, 100, ang)


def test_hard_shunt_into_a_barrier_is_reported_as_a_crash_almost_at_once():
    det, live = _warmed(lambda t: 200.0 if t < 90 else 0.0)          # 200 km/h then 0 on the next sample
    events = [(e, det.warn_behind(e)) for s in live if (e := det.update(s))]
    (e, warned), = events
    assert e.car == 3 and e.kind == "crash" and e.peak_decel_g >= 6
    assert e.t - 90 <= 0.7                                           # the slow-car rule needed 2.2 s
    assert [w.car for w in warned] == [2, 1]                         # the cars behind, nearest first


def test_hard_braking_and_a_single_bad_sample_are_not_crashes():
    det, live = _warmed(lambda t: 200.0 if t < 90 else max(30.0, 200.0 - (t - 90) * 60))   # about 1.7 g
    assert not [e for s in live if (e := det.update(s)) and e.kind == "crash"]

    det, live = _warmed(lambda t: 200.0)
    i = next(k for k, s in enumerate(live) if s.car == 3 and s.t >= 90)
    live[i] = replace(live[i], speed=0.0)                             # one glitched sample
    assert not [e for s in live if (e := det.update(s))]


def test_a_crash_is_still_reported_under_a_safety_car():
    det, live = _warmed(lambda t: 200.0 if t < 90 else 0.0)
    det.set_neutralised(True)
    events = [e for s in live if (e := det.update(s))]
    assert [(e.car, e.kind) for e in events] == [(3, "crash")]


# ----------------------------------------------------------------------------- real data: Canada 2025
WINDOW = ROOT / "data" / "replay" / "montreal_2025_norris"
LAP = ROOT / "data" / "openf1" / "montreal_lap.json"
POINTS = ROOT / "data" / "openf1" / "montreal_track_points.json"
TRACK = ROOT / "data" / "tracks" / "montreal.json"


@pytest.mark.skipif(not (LAP.exists() and POINTS.exists()), reason="Montreal reference data not present")
def test_turn_locator_names_the_turn_and_falls_back_to_between():
    ref = ReferenceLine.from_lap_json(LAP, 4361)
    loc = TurnLocator.from_files(ref, POINTS, TRACK)
    turns = json.loads(POINTS.read_text(encoding="utf-8"))["turns"]
    t1 = next(t for t in turns if t["number"] == 1)
    here = loc.locate(ref.project(t1["x"], t1["y"]))
    assert here.number == 1 and here.label.startswith("Turn 1") and here.distance_m < 50
    ps = sorted(ref.project(t["x"], t["y"]) for t in turns)
    gap = max(range(len(ps) - 1), key=lambda i: ps[i + 1] - ps[i])       # the longest stretch with no turn
    mid = loc.locate((ps[gap] + ps[gap + 1]) / 2)
    assert mid.number is None and mid.label.startswith("between Turn ")


def _utc(hms: str) -> float:
    return epoch(f"2025-06-15T{hms}+00:00")


@pytest.mark.skipif(not (WINDOW.exists() and LAP.exists()), reason="cached Canada 2025 window not present")
def test_canada_2025_norris_is_flagged_before_he_stops():
    w = load_window(WINDOW)
    det = RelativeSpeedDetector(ReferenceLine.from_lap_json(LAP, 4361))
    warm_end = _utc("19:26:30")
    det.fit(s for s in w.samples if s.t < warm_end)
    assert det.ignored == {23, 30}                       # Albon and Lawson: retired earlier, still parked

    sc_at = _utc("19:27:32")                             # SAFETY CAR DEPLOYED in race control
    events, warnings, ahead = [], [], []
    for s in w.samples:
        if s.t < warm_end:
            continue
        det.set_neutralised(s.t >= sc_at)
        if e := det.update(s):
            events.append(e)
            warnings = det.warn_behind(e)
            # Cars within 1500 m ahead of him, measured from the flagged car's position.
            ahead = [c for c, (_, p, _) in det._latest.items()
                     if c != e.car and 0 < ((p - e.progress) % 1.0) * 4361 <= 1500]

    # The warning goes to the cars behind, never to the cars in front.
    assert warnings and all(0 < x.gap_m <= 1500 for x in warnings)
    assert not set(ahead) & {x.car for x in warnings}

    by_car = {e.car: e for e in events}
    assert 4 in by_car and by_car[4].kind == "slow"                # a 1 g roll to a stop, not a barrier hit
    assert not [e for e in events if e.kind == "crash"]
    stop = _utc("19:27:09")
    assert stop - 6 <= by_car[4].t <= stop, datetime.utcfromtimestamp(by_car[4].t)      # before he is stationary
    assert by_car[4].t < sc_at - 20                                                     # well ahead of the safety car
    assert set(by_car) == {4}, {w.drivers[c] for c in by_car}                            # no other car flagged
