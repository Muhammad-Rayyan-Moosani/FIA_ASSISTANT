"""Race control (FIA) API: real incident replays, marshal masts, steward actions and multimodal severity.

Merged from the separate FIA service (FIA/ folder) into this backend so the unified map talks to one API.
Every replay is real OpenF1 data (data/race_control/*_incidents.json, built by
scripts/build_incident_packs.py); the Hugging Face models run locally (services/multimodal_severity.py).
"""
from __future__ import annotations

import asyncio
import json
from typing import Literal

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from api.insurance import SSE_HEADERS, sse
from services import multimodal_severity as ms
from services import repository
from services.race_control import collision, packs, rulebook
from services.race_control import frame as fr
from services.race_control.session import session

router = APIRouter(prefix="/api/fia", tags=["Race control"])
MAX_UPLOAD = ms.MAX_AUDIO_BYTES
PING_S = 15.0


def _circuit(circuit: str) -> str:
    repository.data_version(circuit)          # raises UnknownCircuit -> 404
    return circuit


def _not_found(code: str, message: str) -> HTTPException:
    return HTTPException(404, {"code": code, "message": message})


# ----------------------------------------------------------------------------- read
@router.get("/{circuit}/marshal-sectors", summary="Real marshal sector (mast) positions on the map")
def marshal_sectors(circuit: str) -> dict:
    _circuit(circuit)
    return {"circuit": circuit, "sectors": fr.marshal_sectors(circuit),
            "source": "MultiViewer circuit API marshal sectors, placed on the OpenF1 reference lap"}


@router.get("/{circuit}/incidents", summary="Real incidents available for replay")
def incidents(circuit: str) -> dict:
    _circuit(circuit)
    data = packs.load(circuit)
    return {"circuit": circuit, "source": data["source"], "built_from": data["built_from"],
            "incidents": packs.summaries(circuit)}


@router.get("/{circuit}/state", summary="Current race-control state (masts, incident, deployment, log)")
def state(circuit: str) -> dict:
    return session(_circuit(circuit)).snapshot()


@router.get("/{circuit}/stream", summary="Server-sent events: cars, masts, incidents, warnings, severity")
async def stream(circuit: str, request: Request) -> StreamingResponse:
    s = session(_circuit(circuit))
    q = s.subscribe()

    async def events():
        try:
            yield sse("snapshot", {"type": "snapshot", "circuit": circuit, "data": s.snapshot()})
            while not await request.is_disconnected():
                try:
                    ev = await asyncio.wait_for(q.get(), PING_S)
                except TimeoutError:
                    yield ": ping\n\n"
                    continue
                yield sse(ev["type"], ev)
        finally:
            s.unsubscribe(q)

    return StreamingResponse(events(), media_type="text/event-stream", headers=SSE_HEADERS)


# ----------------------------------------------------------------------------- replay & actions
class ReplayRequest(BaseModel):
    incident_id: str
    speed: float = Field(1.0, ge=0.25, le=8)
    lead_s: float = Field(15.0, ge=3, le=45, description="Seconds of real telemetry to play before the impact")


class EvaluateRequest(BaseModel):
    marshal_sector: int | None = None
    zone_id: str | None = None
    speed: float = Field(1.0, ge=0.25, le=8)


class DeployRequest(BaseModel):
    action: Literal["sc", "vsc", "red", "clear"]


@router.post("/{circuit}/replay", summary="Replay a real incident through the whole safety loop")
async def replay(circuit: str, body: ReplayRequest) -> dict:
    try:
        return await session(_circuit(circuit)).start_replay(body.incident_id, body.speed, body.lead_s)
    except KeyError:
        raise _not_found("UNKNOWN_INCIDENT", f"No replayable incident {body.incident_id} at {circuit}.") from None


@router.post("/{circuit}/evaluate", summary="Evaluate a sector: replay its most telling real incident")
async def evaluate(circuit: str, body: EvaluateRequest) -> dict:
    """Clicking a marshal mast or a zone on the map: picks the real incident recorded there with the clearest
    telemetry (an impact, then radio), and replays it. 404 when no counted crash from 2023+ happened there."""
    _circuit(circuit)
    cands = [s for s in packs.summaries(circuit)
             if (body.marshal_sector is not None and s["marshal_sector"] == body.marshal_sector)
             or (body.zone_id is not None and s["zone_id"] == body.zone_id)]
    if not cands:
        where = f"marshal sector {body.marshal_sector}" if body.marshal_sector is not None else f"zone {body.zone_id}"
        raise _not_found("NO_INCIDENT_HERE", f"No counted crash with released telemetry (2023+) in {where}.")
    best = min(cands, key=lambda s: (not s["impact"] or s["impact"]["level"] == "slip", s["radio_clips"] == 0,
                                     s["session_type"] != "Race", s["occurred_at"]))
    return await session(circuit).start_replay(best["incident_id"], body.speed)


@router.post("/{circuit}/deploy", summary="Steward action: deploy SC / VSC / red flag, or clear the track")
async def deploy(circuit: str, body: DeployRequest) -> dict:
    return await session(_circuit(circuit)).deploy(body.action)


@router.post("/{circuit}/reset", summary="Stop any replay and clear all race-control state")
async def reset(circuit: str) -> dict:
    s = session(_circuit(circuit))
    await s.reset()
    return s.snapshot()


# ----------------------------------------------------------------------------- analysis endpoints
class TelemetrySeries(BaseModel):
    driver: str = "?"
    t: list[float] = Field(..., min_length=4, description="seconds")
    speed_kph: list[float]
    x_m: list[float]
    y_m: list[float]


class SeverityRequest(BaseModel):
    circuit: str | None = None
    incident_id: str | None = Field(None, description="Use a replay pack's detected impact and its radio clip")
    telemetry: TelemetrySeries | None = None
    audio_url: str | None = Field(None, description="Team-radio clip on livetiming.formula1.com (OpenF1 team_radio)")


def _telemetry_from(body: SeverityRequest) -> tuple[dict | None, str | None]:
    if body.incident_id and body.circuit:
        pack = packs.get(_circuit(body.circuit), body.incident_id)
        imp = packs.primary_impact(pack)
        clip = min(pack.get("radio") or [], key=lambda c: abs(c["offset_s"]), default=None)
        return imp, body.audio_url or (clip["url"] if clip else None)
    if body.telemetry:
        s = body.telemetry
        if not (len(s.t) == len(s.speed_kph) == len(s.x_m) == len(s.y_m)):
            raise HTTPException(422, {"code": "INVALID_REQUEST", "message": "t, speed_kph, x_m and y_m must be the same length."})
        est = collision.estimate(s.driver, s.t, s.speed_kph, s.x_m, s.y_m)
        return (max(est, key=lambda e: e.telemetry_score).to_dict() if est else None), body.audio_url
    return None, body.audio_url


@router.post("/multimodal-severity", summary="Severity from telemetry + driver radio (Hugging Face, local)")
async def multimodal_severity(body: SeverityRequest) -> dict:
    try:
        telemetry, url = _telemetry_from(body)
    except KeyError:
        raise _not_found("UNKNOWN_INCIDENT", f"No replayable incident {body.incident_id}.") from None
    radio = None
    if url:
        try:
            radio = ms.RadioInput(await run_in_threadpool(ms.fetch_radio, url), url)
        except ValueError as exc:
            raise HTTPException(422, {"code": "INVALID_AUDIO", "message": str(exc)}) from exc
    if telemetry is None and radio is None:
        raise HTTPException(422, {"code": "INVALID_REQUEST", "message": "Give telemetry, an incident_id or an audio_url."})
    return await run_in_threadpool(ms.analyse, telemetry, radio)


@router.post("/multimodal-severity/upload", summary="Same, with an uploaded radio clip (mp3 / wav / flac / ogg)")
async def multimodal_severity_upload(audio: UploadFile = File(...), telemetry: str | None = Form(None)) -> dict:
    data = await audio.read()
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, {"code": "TOO_LARGE", "message": "Audio clip is larger than 8 MB."})
    tel = None
    if telemetry:
        try:
            tel = _telemetry_from(SeverityRequest(telemetry=TelemetrySeries(**json.loads(telemetry))))[0]
        except (ValueError, TypeError) as exc:
            raise HTTPException(422, {"code": "INVALID_REQUEST", "message": f"telemetry: {exc}"}) from exc
    return await run_in_threadpool(ms.analyse, tel, ms.RadioInput(data, audio.filename or "upload"))


@router.post("/collision-estimate", summary="Physics collision estimate for one car's telemetry")
def collision_estimate(body: TelemetrySeries) -> dict:
    est = collision.estimate(body.driver, body.t, body.speed_kph, body.x_m, body.y_m)
    return {"driver": body.driver, "estimates": [e.to_dict() for e in est]}


class RuleQuery(BaseModel):
    query: str = Field(..., min_length=3, max_length=500)
    top_k: int = Field(3, ge=1, le=8)


@router.post("/rules/query", summary="FIA Sporting Regulations articles for an incident description")
async def rules_query(body: RuleQuery) -> dict:
    cites = await run_in_threadpool(rulebook.search, body.query, body.top_k, 0.0)
    return {"query": body.query, "citations": cites, "documents": rulebook.get_index().stats()["documents"]}


@router.get("/models", summary="Status of the local models")
def models() -> dict:
    idx = rulebook._INDEX
    return {"multimodal": ms.status(),
            "rulebook": idx.stats() if idx else {"documents": [], "total_chunks": 0, "status": "loads on first use"}}
