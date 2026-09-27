"""μMap real-time grip anomaly routes (``/api/v1/umap``) and the ``/ws/alerts`` stream."""
from __future__ import annotations

import json

import httpx
import numpy as np
from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool

from app.schemas.umap import (
    HazardEvent,
    OpenF1ReplayRequest,
    SegmentStateResponse,
    TelemetryBatch,
    TelemetryIngestResponse,
    VisionCheckResponse,
)
from app.services import openf1
from app.services.plain_alerts import plain_alert
from app.services.vision import decode_frames

router = APIRouter(prefix="/api/v1/umap", tags=["μMap"])
ws_router = APIRouter(tags=["μMap"])


def hazard_message(app, payload: dict) -> dict:
    """Feed payload + a plain-language ``plain`` block for race control.

    ``app.state.locate`` (optional) turns coordinates into a place name such as "Turn 1".
    """
    locate = getattr(app.state, "locate", None)
    where = locate(payload.get("coordinates") or {}) if locate else None
    return {**payload, "plain": plain_alert(payload, where)}


async def publish_events(app, events: list[HazardEvent]) -> None:
    for ev in events:
        await app.state.broadcaster.broadcast(hazard_message(app, ev.model_dump(mode="json")))


async def _publish(request_or_ws, events: list[HazardEvent]) -> None:
    await publish_events(request_or_ws.app, events)


async def ingest_and_publish(app, samples) -> TelemetryIngestResponse:
    """Score samples on the app's engine and broadcast resulting level changes."""
    residuals, events, evaluated = await run_in_threadpool(app.state.engine.ingest, samples)
    await publish_events(app, events)
    return TelemetryIngestResponse(
        processed=len(samples),
        evaluated=evaluated,
        flagged=sum(r.below_threshold for r in residuals),
        residuals=residuals,
        events=events,
    )


async def _ingest(request: Request, batch: TelemetryBatch) -> TelemetryIngestResponse:
    return await ingest_and_publish(request.app, batch.samples)


@router.post("/telemetry", response_model=TelemetryIngestResponse, summary="Ingest a telemetry batch")
async def ingest_telemetry(batch: TelemetryBatch, request: Request) -> TelemetryIngestResponse:
    """Compute deceleration residuals, update 25 m segment states and broadcast any WATCH/ALERT changes."""
    return await _ingest(request, batch)


@router.post("/replay/openf1", response_model=TelemetryIngestResponse, summary="Replay an OpenF1 session window")
async def replay_openf1(body: OpenF1ReplayRequest, request: Request) -> TelemetryIngestResponse:
    try:
        samples = await openf1.fetch_samples(
            body.session_key, body.driver_numbers, body.start_iso, body.end_iso, body.position_scale
        )
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"OpenF1 request failed: {exc}") from exc
    if not samples:
        raise HTTPException(404, "OpenF1 returned no telemetry for that window")
    return await _ingest(request, TelemetryBatch(samples=samples))


@router.get("/segments", response_model=SegmentStateResponse, summary="Current non-green segments")
async def segments(request: Request) -> SegmentStateResponse:
    return SegmentStateResponse(segments=request.app.state.engine.snapshot())


@router.post("/reset", status_code=204, summary="Clear all segment state (new session)")
async def reset(request: Request) -> None:
    request.app.state.engine.reset()


def _parse_points(raw: str, name: str) -> np.ndarray:
    try:
        pts = np.asarray(json.loads(raw), dtype=float)
    except (ValueError, TypeError) as exc:
        raise HTTPException(422, f"{name} must be a JSON list of [x, y] pairs") from exc
    if pts.ndim != 2 or pts.shape[1] != 2 or len(pts) < 4:
        raise HTTPException(422, f"{name} needs at least 4 [x, y] pairs")
    return pts


@router.post("/vision-check", response_model=VisionCheckResponse, summary="Detect surface hazards in a camera frame/clip")
async def vision_check(
    request: Request,
    file: UploadFile = File(..., description="JPEG/PNG frame or short MP4/MOV clip."),
    src_points: str = Form(..., description='Image pixel points, e.g. [[102,540],[1810,560],[1300,300],[640,295]].'),
    dst_points: str = Form(..., description="Matching track-map points in metres, same order."),
    fuse: bool = Form(True, description="Feed detections into the μMap engine and broadcast alerts."),
) -> VisionCheckResponse:
    """Flatten the camera view with a homography, segment water/oil/debris, and fuse with telemetry."""
    src = _parse_points(src_points, "src_points")
    dst = _parse_points(dst_points, "dst_points")
    if len(src) != len(dst):
        raise HTTPException(422, "src_points and dst_points must have the same length")
    data = await file.read()
    vision = request.app.state.vision
    try:
        frames = await run_in_threadpool(
            decode_frames, data, file.content_type, file.filename, vision.cfg.max_video_frames
        )
        result = await run_in_threadpool(vision.analyse, frames, src, dst)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(415, str(exc)) from exc

    events: list[HazardEvent] = []
    if fuse and result.detections:
        events = await run_in_threadpool(request.app.state.engine.register_vision, result.detections)
        await _publish(request, events)
    return VisionCheckResponse(
        frames_analysed=result.frames,
        detector=result.detector,
        homography=np.round(result.homography, 8).tolist(),
        overhead_size_px=result.overhead_size,
        detections=result.detections,
        events=events,
    )


@ws_router.websocket("/ws/alerts")
async def alerts_ws(ws: WebSocket) -> None:
    """Push stream of ``HazardEvent`` JSON. On connect the client receives a snapshot of active segments."""
    broadcaster = ws.app.state.broadcaster
    await broadcaster.connect(ws)
    try:
        snapshot = ws.app.state.engine.snapshot()
        await ws.send_json({"type": "snapshot", "segments": [s.model_dump(mode="json") for s in snapshot]})
        while True:  # keep-alive; clients may send "ping"
            msg = await ws.receive_text()
            if msg == "ping":
                await ws.send_json({"type": "pong"})
    except WebSocketDisconnect:
        pass
    finally:
        await broadcaster.disconnect(ws)
