"""Application factory for the μMap & FIA Assist backend.

Run with:  uvicorn app.main:app --reload
"""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware

from app.config import Settings, get_settings
from app.routers import demo, fia, insurance, umap
from app.services.alerts import AlertBroadcaster
from app.services import demo_data
from app.services.audio import RadioTranscriber
from app.services.rag import RulebookIndex, ingest_rulebook_dir, pending_rulebooks
from app.services.telemetry import GripAnomalyEngine
from app.services.vision import VisionService

log = logging.getLogger("umap")


async def _ingest_rulebooks(app: FastAPI) -> None:
    """Background start-up task: index any new PDFs in the rulebook folder."""
    try:
        added = await run_in_threadpool(ingest_rulebook_dir, app.state.rulebook, app.state.settings.rag.rulebook_dir)
        if added:
            log.info("indexed rulebooks: %s", added)
        app.state.rulebook_status = "ready"
    except Exception as exc:  # keep serving; the manual upload endpoint still works
        log.exception("rulebook ingestion failed")
        app.state.rulebook_status = f"error: {exc}"


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if app.state.rulebook.load():
            log.info("loaded rulebook index: %s", app.state.rulebook.stats())
        task = None
        if pending_rulebooks(app.state.rulebook, settings.rag.rulebook_dir):
            app.state.rulebook_status = "indexing"
            task = asyncio.create_task(_ingest_rulebooks(app))
        else:
            app.state.rulebook_status = "ready"
        yield
        if task:
            task.cancel()

    app = FastAPI(
        title=settings.app_name,
        version=settings.version,
        description="Real-time grip-anomaly detection, actuarial track-risk modelling and FIA rulebook assistant.",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.state.settings = settings
    app.state.broadcaster = AlertBroadcaster()
    app.state.engine = GripAnomalyEngine(settings.telemetry)
    app.state.vision = VisionService(settings.vision)
    app.state.rulebook = RulebookIndex(settings.rag)
    app.state.rulebook_status = "starting"
    app.state.transcriber = RadioTranscriber(settings.audio)

    app.include_router(umap.router)
    app.include_router(umap.ws_router)
    app.include_router(insurance.router, prefix="/api/v1/insurance")
    # Alias matching the frontend contract (/api/insurance/risk-map, /api/insurance/what-if).
    app.include_router(insurance.router, prefix="/api/insurance", include_in_schema=False)
    app.include_router(fia.router)
    if settings.demo_endpoints:
        app.include_router(demo.router)
        app.state.locate = demo_data.locate  # name demo-track places ("Turn 1") in plain alerts

    @app.get("/health", tags=["Meta"])
    async def health() -> dict:
        return {
            "status": "ok",
            "version": settings.version,
            "websocket_clients": app.state.broadcaster.client_count,
            "vision_detector": app.state.vision.detector.name,
            "rulebook": {**app.state.rulebook.stats(), "status": app.state.rulebook_status},
        }

    return app


app = create_app()
