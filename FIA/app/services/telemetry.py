"""μMap grip-anomaly engine.

For every braking sample we compare the deceleration the car *achieved* with the
deceleration a car on a normal-grip surface *should* achieve at that speed and
brake pressure:

    TelemetryResidual = ActualDeceleration / ExpectedDeceleration

A residual well below 1 means the tyres could not transmit the braking force the
driver asked for — a local "grip cliff" (water, oil, dust, rubber marbles...).

Residuals are bucketed into 25 m track segments:

* 1 car below threshold in a segment        -> ``WATCH``
* 2+ distinct cars below threshold, same seg -> ``ALERT``

Vision anomalies (``register_vision``) are fused onto the nearest segment and
can promote a single-car WATCH to ALERT.
"""
from __future__ import annotations

import math
import threading
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from app.config import TelemetryConfig
from app.schemas.umap import (
    EvidenceCard,
    HazardEvent,
    HazardType,
    Point2D,
    ResidualPoint,
    SegmentState,
    Severity,
    TelemetrySample,
    VisionDetection,
)

_LEVEL_ORDER = {Severity.NONE: 0, Severity.WATCH: 1, Severity.ALERT: 2}


@dataclass
class _Flag:
    car_id: str
    ts: float
    residual: float


@dataclass
class _VisionEvidence:
    detection: VisionDetection
    ts: float


@dataclass
class _Segment:
    sector_id: str
    sum_x: float = 0.0
    sum_y: float = 0.0
    n: int = 0
    flags: list[_Flag] = field(default_factory=list)
    vision: list[_VisionEvidence] = field(default_factory=list)
    level: Severity = Severity.NONE

    @property
    def centroid(self) -> Point2D:
        if self.n == 0:
            return Point2D(x=0.0, y=0.0)
        return Point2D(x=self.sum_x / self.n, y=self.sum_y / self.n)


def expected_deceleration(speed_ms: np.ndarray, brake_frac: np.ndarray, cfg: TelemetryConfig) -> np.ndarray:
    """Normal-grip deceleration (m/s^2) for a given speed and brake application."""
    v2 = np.square(speed_ms)
    return brake_frac * (cfg.decel_a0 + cfg.decel_a2 * v2) + cfg.decel_d2 * v2


def sector_ids(distance_m: pd.Series, x: pd.Series, y: pd.Series, seg_len: float) -> pd.Series:
    """Vectorised 25 m segment keys: along-track if lap distance is known, else a spatial grid."""
    along = "seg_" + np.floor(distance_m.fillna(0) / seg_len).astype(int).astype(str).str.zfill(4)
    gx = np.floor(x / seg_len).astype(int).astype(str)
    gy = np.floor(y / seg_len).astype(int).astype(str)
    grid = "grid_" + gx + "_" + gy
    return along.where(distance_m.notna(), grid)


class GripAnomalyEngine:
    def __init__(self, cfg: TelemetryConfig) -> None:
        self.cfg = cfg
        self._lock = threading.Lock()
        self._segments: dict[str, _Segment] = {}
        self._last_sample: dict[str, dict] = {}
        self._clock = 0.0  # latest session time seen

    # ------------------------------------------------------------------ public API
    def reset(self) -> None:
        with self._lock:
            self._segments.clear()
            self._last_sample.clear()
            self._clock = 0.0

    def ingest(self, samples: list[TelemetrySample]) -> tuple[list[ResidualPoint], list[HazardEvent], int]:
        """Score a batch of samples. Returns (residuals, level-change events, evaluated count)."""
        cfg = self.cfg
        with self._lock:
            new = pd.DataFrame([s.model_dump() for s in samples])
            new["_prior"] = False
            prior = pd.DataFrame(
                [s for cid, s in self._last_sample.items() if cid in set(new["car_id"])]
            )
            if not prior.empty:
                prior["_prior"] = True
                df = pd.concat([prior, new], ignore_index=True)
            else:
                df = new
            df["distance_m"] = pd.to_numeric(df["distance_m"], errors="coerce")
            df = df.sort_values(["car_id", "timestamp"], kind="stable").reset_index(drop=True)

            # ---- vectorised physics -------------------------------------------------
            v = df["speed_kph"].to_numpy(float) / 3.6
            g = df.groupby("car_id", sort=False)
            dv = g["speed_kph"].diff().to_numpy(float) / 3.6
            dt = g["timestamp"].diff().to_numpy(float)
            v_prev = v - np.nan_to_num(dv)
            v_mid = 0.5 * (v + v_prev)
            brake_frac = df["brake"].to_numpy(float) / 100.0

            with np.errstate(divide="ignore", invalid="ignore"):
                actual = -dv / dt
            expected = expected_deceleration(v_mid, brake_frac, cfg)

            valid = (
                ~df["_prior"].to_numpy()
                & np.isfinite(actual)
                & (dt >= cfg.min_dt_s) & (dt <= cfg.max_dt_s)
                & (brake_frac >= cfg.min_brake_fraction)
                & (v_mid >= cfg.min_speed_ms)
            )
            with np.errstate(divide="ignore", invalid="ignore"):
                residual = np.where(valid, actual / expected, np.nan)
            below = valid & (residual < cfg.residual_threshold)

            df["sector_id"] = sector_ids(df["distance_m"], df["x"], df["y"], cfg.segment_length_m)
            fresh = df[~df["_prior"]]

            # ---- segment centroids (all fresh samples) --------------------------------
            agg = fresh.groupby("sector_id").agg(sx=("x", "sum"), sy=("y", "sum"), n=("x", "size"))
            for sid, row in agg.iterrows():
                seg = self._segment(sid)
                seg.sum_x += float(row.sx)
                seg.sum_y += float(row.sy)
                seg.n += int(row.n)

            # ---- flags ----------------------------------------------------------------
            for i in np.flatnonzero(below):
                self._segment(df.at[i, "sector_id"]).flags.append(
                    _Flag(str(df.at[i, "car_id"]), float(df.at[i, "timestamp"]), float(residual[i]))
                )

            # ---- remember last sample per car for cross-batch differencing ------------
            last = fresh.sort_values("timestamp").groupby("car_id").tail(1)
            for rec in last.drop(columns=["_prior", "sector_id"]).to_dict("records"):
                self._last_sample[str(rec["car_id"])] = rec
            self._clock = max(self._clock, float(fresh["timestamp"].max()))

            residuals = [
                ResidualPoint(
                    car_id=str(df.at[i, "car_id"]),
                    timestamp=float(df.at[i, "timestamp"]),
                    sector_id=df.at[i, "sector_id"],
                    x=float(df.at[i, "x"]),
                    y=float(df.at[i, "y"]),
                    speed_kph=float(df.at[i, "speed_kph"]),
                    actual_decel_ms2=round(float(actual[i]), 3),
                    expected_decel_ms2=round(float(expected[i]), 3),
                    residual=round(float(residual[i]), 4),
                    below_threshold=bool(below[i]),
                )
                for i in np.flatnonzero(valid)
            ]
            events = self._reevaluate()
            return residuals, events, int(valid.sum())

    def register_vision(self, detections: list[VisionDetection]) -> list[HazardEvent]:
        """Attach vision detections to the nearest known segment (or a new grid cell)."""
        cfg = self.cfg
        with self._lock:
            for det in detections:
                seg = self._nearest_segment(det.map_coordinates)
                if seg is None:
                    p = det.map_coordinates
                    sid = f"grid_{math.floor(p.x / cfg.segment_length_m)}_{math.floor(p.y / cfg.segment_length_m)}"
                    seg = self._segment(sid)
                    if seg.n == 0:
                        seg.sum_x, seg.sum_y, seg.n = p.x, p.y, 1
                seg.vision.append(_VisionEvidence(det, self._clock))
            return self._reevaluate()

    def snapshot(self) -> list[SegmentState]:
        with self._lock:
            return [
                SegmentState(
                    sector_id=s.sector_id,
                    severity_level=s.level,
                    centroid=s.centroid,
                    cars_flagged=sorted({f.car_id for f in s.flags}),
                    vision_detections=len(s.vision),
                )
                for s in sorted(self._segments.values(), key=lambda s: s.sector_id)
                if s.level != Severity.NONE or s.flags or s.vision
            ]

    # ------------------------------------------------------------------ internals
    def _segment(self, sid: str) -> _Segment:
        seg = self._segments.get(sid)
        if seg is None:
            seg = self._segments[sid] = _Segment(sid)
        return seg

    def _nearest_segment(self, p: Point2D) -> _Segment | None:
        cands = [s for s in self._segments.values() if s.n > 0]
        if not cands:
            return None
        c = np.array([[s.centroid.x, s.centroid.y] for s in cands])
        d = np.hypot(c[:, 0] - p.x, c[:, 1] - p.y)
        i = int(np.argmin(d))
        return cands[i] if d[i] <= self.cfg.fusion_radius_m else None

    def _reevaluate(self) -> list[HazardEvent]:
        horizon = self._clock - self.cfg.flag_window_s
        events: list[HazardEvent] = []
        for seg in self._segments.values():
            seg.flags = [f for f in seg.flags if f.ts >= horizon]
            seg.vision = [v for v in seg.vision if v.ts >= horizon]
            cars = {f.car_id for f in seg.flags}
            has_vision = bool(seg.vision)
            if len(cars) >= 2 or (cars and has_vision):
                level = Severity.ALERT
            elif cars or has_vision:
                level = Severity.WATCH
            else:
                level = Severity.NONE
            if level != seg.level:
                events.append(self._event(seg, level))
                seg.level = level
        events.sort(key=lambda e: -_LEVEL_ORDER[e.severity_level])
        return events

    def _event(self, seg: _Segment, level: Severity) -> HazardEvent:
        cars = sorted({f.car_id for f in seg.flags})
        res = [f.residual for f in seg.flags]
        hazards = [HazardType.GRIP_CLIFF] if seg.flags else []
        for v in seg.vision:
            if v.detection.hazard_type not in hazards:
                hazards.append(v.detection.hazard_type)
        if level == Severity.NONE:
            narrative = f"{seg.sector_id}: no low-grip evidence inside the last {self.cfg.flag_window_s:.0f}s — cleared."
        else:
            parts = []
            if cars:
                parts.append(
                    f"{len(cars)} car(s) ({', '.join(cars)}) braked at {min(res):.0%} of expected deceleration"
                )
            if seg.vision:
                kinds = ", ".join(sorted({v.detection.hazard_type.value for v in seg.vision}))
                parts.append(f"camera flagged {kinds}")
            narrative = f"{seg.sector_id}: " + "; ".join(parts) + "."
        return HazardEvent(
            sector_id=seg.sector_id,
            coordinates=seg.centroid,
            severity_level=level,
            previous_level=seg.level,
            evidence_card_data=EvidenceCard(
                hazard_types=hazards,
                cars_flagged=cars,
                min_residual=round(min(res), 4) if res else None,
                mean_residual=round(float(np.mean(res)), 4) if res else None,
                flag_count=len(res),
                first_flag_ts=min(f.ts for f in seg.flags) if seg.flags else None,
                last_flag_ts=max(f.ts for f in seg.flags) if seg.flags else None,
                vision=[v.detection for v in seg.vision],
                narrative=narrative,
            ),
            timestamp=self._clock,
        )
