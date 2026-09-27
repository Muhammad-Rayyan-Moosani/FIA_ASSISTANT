"""Coordinate frame shared by race control and the map.

OpenF1 positions (decimetres) -> the centred, normalised frame of `TrackGeometry.outline`, plus the lap
fraction and distance from the reference line, so replayed cars, crashes and marshal masts land exactly
on the 3D track the insurance map draws.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache

import numpy as np
from scipy.spatial import cKDTree

from services import repository
from services.data_loader import RAW_DIR
from services.zones import UNITS_PER_M, lap_geometry, normaliser, zone_for_frac


@dataclass(frozen=True)
class CircuitFrame:
    circuit: str
    xy: np.ndarray            # reference lap, OpenF1 units
    frac: np.ndarray          # lap fraction per reference sample
    tree: cKDTree
    norm: object              # raw -> [0, 1]² (zones.normaliser)
    centre: object            # [0, 1]² -> centred contract frame (repository._centre)
    zones: list[dict]

    def to_map(self, x: float, y: float) -> tuple[float, float]:
        nx, ny = self.norm(x, y)
        return self.centre(float(nx), float(ny))

    def locate(self, x: float, y: float) -> dict:
        """Map point, lap fraction, zone and distance from the reference line for a raw OpenF1 position."""
        d, i = self.tree.query([x, y])
        frac = float(self.frac[i])
        mx, my = self.to_map(x, y)
        zone = zone_for_frac(self.zones, frac)
        return {"x": mx, "y": my, "lap_frac": round(frac, 4), "zone_id": zone["zone_id"],
                "zone_name": zone["name"], "off_line_m": round(float(d) / UNITS_PER_M, 1)}


@lru_cache(maxsize=4)
def _frame(circuit: str, version: float) -> CircuitFrame:
    d = repository.load(circuit)
    geo = lap_geometry(d.reference["samples"], d.cfg.length_m)
    xy = np.column_stack([geo["x"], geo["y"]])
    return CircuitFrame(circuit, xy, geo["frac"], cKDTree(xy), normaliser(geo),
                        repository._centre(d.track["outline"]), d.track["zones"])


def frame(circuit: str) -> CircuitFrame:
    return _frame(circuit, repository.data_version(circuit))


@lru_cache(maxsize=4)
def marshal_sectors(circuit: str) -> list[dict]:
    """Real marshal sector positions (MultiViewer circuit API), placed on the map and in lap order."""
    points = json.loads((RAW_DIR / f"{circuit}_track_points.json").read_text())
    f = frame(circuit)
    out = []
    for m in points.get("marshal_sectors", []):
        loc = f.locate(m["x"], m["y"])
        out.append({"sector": int(m["number"]), "x": loc["x"], "y": loc["y"], "lap_frac": loc["lap_frac"],
                    "zone_id": loc["zone_id"], "zone_name": loc["zone_name"]})
    return sorted(out, key=lambda s: s["sector"])


def sector_for_frac(circuit: str, lap_frac: float) -> int | None:
    """Marshal sector covering a lap fraction: the last mast at or before that point (masts guard what follows)."""
    sectors = marshal_sectors(circuit)
    if not sectors:
        return None
    by_frac = sorted(sectors, key=lambda s: s["lap_frac"])
    before = [s for s in by_frac if s["lap_frac"] <= lap_frac]
    return (before[-1] if before else by_frac[-1])["sector"]


def previous_sector(circuit: str, sector: int) -> int | None:
    by_frac = sorted(marshal_sectors(circuit), key=lambda s: s["lap_frac"])
    ids = [s["sector"] for s in by_frac]
    if sector not in ids:
        return None
    return ids[ids.index(sector) - 1]
