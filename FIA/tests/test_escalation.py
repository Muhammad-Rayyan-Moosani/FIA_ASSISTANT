"""Escalation ladder: synthetic sequences, and the cached Canada 2025 window (if present)."""
from __future__ import annotations

from pathlib import Path

import pytest

from app.services.escalation import IncidentTracker
from app.services.relative_speed import ReferenceLine, RelativeSpeedDetector, SlowCarEvent
from app.services.replay import epoch, load_window
from app.services.samples import Sample

ROOT = Path(__file__).resolve().parents[2]
HZ = 3.7


def _event(kind="slow", car=4):
    return SlowCarEvent(car, 0.0, 0.1, 61.0, 285.0, 0.2, 2.0, kind=kind,
                        peak_decel_g=12.0 if kind == "crash" else None)


def _run(tracker, car, speeds, rpms=None, gears=None, t0=0.0):
    out = []
    for i, v in enumerate(speeds):
        s = Sample(t0 + i / HZ, car, v, 0.0, 0.0,
                   None if rpms is None else rpms[i], None if gears is None else gears[i])
        if u := tracker.update(s):
            out.append(u)
    return out


def test_slow_car_is_yellow_then_vsc_when_stopped_then_sc_when_the_engine_is_off():
    tr = IncidentTracker()
    first = tr.open(_event("slow"))
    assert (first.stage, first.flag) == ("slow", "YELLOW")
    speeds = [60, 40, 20, 8, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    rpms = [4000, 4000, 4000, 4000, 4000, 4200, 3000, 1600, 0, 0, 0, 0, 0, 0]
    gears = [4, 3, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    ups = _run(tr, 4, speeds, rpms, gears)
    assert [(u.stage, u.flag) for u in ups] == [("stopped", "VSC"), ("engine_off", "SC")]
    assert ups[0].stopped_for_s > 0.5 and ups[0].t < ups[1].t


def test_a_violent_stop_goes_straight_to_double_yellow_then_sc():
    tr = IncidentTracker()
    assert tr.open(_event("crash")).flag == "DOUBLE_YELLOW"
    ups = _run(tr, 4, [0] * 8)
    assert [(u.stage, u.flag) for u in ups] == [("stopped", "SC")]


def test_one_stationary_sample_does_not_confirm_a_stop():
    tr = IncidentTracker()
    tr.open(_event("slow"))
    assert _run(tr, 4, [60, 0, 70, 80, 90, 100]) == []


def test_without_rpm_a_long_stop_still_escalates_to_sc():
    tr = IncidentTracker()
    tr.open(_event("slow"))
    ups = _run(tr, 4, [0] * int(12 * HZ))                              # 12 s stationary, no RPM or gear
    assert [(u.stage, u.flag) for u in ups] == [("stopped", "VSC"), ("stopped", "SC")]
    assert ups[1].stopped_for_s >= 8


def test_moving_again_closes_the_incident():
    tr = IncidentTracker()
    tr.open(_event("slow"))
    ups = _run(tr, 4, [0] * 6 + [80] * 6)
    assert [(u.stage, u.flag) for u in ups] == [("stopped", "VSC"), ("moving_again", "YELLOW")]
    assert not tr.is_open(4)


def test_only_the_flagged_car_is_followed():
    tr = IncidentTracker()
    tr.open(_event("slow", car=4))
    assert _run(tr, 9, [0] * 10) == []


# ----------------------------------------------------------------------------- real data: Canada 2025
WINDOW = ROOT / "data" / "replay" / "montreal_2025_norris"
LAP = ROOT / "data" / "openf1" / "montreal_lap.json"


def _utc(hms: str) -> float:
    return epoch(f"2025-06-15T{hms}+00:00")


@pytest.mark.skipif(not (WINDOW.exists() and LAP.exists()), reason="cached Canada 2025 window not present")
def test_canada_2025_norris_ladder_runs_ahead_of_the_safety_car():
    w = load_window(WINDOW)
    det = RelativeSpeedDetector(ReferenceLine.from_lap_json(LAP, 4361))
    warm_end, sc_at = _utc("19:26:30"), _utc("19:27:32")
    det.fit(s for s in w.samples if s.t < warm_end)
    tracker, updates = IncidentTracker(), []
    for s in w.samples:
        if s.t < warm_end:
            continue
        det.set_neutralised(s.t >= sc_at)
        if u := tracker.update(s):
            updates.append(u)
        if e := det.update(s):
            updates.append(tracker.open(e))

    assert {u.car for u in updates} == {4}
    assert [(u.stage, u.flag) for u in updates] == [("slow", "YELLOW"), ("stopped", "VSC"), ("engine_off", "SC")]
    slow, stopped, off = updates
    assert _utc("19:27:05") <= slow.t <= _utc("19:27:08")
    assert _utc("19:27:09") <= stopped.t <= _utc("19:27:12")             # he stops at about 19:27:09
    assert _utc("19:27:13") <= off.t <= _utc("19:27:17")                 # RPM reaches 0 at about 19:27:13.6
    assert sc_at - stopped.t > 15 and sc_at - off.t > 10                 # both ahead of the real safety car
