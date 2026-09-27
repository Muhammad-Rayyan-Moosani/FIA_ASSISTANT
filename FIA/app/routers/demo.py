"""Demo-only routes: live dashboard, scripted Monza T1 scenario, mock vision & radio.

Everything here runs the *real* engines (telemetry residuals, homography,
detector, Monte Carlo, RAG) on synthetic inputs from ``app.services.demo_data``.
Mounted only when ``UMAP_DEMO_ENDPOINTS`` is on (default).
"""
from __future__ import annotations

import asyncio
import base64
import io
from pathlib import Path

import numpy as np
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import HTMLResponse

from app.routers.fia import transcript_citations
from app.routers.umap import ingest_and_publish, publish_events
from app.schemas.demo import CameraBox, DemoResetResponse, DemoRunStatus, DemoTelemetryResponse, DemoVisionResponse
from app.schemas.fia import TranscriptionResponse, TranscriptSegment
from app.schemas.umap import TelemetryBatch, TelemetrySample
from app.services import demo_data as demo
from app.services.plain_alerts import crash_payload, plain_alert
from app.services.homography import apply_homography, overhead_transform, warp_perspective

router = APIRouter(tags=["Demo (synthetic data)"])

STATIC = Path(__file__).resolve().parent.parent / "static"
BOX_COLORS = {"water_sheen": (0, 220, 255), "oil_streak": (255, 0, 200), "debris": (255, 150, 0), "grip_cliff": (255, 60, 60)}


# --------------------------------------------------------------------------- dashboard
@router.get("/demo", response_class=HTMLResponse, include_in_schema=False)
async def dashboard() -> HTMLResponse:
    return HTMLResponse((STATIC / "demo.html").read_text(encoding="utf-8"))


@router.get("/api/v1/demo/scenario", summary="Track geometry, cars and zones for the demo UI")
async def scenario(request: Request) -> dict:
    cl = demo.CENTERLINE[::5]
    oil = [demo.position_at(s) for s in demo.OIL_ZONE]
    return {
        "track": demo.TRACK_NAME,
        "segment_length_m": request.app.state.settings.telemetry.segment_length_m,
        "residual_threshold": request.app.state.settings.telemetry.residual_threshold,
        "track_half_width_m": demo.TRACK_HALF_WIDTH,
        "centerline": [[round(float(x), 2), round(float(y), 2)] for _, x, y in cl],
        "brake_point": demo.position_at(demo.BRAKE_POINT_S),
        "oil_zone": {"from": oil[0], "to": oil[1], "grip": demo.LOW_GRIP},
        "camera_quad_m": demo.CAM_DST_M.tolist(),
        "cars": [{"car_id": c, "note": n} for c, _, _, _, n in demo.CARS],
        "zones": demo.MONZA_ZONES,
        "what_if": demo.WHAT_IF,
        "rulebook": _real_rulebooks(request.app) or [demo.DEMO_RULEBOOK_NAME],
        "sample_queries": demo.REAL_REGS_QUERIES if _real_rulebooks(request.app) else demo.SAMPLE_QUERIES,
    }


def _real_rulebooks(app) -> list[str]:
    return [d for d in app.state.rulebook.stats()["documents"] if d != demo.DEMO_RULEBOOK_NAME]


@router.post("/api/v1/demo/reset", response_model=DemoResetResponse, summary="Clear μMap state and prepare the rulebook")
async def reset(request: Request) -> DemoResetResponse:
    """Clears μMap state. If real regulations are indexed (e.g. from data/rulebooks/) they are
    used as-is; otherwise the synthetic demo rulebook is loaded in memory (never saved to disk)."""
    task = getattr(request.app.state, "demo_task", None)
    if task and not task.done():
        task.cancel()
    request.app.state.engine.reset()
    rb = request.app.state.rulebook
    real = _real_rulebooks(request.app)
    if real or getattr(request.app.state, "rulebook_status", "") == "indexing":
        if demo.DEMO_RULEBOOK_NAME in rb.stats()["documents"]:
            await run_in_threadpool(rb.remove_document, demo.DEMO_RULEBOOK_NAME)
        doc, n = ", ".join(real) or "indexing…", rb.stats()["total_chunks"]
    else:
        n = await run_in_threadpool(rb.add_document, demo.DEMO_RULEBOOK_NAME, demo.DEMO_RULEBOOK.split("\f"))
        doc = demo.DEMO_RULEBOOK_NAME
    await request.app.state.broadcaster.broadcast({"type": "demo_reset"})
    return DemoResetResponse(engine_reset=True, rulebook_document=doc, rulebook_chunks=n, real_regulations=bool(real))


# --------------------------------------------------------------------------- telemetry
async def _ingest_with_positions(app, samples: list[TelemetrySample]) -> DemoTelemetryResponse:
    """Real ingest + broadcast of car positions so the dashboard can animate the cars."""
    resp = await ingest_and_publish(app, samples)
    by_key = {(r.car_id, r.timestamp): r for r in resp.residuals}
    for s in samples:
        r = by_key.get((s.car_id, s.timestamp))
        await app.state.broadcaster.broadcast({
            "type": "car_position", "car_id": s.car_id, "timestamp": s.timestamp,
            "x": s.x, "y": s.y, "speed_kph": s.speed_kph, "brake": s.brake, "throttle": s.throttle,
            "residual": r.residual if r else None, "below_threshold": bool(r and r.below_threshold),
        })
    return DemoTelemetryResponse(**resp.model_dump(), positions_broadcast=len(samples))


@router.post("/api/v1/demo/telemetry", response_model=DemoTelemetryResponse,
             summary="Same as /umap/telemetry, plus car-position frames on /ws/alerts for the demo map")
async def demo_telemetry(batch: TelemetryBatch, request: Request) -> DemoTelemetryResponse:
    return await _ingest_with_positions(request.app, batch.samples)


async def _run_scenario(app, speedup: float) -> None:
    bc = app.state.broadcaster
    for car_id, note, run in demo.scenario_runs():
        await bc.broadcast({"type": "demo_narration", "text": f"Car {car_id}: {note}"})
        for s in run:
            await _ingest_with_positions(app, [TelemetrySample(**s)])
            await asyncio.sleep(demo.DT / speedup)
        await asyncio.sleep(1.5 / speedup)
    await bc.broadcast({"type": "demo_narration", "text": "Trajectory scenario complete."})


@router.post("/api/v1/demo/run-trajectory", response_model=DemoRunStatus,
             summary="Stream the Monza T1 scenario server-side in real time")
async def run_trajectory(request: Request, speedup: float = Query(1.0, ge=0.25, le=20)) -> DemoRunStatus:
    task = getattr(request.app.state, "demo_task", None)
    if task and not task.done():
        raise HTTPException(409, "scenario already running")
    request.app.state.engine.reset()
    await request.app.state.broadcaster.broadcast({"type": "demo_reset"})
    request.app.state.demo_task = asyncio.create_task(_run_scenario(request.app, speedup))
    return DemoRunStatus(running=True, cars=[c[0] for c in demo.CARS], speedup=speedup)


@router.post("/api/v1/demo/crash", summary="Broadcast a simulated crash in the OpenF1 impact-detector format")
async def simulate_crash(request: Request) -> dict:
    """Car 2 loses it on the oil and hits the barrier at the chicane. The event mirrors
    ``backend/openf1_extract.detect_impacts`` output, wrapped with ``crash_payload``."""
    event = demo.CRASH_EVENT
    x, y = demo.position_at(demo.CRASH_S, lateral=-7.0)
    payload = crash_payload({**event, "coordinates": {"x": round(x, 1), "y": round(y, 1)}}, demo.locate({"x": x, "y": y}))
    message = {**payload, "plain": plain_alert(payload)}
    await request.app.state.broadcaster.broadcast(message)
    return message


# --------------------------------------------------------------------------- vision
def _png_b64(img: np.ndarray) -> str:
    from PIL import Image

    buf = io.BytesIO()
    Image.fromarray(img).save(buf, format="PNG", optimize=True)
    return base64.b64encode(buf.getvalue()).decode()


def _demo_vision(vision, include_images: bool):
    from PIL import Image, ImageDraw

    frame = demo.render_camera_frame()
    src, dst = demo.CAM_SRC_PX, demo.CAM_DST_M
    result = vision.analyse([frame], src, dst)
    H_ov, S, size = overhead_transform(result.homography, dst, vision.cfg.overhead_px_per_m, vision.cfg.max_overhead_px)
    S_inv = np.linalg.inv(S)

    boxes = []
    for d in result.detections:
        x0, y0, x1, y1 = d.bbox_px
        corners_m = apply_homography(S_inv, np.array([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], float))
        poly = demo.camera_polygon_from_metres(corners_m)
        boxes.append(CameraBox(hazard_type=d.hazard_type, confidence=d.confidence,
                               polygon_px=[(round(float(x), 1), round(float(y), 1)) for x, y in poly]))

    cam_png = ov_png = None
    if include_images:
        from PIL import ImageFont

        try:
            font = ImageFont.load_default(size=18)
        except TypeError:  # Pillow < 10.1
            font = ImageFont.load_default()
        cam = Image.fromarray(frame)
        draw = ImageDraw.Draw(cam)
        draw.polygon([tuple(p) for p in src.tolist()], outline=(255, 255, 255), width=2)
        for b in boxes:
            col = BOX_COLORS[b.hazard_type.value]
            draw.polygon(b.polygon_px, outline=col, width=4)
            xs, ys = zip(*b.polygon_px)
            label = f"{b.hazard_type.value.replace('_', ' ')} {b.confidence:.2f}"
            x0, y0, x1, y1 = draw.textbbox((max(xs) + 8, min(ys)), label, font=font)
            draw.rectangle((x0 - 4, y0 - 3, x1 + 4, y1 + 3), fill=(0, 0, 0))
            draw.text((max(xs) + 8, min(ys)), label, fill=col, font=font)
        overhead, _ = warp_perspective(frame, H_ov, size)
        ov = Image.fromarray(overhead)
        od = ImageDraw.Draw(ov)
        for d in result.detections:
            od.rectangle(d.bbox_px, outline=BOX_COLORS[d.hazard_type.value], width=2)
        cam_png, ov_png = _png_b64(np.asarray(cam)), _png_b64(np.asarray(ov))
    return result, boxes, cam_png, ov_png


@router.post("/api/v1/umap/demo-vision", response_model=DemoVisionResponse,
             summary="Mock marshal-camera frame → homography → segmentation → bounding boxes")
async def demo_vision(
    request: Request,
    include_images: bool = Query(True, description="Return annotated camera + overhead PNGs (base64)."),
    fuse: bool = Query(True, description="Feed detections into μMap and broadcast alerts."),
) -> DemoVisionResponse:
    result, boxes, cam_png, ov_png = await run_in_threadpool(_demo_vision, request.app.state.vision, include_images)
    events = []
    if fuse and result.detections:
        events = await run_in_threadpool(request.app.state.engine.register_vision, result.detections)
        await publish_events(request.app, events)
    await request.app.state.broadcaster.broadcast({
        "type": "vision_detections",
        "detections": [d.model_dump(mode="json") for d in result.detections],
    })
    return DemoVisionResponse(
        detector=result.detector,
        camera_size_px=demo.CAM_SIZE,
        overhead_size_px=result.overhead_size,
        src_points_px=demo.CAM_SRC_PX.tolist(),
        dst_points_m=demo.CAM_DST_M.tolist(),
        homography=np.round(result.homography, 8).tolist(),
        detections=result.detections,
        camera_boxes=boxes,
        events=events,
        camera_png_b64=cam_png,
        overhead_png_b64=ov_png,
    )


# --------------------------------------------------------------------------- radio
@router.post("/api/v1/fia-assistant/demo-transcribe", response_model=TranscriptionResponse,
             summary="Mock faster-whisper output for a sample team-radio clip, matched to rules")
async def demo_transcribe(request: Request, match_rules: bool = Query(True), top_k: int = Query(2, ge=1, le=5)) -> TranscriptionResponse:
    """Returns a canned transcript in the exact shape `/transcribe-radio` produces with faster-whisper,
    then runs the real rulebook retrieval on it."""
    fx = demo.RADIO_FIXTURE
    related = []
    index = request.app.state.rulebook
    if match_rules and index.chunks:
        related = await run_in_threadpool(transcript_citations, index, [s["text"] for s in fx.segments], top_k)
    return TranscriptionResponse(
        text=fx.text, language="en", duration_s=fx.duration_s,
        segments=[TranscriptSegment(**s) for s in fx.segments],
        model="mock-fixture (shape of faster-whisper:small.en output)",
        related_rules=related,
    )
