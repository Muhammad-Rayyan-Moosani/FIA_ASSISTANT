"""FIA Assistant API: insurance risk (Step 3) and race control (the FIA safety loop), one service.

    cd backend && uvicorn main:app --reload --port 8000      # docs: http://localhost:8000/docs
"""

from __future__ import annotations

import threading
import warnings
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from api.insurance import router as insurance_router
from api.race_control import router as race_control_router
from config.settings import settings
from services import repository
from services.actuarial import UnknownZone

# The Step 2 model warns when it drops incidents without a zone; the API reports coverage instead.
warnings.filterwarnings("ignore", module="insurance_model")

def _warm_up() -> None:
    """Load the rulebook index and the Hugging Face models in the background so the first incident is quick."""
    from services import multimodal_severity
    from services.race_control import rulebook
    try:
        rulebook.get_index()
        multimodal_severity.MODELS.load()
    except Exception:  # a missing optional dependency only disables that feature
        pass


@asynccontextmanager
async def lifespan(_: FastAPI):
    if settings.warm_up_models:
        threading.Thread(target=_warm_up, daemon=True).start()
    yield


app = FastAPI(title="FIA Assistant API", version="1.1.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origin_list, allow_methods=["GET", "POST"],
                   allow_headers=["Content-Type"])
app.include_router(insurance_router)
app.include_router(race_control_router)


def _error(status: int, code: str, message: str, detail: dict | None = None) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message, "detail": detail}}, status_code=status)


@app.exception_handler(repository.UnknownCircuit)
async def unknown_circuit(_: Request, exc: repository.UnknownCircuit) -> JSONResponse:
    return _error(404, "UNKNOWN_CIRCUIT", f"No data for circuit {exc.args[0]}. Available: {', '.join(repository.SUPPORTED_CIRCUITS)}.")


@app.exception_handler(UnknownZone)
async def unknown_zone(_: Request, exc: UnknownZone) -> JSONResponse:
    return _error(404, "UNKNOWN_ZONE", f"No zone called {exc.args[0]} at this circuit.")


@app.exception_handler(HTTPException)
async def http_error(_: Request, exc: HTTPException) -> JSONResponse:
    if isinstance(exc.detail, dict) and "code" in exc.detail:
        return _error(exc.status_code, exc.detail["code"], exc.detail["message"], exc.detail.get("detail"))
    return _error(exc.status_code, f"HTTP_{exc.status_code}", str(exc.detail))


@app.exception_handler(RequestValidationError)
async def validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
    first = exc.errors()[0] if exc.errors() else {}
    where = ".".join(str(p) for p in first.get("loc", []) if p not in ("body", "query"))
    return _error(422, "INVALID_REQUEST", f"Invalid {where or 'request'}: {first.get('msg', 'bad value')}.",
                  {"errors": [{"loc": list(e.get("loc", [])), "msg": e.get("msg")} for e in exc.errors()]})


@app.get("/api/health")
def health() -> dict:
    try:
        for circuit in repository.SUPPORTED_CIRCUITS:
            repository.data_version(circuit)
        data_loaded = True
    except repository.UnknownCircuit:
        data_loaded = False
    return {"status": "ok", "data_loaded": data_loaded, "llm_configured": False}
