"""Track-surface anomaly detection on homography-flattened camera frames.

Pipeline per frame:
  1. decode frame (image via Pillow, video via OpenCV)
  2. warp to a north-up overhead map with the camera homography
  3. segment anomalies with YOLOv8-seg (if ``UMAP_YOLO_WEIGHTS`` is set) or the
     built-in photometric detector
  4. project each anomaly centroid back to track metres

The detector is behind a small ``Detector`` protocol so a PatchCore / anomalib
model can be dropped in with the same interface.
"""
from __future__ import annotations

import io
import logging
import os
import tempfile
from dataclasses import dataclass
from typing import Protocol

import numpy as np
from scipy import ndimage

from app.config import VisionConfig
from app.schemas.umap import HazardType, Point2D, VisionDetection
from app.services.homography import apply_homography, compute_homography, overhead_transform, warp_perspective

log = logging.getLogger(__name__)

try:  # pragma: no cover
    import cv2
except ImportError:  # pragma: no cover
    cv2 = None


@dataclass
class RawDetection:
    hazard_type: HazardType
    confidence: float
    centroid_px: tuple[float, float]
    area_px: float
    bbox_px: tuple[int, int, int, int]


class Detector(Protocol):
    name: str

    def detect(self, rgb: np.ndarray, valid: np.ndarray) -> list[RawDetection]: ...


# --------------------------------------------------------------------------- detectors
class PhotometricDetector:
    """Colour/brightness anomaly detector relative to the local asphalt baseline.

    * water sheen  -> specular, bright, desaturated patches
    * oil streak   -> patches markedly darker than the surrounding asphalt
    * debris       -> strongly saturated objects (bodywork, carbon, gravel, cones)
    """

    name = "photometric-baseline"

    def __init__(self, min_area_frac: float = 0.0015) -> None:
        self.min_area_frac = min_area_frac

    def detect(self, rgb: np.ndarray, valid: np.ndarray) -> list[RawDetection]:
        from PIL import Image

        n_valid = int(valid.sum())
        if n_valid < 100:
            return []
        hsv = np.asarray(Image.fromarray(rgb).convert("HSV"), dtype=np.float32) / 255.0
        s, v = hsv[..., 1], hsv[..., 2]
        med_v = float(np.median(v[valid]))
        med_s = float(np.median(s[valid]))

        masks = {
            HazardType.WATER_SHEEN: (v > max(0.8, med_v + 0.3)) & (s < 0.25),
            HazardType.OIL_STREAK: (v < med_v * 0.55) & (s < 0.35),
            HazardType.DEBRIS: s > max(0.45, med_s + 0.3),
        }
        min_area = max(20, int(self.min_area_frac * n_valid))
        struct = np.ones((3, 3), bool)
        out: list[RawDetection] = []
        for hazard, mask in masks.items():
            mask = ndimage.binary_opening(mask & valid, structure=struct)
            labels, n = ndimage.label(mask)
            if n == 0:
                continue
            idx = np.arange(1, n + 1)
            areas = ndimage.sum_labels(mask, labels, idx)
            centroids = ndimage.center_of_mass(mask, labels, idx)
            mean_v = ndimage.mean(v, labels, idx)
            mean_s = ndimage.mean(s, labels, idx)
            slices = ndimage.find_objects(labels)
            for k in np.flatnonzero(areas >= min_area):
                if hazard is HazardType.DEBRIS:
                    contrast = (mean_s[k] - med_s) / 0.5
                else:
                    contrast = abs(mean_v[k] - med_v) / 0.5
                size = min(1.0, areas[k] / (0.01 * n_valid))
                conf = float(np.clip(0.25 + 0.75 * min(1.0, contrast) * np.sqrt(size), 0, 1))
                sl = slices[k]
                cy, cx = centroids[k]
                out.append(RawDetection(
                    hazard, conf, (float(cx), float(cy)), float(areas[k]),
                    (sl[1].start, sl[0].start, sl[1].stop, sl[0].stop),
                ))
        return out


class YoloSegDetector:  # pragma: no cover - requires ultralytics + trained weights
    """YOLOv8-seg model fine-tuned on track-surface hazard classes."""

    name = "yolov8-seg"

    def __init__(self, weights: str) -> None:
        from ultralytics import YOLO

        self.model = YOLO(weights)

    @staticmethod
    def _map_label(label: str) -> HazardType:
        label = label.lower()
        if "water" in label or "wet" in label or "puddle" in label:
            return HazardType.WATER_SHEEN
        if "oil" in label or "fluid" in label:
            return HazardType.OIL_STREAK
        return HazardType.DEBRIS

    def detect(self, rgb: np.ndarray, valid: np.ndarray) -> list[RawDetection]:
        res = self.model.predict(rgb[..., ::-1], verbose=False)[0]  # ultralytics expects BGR ndarray
        out: list[RawDetection] = []
        if res.boxes is None:
            return out
        names = res.names
        polys = res.masks.xy if res.masks is not None else [None] * len(res.boxes)
        for box, poly in zip(res.boxes, polys):
            x0, y0, x1, y1 = box.xyxy[0].tolist()
            if poly is not None and len(poly) >= 3:
                cx, cy = poly.mean(axis=0).tolist()
                px, py = poly[:, 0], poly[:, 1]
                area = 0.5 * abs(np.dot(px, np.roll(py, 1)) - np.dot(py, np.roll(px, 1)))
            else:
                cx, cy, area = (x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) * (y1 - y0)
            ix, iy = int(np.clip(cx, 0, valid.shape[1] - 1)), int(np.clip(cy, 0, valid.shape[0] - 1))
            if not valid[iy, ix]:
                continue
            out.append(RawDetection(
                self._map_label(names[int(box.cls)]), float(box.conf), (cx, cy), float(area),
                (int(x0), int(y0), int(x1), int(y1)),
            ))
        return out


def build_detector(cfg: VisionConfig) -> Detector:
    if cfg.yolo_weights:
        try:
            return YoloSegDetector(cfg.yolo_weights)
        except Exception as exc:  # pragma: no cover
            log.warning("YOLOv8-seg unavailable (%s); using photometric detector", exc)
    return PhotometricDetector()


# --------------------------------------------------------------------------- decoding
VIDEO_TYPES = {"video/mp4", "video/quicktime", "video/x-msvideo", "video/webm", "video/x-matroska"}


def decode_frames(data: bytes, content_type: str | None, filename: str | None, max_frames: int) -> list[np.ndarray]:
    """Return RGB uint8 frames. Images -> 1 frame, videos -> up to ``max_frames`` evenly spaced."""
    is_video = (content_type in VIDEO_TYPES) or (filename or "").lower().endswith((".mp4", ".mov", ".avi", ".webm", ".mkv"))
    if not is_video:
        from PIL import Image, UnidentifiedImageError

        try:
            return [np.asarray(Image.open(io.BytesIO(data)).convert("RGB"))]
        except UnidentifiedImageError as exc:
            raise ValueError("could not decode image") from exc
    if cv2 is None:
        raise RuntimeError("video input requires opencv-python")
    suffix = os.path.splitext(filename or "clip.mp4")[1] or ".mp4"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as fh:
        fh.write(data)
        path = fh.name
    try:
        cap = cv2.VideoCapture(path)
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or max_frames
        wanted = set(np.linspace(0, max(total - 1, 0), num=min(max_frames, total)).astype(int).tolist())
        frames, i = [], 0
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if i in wanted:
                frames.append(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
            i += 1
        cap.release()
    finally:
        os.unlink(path)
    if not frames:
        raise ValueError("could not decode any video frames")
    return frames


# --------------------------------------------------------------------------- service
@dataclass
class VisionResult:
    detections: list[VisionDetection]
    homography: np.ndarray
    overhead_size: tuple[int, int]
    frames: int
    detector: str


class VisionService:
    def __init__(self, cfg: VisionConfig, detector: Detector | None = None) -> None:
        self.cfg = cfg
        self.detector = detector or build_detector(cfg)

    def analyse(self, frames: list[np.ndarray], src_pts: np.ndarray, dst_pts: np.ndarray) -> VisionResult:
        H = compute_homography(src_pts, dst_pts)
        H_ov, S, size = overhead_transform(H, dst_pts, self.cfg.overhead_px_per_m, self.cfg.max_overhead_px)
        S_inv = np.linalg.inv(S)
        px_per_m = S[0, 0]

        detections: list[VisionDetection] = []
        for fi, frame in enumerate(frames):
            overhead, valid = warp_perspective(frame, H_ov, size)
            for raw in self.detector.detect(overhead, valid):
                if raw.confidence < self.cfg.min_confidence:
                    continue
                mx, my = apply_homography(S_inv, np.array([raw.centroid_px]))[0]
                detections.append(VisionDetection(
                    hazard_type=raw.hazard_type,
                    confidence=round(raw.confidence, 3),
                    map_coordinates=Point2D(x=round(float(mx), 2), y=round(float(my), 2)),
                    area_m2=round(raw.area_px / px_per_m**2, 2),
                    bbox_px=raw.bbox_px,
                    frame_index=fi,
                    detector=self.detector.name,
                ))
        return VisionResult(detections, H, size, len(frames), self.detector.name)
