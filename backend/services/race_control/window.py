"""(By Yash, ported from FIA/app/services/replay.py.) Load a cached OpenF1 window (FIA/scripts/cache_window.py) as time-ordered samples.

``car_data`` and ``location`` arrive as separate streams at ~3.7 Hz with different timestamps, so
each car's position is interpolated onto its ``car_data`` timestamps.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

import numpy as np

from services.race_control.samples import Sample


def epoch(iso: str) -> float:
    return datetime.fromisoformat(iso).timestamp()


@dataclass
class Window:
    samples: list[Sample]                       # sorted by time
    race_control: list[dict] = field(default_factory=list)
    team_radio: list[dict] = field(default_factory=list)
    drivers: dict[int, str] = field(default_factory=dict)   # car number -> acronym


def _read(path: Path, name: str) -> list[dict]:
    p = path / name
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else []


def load_window(path: Path | str) -> Window:
    path = Path(path)
    car_rows, loc_rows = _read(path, "car_data.json"), _read(path, "location.json")
    locs: dict[int, list[dict]] = {}
    for r in loc_rows:
        locs.setdefault(r["driver_number"], []).append(r)

    samples: list[Sample] = []
    for car in sorted({r["driver_number"] for r in car_rows}):
        loc = sorted(locs.get(car, []), key=lambda r: r["date"])
        if len(loc) < 2:
            continue
        tl = np.array([epoch(r["date"]) for r in loc])
        lx, ly = np.array([r["x"] for r in loc], float), np.array([r["y"] for r in loc], float)
        rows = sorted((r for r in car_rows if r["driver_number"] == car), key=lambda r: r["date"])
        tc = np.array([epoch(r["date"]) for r in rows])
        xs, ys = np.interp(tc, tl, lx), np.interp(tc, tl, ly)
        samples += [Sample(float(t), car, float(r["speed"]), float(x), float(y), r.get("rpm"), r.get("n_gear"))
                    for t, r, x, y in zip(tc, rows, xs, ys)]
    samples.sort(key=lambda s: s.t)
    drivers = {d["driver_number"]: d["name_acronym"] for d in _read(path, "drivers.json")}
    return Window(samples, _read(path, "race_control.json"), _read(path, "team_radio.json"), drivers)
