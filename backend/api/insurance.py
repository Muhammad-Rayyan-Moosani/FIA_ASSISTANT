"""R3 · Insurance API routes (ARCHITECTURE.md §7). Monza only; every response is validated against api/schemas.py."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from pydantic import TypeAdapter, ValidationError

from api import schemas as s
from config.settings import settings
from services import actuarial, ingest_jobs, report, repository

router = APIRouter(prefix="/api/insurance", tags=["insurance"])

_upgrades_adapter = TypeAdapter(dict[str, s.ZoneChanges])
MAX_STREAM_SEASONS = 200


def parse_upgrades(raw: str | None) -> dict[str, dict]:
    """`upgrades` query parameter: compact JSON keyed by zone_id (see frontend/src/lib/upgrades.ts)."""
    if not raw:
        return {}
    try:
        parsed = _upgrades_adapter.validate_json(raw)
    except ValidationError as exc:
        raise HTTPException(422, detail={"code": "INVALID_UPGRADES", "message": "The upgrades parameter is not valid.",
                                         "detail": {"errors": json.loads(exc.json())}}) from exc
    return {z: c.model_dump(exclude_none=True) for z, c in parsed.items()}


def sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"


SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


# ----------------------------------------------------------------------------- Step 1 · data
@router.get("/circuits", response_model=list[s.CircuitSummary])
def list_circuits() -> list[dict]:
    return [repository.circuit_summary(c) for c in repository.SUPPORTED_CIRCUITS]


@router.get("/tracks/{circuit}", response_model=s.TrackGeometry)
def get_track(circuit: str) -> dict:
    return repository.track_geometry(circuit)


@router.get("/incidents", response_model=list[s.Incident])
def list_incidents(circuit: str, zone_id: str | None = None, season: int | None = None) -> list[dict]:
    return repository.incidents(circuit, zone_id, season)


@router.post("/incidents/ingest", response_model=s.IngestJob, status_code=202)
def start_ingestion(body: s.IngestRequest) -> dict:
    repository.data_version(body.circuit)            # 404 for circuits out of scope
    job = ingest_jobs.start(body.circuit, refresh=body.refresh)
    return {"job_id": job.job_id, "circuit": job.circuit, "status": job.status, "created_at": job.created_at}


@router.get("/incidents/ingest/{job_id}/stream")
async def stream_ingestion(job_id: str) -> StreamingResponse:
    job = ingest_jobs.get(job_id)
    if not job:
        raise HTTPException(404, detail={"code": "UNKNOWN_JOB", "message": f"No ingestion job {job_id}."})

    async def events() -> AsyncIterator[str]:
        sent = 0
        while True:
            batch = job.since(sent)
            for event, data in batch:
                yield sse(event, data)
            sent += len(batch)
            if job.finished and sent == len(job.since(0)):
                return
            await asyncio.sleep(0.1)

    return StreamingResponse(events(), media_type="text/event-stream", headers=SSE_HEADERS)


# ----------------------------------------------------------------------------- Step 3 · insurance
@router.get("/risk-map", response_model=s.RiskMap)
def get_risk_map(circuit: str, series: s.Series = "f1", upgrades: str | None = None) -> dict:
    return actuarial.risk_map(circuit, series, parse_upgrades(upgrades))


@router.post("/what-if", response_model=s.WhatIfResponse)
def post_what_if(body: s.WhatIfRequest) -> dict:
    upgrades = {z: c.model_dump(exclude_none=True) for z, c in body.upgrades.items()}
    return actuarial.what_if(body.circuit, body.series, body.zone_id, body.changes.model_dump(exclude_none=True), upgrades)


@router.get("/simulate/stream")
async def stream_simulation(circuit: str, series: s.Series = "f1",
                            seasons: int = Query(40, ge=1, le=MAX_STREAM_SEASONS),
                            upgrades: str | None = None) -> StreamingResponse:
    ups = parse_upgrades(upgrades)
    sim = await run_in_threadpool(actuarial.simulation_events, circuit, series, ups, seasons)

    async def events() -> AsyncIterator[str]:
        by_season: dict[int, list[dict]] = {}
        for c in sim["crashes"]:
            by_season.setdefault(c["season"], []).append(c)
        for k in range(seasons):
            yield sse("season_start", {"season": k})
            for c in by_season.get(k, []):
                yield sse("crash", c)
            yield sse("progress", {"seasons_done": round((k + 1) / seasons * actuarial.N_SEASONS),
                                   "seasons_total": actuarial.N_SEASONS, "running_eal_eur": sim["running_eal"][k],
                                   "se_eur": sim["se"]})
            if settings.sim_stream_delay_s:
                await asyncio.sleep(settings.sim_stream_delay_s)
        yield sse("done", {"n_seasons": actuarial.N_SEASONS, "eal_eur": sim["eal"], "var99_eur": sim["var99"]})

    return StreamingResponse(events(), media_type="text/event-stream", headers=SSE_HEADERS)


@router.get("/report/export", response_model=s.UnderwriterReport,
            responses={200: {"content": {"application/pdf": {}}}})
def export_report(circuit: str, series: s.Series = "f1", upgrades: str | None = None,
                  format: Literal["json", "pdf"] = "json"):  # noqa: A002 - matches the query parameter name
    data = report.build(circuit, series, parse_upgrades(upgrades))
    if format == "json":
        return data
    track = repository.track_geometry(circuit)
    names = {z["zone_id"]: z["name"] for z in track["zones"]}
    return Response(report.pdf(data, track["name"], names), media_type="application/pdf",
                    headers={"Content-Disposition": f'attachment; filename="underwriter-report-{circuit}-{series}.pdf"'})
