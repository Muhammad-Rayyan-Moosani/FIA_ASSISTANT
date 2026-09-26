"""Request/response models for the μMap real-time grip anomaly engine."""
from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field


class Severity(str, Enum):
    NONE = "NONE"
    WATCH = "WATCH"
    ALERT = "ALERT"


class HazardType(str, Enum):
    GRIP_CLIFF = "grip_cliff"
    WATER_SHEEN = "water_sheen"
    OIL_STREAK = "oil_streak"
    DEBRIS = "debris"


class Point2D(BaseModel):
    x: float
    y: float


# --------------------------------------------------------------------------- telemetry
class TelemetrySample(BaseModel):
    """A single car telemetry frame."""

    car_id: str = Field(..., description="Driver number or car identifier.")
    timestamp: float = Field(..., description="Session time in seconds (monotonic per car).")
    speed_kph: float = Field(..., ge=0, le=450)
    throttle: float = Field(..., ge=0, le=100, description="Throttle application, %.")
    brake: float = Field(
        ..., ge=0, le=100,
        description="Brake pressure normalised to 0-100 % of the car's max line pressure.",
    )
    x: float = Field(..., description="Track X position, metres.")
    y: float = Field(..., description="Track Y position, metres.")
    distance_m: float | None = Field(
        None, ge=0,
        description="Lap distance in metres. When present, 25 m segments are indexed along the "
                    "racing line; otherwise a 25 m spatial grid over (x, y) is used.",
    )


class TelemetryBatch(BaseModel):
    samples: list[TelemetrySample] = Field(..., min_length=1)


class ResidualPoint(BaseModel):
    car_id: str
    timestamp: float
    sector_id: str
    x: float
    y: float
    speed_kph: float
    actual_decel_ms2: float
    expected_decel_ms2: float
    residual: float = Field(..., description="ActualDeceleration / ExpectedDeceleration.")
    below_threshold: bool


class EvidenceCard(BaseModel):
    """Everything the race-control UI needs to justify a hazard call."""

    hazard_types: list[HazardType]
    cars_flagged: list[str]
    min_residual: float | None = None
    mean_residual: float | None = None
    flag_count: int = 0
    first_flag_ts: float | None = None
    last_flag_ts: float | None = None
    vision: list["VisionDetection"] = Field(default_factory=list)
    narrative: str


class HazardEvent(BaseModel):
    """Payload broadcast on ``/ws/alerts``."""

    type: Literal["hazard"] = "hazard"
    sector_id: str
    coordinates: Point2D
    severity_level: Severity
    previous_level: Severity
    evidence_card_data: EvidenceCard
    timestamp: float


class TelemetryIngestResponse(BaseModel):
    processed: int
    evaluated: int = Field(..., description="Samples where the car was braking hard enough to score.")
    flagged: int
    residuals: list[ResidualPoint]
    events: list[HazardEvent]


class SegmentState(BaseModel):
    sector_id: str
    severity_level: Severity
    centroid: Point2D
    cars_flagged: list[str]
    vision_detections: int


class SegmentStateResponse(BaseModel):
    segments: list[SegmentState]


# --------------------------------------------------------------------------- vision
class VisionDetection(BaseModel):
    hazard_type: HazardType
    confidence: float = Field(..., ge=0, le=1)
    map_coordinates: Point2D = Field(..., description="Anomaly centroid in track coordinates (m).")
    area_m2: float
    bbox_px: tuple[int, int, int, int] = Field(..., description="x0, y0, x1, y1 in the overhead image.")
    frame_index: int = 0
    detector: str


class VisionCheckResponse(BaseModel):
    frames_analysed: int
    detector: str
    homography: list[list[float]] = Field(..., description="3x3 image-px → track-metre matrix.")
    overhead_size_px: tuple[int, int]
    detections: list[VisionDetection]
    events: list[HazardEvent]


# --------------------------------------------------------------------------- OpenF1 replay
class OpenF1ReplayRequest(BaseModel):
    session_key: int = Field(..., description="OpenF1 session_key, e.g. 9158.")
    driver_numbers: list[int] = Field(..., min_length=1, max_length=20)
    start_iso: str | None = Field(None, description="ISO8601 lower bound on sample date.")
    end_iso: str | None = Field(None, description="ISO8601 upper bound on sample date.")
    position_scale: float = Field(
        0.1, gt=0, description="Multiplier converting OpenF1 x/y units to metres.",
    )


EvidenceCard.model_rebuild()
