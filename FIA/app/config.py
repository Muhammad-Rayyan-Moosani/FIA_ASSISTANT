"""Central configuration.

Every tunable is read from an environment variable (prefix ``UMAP_``) so the
service can be re-calibrated per circuit / per series without code changes.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

G = 9.80665  # m/s^2


def _env_float(name: str, default: float) -> float:
    return float(os.getenv(name, default))


def _env_int(name: str, default: int) -> int:
    return int(os.getenv(name, default))


def _env_str(name: str, default: str) -> str:
    return os.getenv(name, default)


@dataclass(frozen=True)
class TelemetryConfig:
    segment_length_m: float = field(default_factory=lambda: _env_float("UMAP_SEGMENT_LENGTH_M", 25.0))
    residual_threshold: float = field(default_factory=lambda: _env_float("UMAP_RESIDUAL_THRESHOLD", 0.75))
    # A flag contributes to a segment's status for this long (seconds of session time).
    flag_window_s: float = field(default_factory=lambda: _env_float("UMAP_FLAG_WINDOW_S", 120.0))
    # Residuals are only meaningful while the car is genuinely braking at speed.
    min_brake_fraction: float = field(default_factory=lambda: _env_float("UMAP_MIN_BRAKE_FRACTION", 0.30))
    min_speed_ms: float = field(default_factory=lambda: _env_float("UMAP_MIN_SPEED_MS", 20.0))
    min_dt_s: float = 0.02
    max_dt_s: float = 1.0
    # Expected deceleration model (m/s^2):
    #   a_exp(v, b) = b * (A0 + A2 * v^2) + D2 * v^2
    # b = brake fraction, v = speed in m/s. Mechanical grip (A0), aero-assisted
    # grip (A2) and aero drag (D2). Defaults approximate an F1 car:
    # ~5 g from 300 km/h, ~2 g from 90 km/h under full braking.
    decel_a0: float = field(default_factory=lambda: _env_float("UMAP_DECEL_A0", 16.7))
    decel_a2: float = field(default_factory=lambda: _env_float("UMAP_DECEL_A2", 0.00324))
    decel_d2: float = field(default_factory=lambda: _env_float("UMAP_DECEL_D2", 0.00145))
    # Radius used to attach vision anomalies to a telemetry segment centroid.
    fusion_radius_m: float = field(default_factory=lambda: _env_float("UMAP_FUSION_RADIUS_M", 25.0))


@dataclass(frozen=True)
class VisionConfig:
    yolo_weights: str = field(default_factory=lambda: _env_str("UMAP_YOLO_WEIGHTS", ""))
    min_confidence: float = field(default_factory=lambda: _env_float("UMAP_VISION_MIN_CONF", 0.35))
    overhead_px_per_m: float = field(default_factory=lambda: _env_float("UMAP_OVERHEAD_PX_PER_M", 4.0))
    max_video_frames: int = field(default_factory=lambda: _env_int("UMAP_MAX_VIDEO_FRAMES", 12))
    max_overhead_px: int = 2048


@dataclass(frozen=True)
class RagConfig:
    index_dir: Path = field(default_factory=lambda: Path(_env_str("UMAP_RAG_INDEX_DIR", "./data/rag_index")))
    embedding_model: str = field(default_factory=lambda: _env_str("UMAP_EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2"))
    # "auto" -> sentence-transformers if installed, else hashing fallback.
    embedding_backend: str = field(default_factory=lambda: _env_str("UMAP_EMBEDDING_BACKEND", "auto"))
    chunk_chars: int = 900
    chunk_overlap: int = 150


@dataclass(frozen=True)
class AudioConfig:
    whisper_model: str = field(default_factory=lambda: _env_str("UMAP_WHISPER_MODEL", "small.en"))
    whisper_device: str = field(default_factory=lambda: _env_str("UMAP_WHISPER_DEVICE", "cpu"))
    whisper_compute_type: str = field(default_factory=lambda: _env_str("UMAP_WHISPER_COMPUTE", "int8"))
    sample_rate: int = 16_000
    # Team radio is band-limited; filtering to the voice band helps Whisper.
    highpass_hz: int = 250
    lowpass_hz: int = 3800


@dataclass(frozen=True)
class Settings:
    app_name: str = "μMap & FIA Assist API"
    version: str = "1.0.0"
    cors_origins: tuple[str, ...] = field(
        default_factory=lambda: tuple(o.strip() for o in _env_str("UMAP_CORS_ORIGINS", "*").split(","))
    )
    telemetry: TelemetryConfig = field(default_factory=TelemetryConfig)
    vision: VisionConfig = field(default_factory=VisionConfig)
    rag: RagConfig = field(default_factory=RagConfig)
    audio: AudioConfig = field(default_factory=AudioConfig)
    data_dir: Path = Path(__file__).parent / "data"


def get_settings() -> Settings:
    return Settings()
