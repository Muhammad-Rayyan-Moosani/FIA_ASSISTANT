"""(By Yash, ported from FIA/app/services/track_turns.py.) Say where on the lap something happened: the nearest official turn, or "between Turn A and Turn B".

Turn positions come from ``data/openf1/{circuit}_track_points.json`` (raw OpenF1 x/y, the same frame as
the telemetry) and are projected onto the same ``ReferenceLine`` the detectors use, so a car's lap
progress and a turn's lap progress are directly comparable. Names come from ``data/tracks/{circuit}.json``.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from services.race_control.slow_car import ReferenceLine


@dataclass(frozen=True)
class TurnLocation:
    number: int | None          # the nearest turn, when within ``near_m`` of it
    name: str | None
    label: str                  # "Turn 13 (Wall of Champions)" or "between Turn 10 and Turn 11"
    distance_m: float           # to the nearest turn along the lap


class TurnLocator:
    def __init__(self, ref: ReferenceLine, turns: list[dict], near_m: float = 200.0) -> None:
        self.ref, self.near_m = ref, near_m
        self.turns = sorted((ref.project(t["x"], t["y"]), t["number"], t.get("name")) for t in turns)

    @classmethod
    def from_files(cls, ref: ReferenceLine, points_json: Path | str, tracks_json: Path | str | None = None,
                   near_m: float = 200.0) -> TurnLocator:
        turns = json.loads(Path(points_json).read_text(encoding="utf-8"))["turns"]
        if tracks_json and Path(tracks_json).exists():
            names = {t["number"]: t.get("name") for t in json.loads(Path(tracks_json).read_text(encoding="utf-8"))["turns"]}
            turns = [{**t, "name": names.get(t["number"])} for t in turns]
        return cls(ref, turns, near_m)

    def _label(self, number: int, name: str | None) -> str:
        return f"Turn {number} ({name})" if name and name != f"Turn {number}" else f"Turn {number}"

    def locate(self, progress: float) -> TurnLocation:
        L = self.ref.length_m
        dist = lambda p: min(abs(progress - p), 1 - abs(progress - p)) * L      # noqa: E731
        p, number, name = min(self.turns, key=lambda t: dist(t[0]))
        d = dist(p)
        if d <= self.near_m:
            return TurnLocation(number, name, self._label(number, name), d)
        before = [t for t in self.turns if t[0] <= progress]
        after = [t for t in self.turns if t[0] > progress]
        prev = before[-1] if before else self.turns[-1]            # wrap around the start/finish line
        nxt = after[0] if after else self.turns[0]
        return TurnLocation(None, None, f"between Turn {prev[1]} and Turn {nxt[1]}", d)
