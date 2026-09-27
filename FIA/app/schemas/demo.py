"""Models for the demo-only endpoints (synthetic data; disable with UMAP_DEMO_ENDPOINTS=0)."""
from __future__ import annotations

from pydantic import BaseModel, Field

from app.schemas.umap import HazardEvent, HazardType, TelemetryIngestResponse, VisionDetection


class CameraBox(BaseModel):
    hazard_type: HazardType
    confidence: float
    polygon_px: list[tuple[float, float]] = Field(
        ..., description="Overhead bbox projected back into the camera frame (4 corners).",
    )


class DemoVisionResponse(BaseModel):
    mock_input: bool = Field(True, description="Frame is synthetic; the homography + detector run for real.")
    detector: str
    camera_size_px: tuple[int, int]
    overhead_size_px: tuple[int, int]
    src_points_px: list[list[float]]
    dst_points_m: list[list[float]]
    homography: list[list[float]]
    detections: list[VisionDetection]
    camera_boxes: list[CameraBox]
    events: list[HazardEvent]
    camera_png_b64: str | None = None
    overhead_png_b64: str | None = None


class DemoResetResponse(BaseModel):
    engine_reset: bool
    rulebook_document: str
    rulebook_chunks: int
    real_regulations: bool = Field(..., description="True when an ingested FIA PDF is being used.")


class DemoRunStatus(BaseModel):
    running: bool
    cars: list[str]
    speedup: float


class DemoTelemetryResponse(TelemetryIngestResponse):
    positions_broadcast: int
