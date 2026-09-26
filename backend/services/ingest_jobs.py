"""R3 · Run the Step 1 pipeline (scripts/ingest.py) as a background job and record its progress for SSE."""

from __future__ import annotations

import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone

from scripts.ingest import ingest


@dataclass
class Job:
    job_id: str
    circuit: str
    created_at: str
    status: str = "queued"                     # queued | running | succeeded | failed
    events: list[tuple[str, dict]] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def emit(self, event: str, data: dict) -> None:
        with self.lock:
            self.events.append((event, data))

    def since(self, index: int) -> list[tuple[str, dict]]:
        with self.lock:
            return self.events[index:]

    @property
    def finished(self) -> bool:
        return self.status in ("succeeded", "failed")


_jobs: dict[str, Job] = {}
_running: dict[str, str] = {}               # circuit -> job id (one run per circuit at a time)
_guard = threading.Lock()


def start(circuit: str, refresh: bool = False) -> Job:
    with _guard:
        active = _running.get(circuit)
        if active and not _jobs[active].finished:
            return _jobs[active]
        job = Job(uuid.uuid4().hex[:12], circuit, datetime.now(timezone.utc).isoformat(timespec="seconds"))
        _jobs[job.job_id] = job
        _running[circuit] = job.job_id
    threading.Thread(target=_work, args=(job, refresh), daemon=True, name=f"ingest-{circuit}").start()
    return job


def get(job_id: str) -> Job | None:
    return _jobs.get(job_id)


def _work(job: Job, refresh: bool) -> None:
    job.status = "running"
    t0 = time.monotonic()
    try:
        progress = lambda stage, done, total, msg: job.emit(  # noqa: E731
            "progress", {"stage": stage, "done": done, "total": total, "message": msg})
        _, records = ingest(job.circuit, refresh=refresh, offline=False, progress=progress)
        from services import repository

        # Oldest first, so the client's newest-on-top feed ends in time order. Contract-shaped (centred x/y).
        for r in reversed(repository.incidents(job.circuit)):
            job.emit("incident", {"incident": r})
        job.status = "succeeded"
        job.emit("done", {"job_id": job.job_id, "incidents_written": len(records), "duration_s": round(time.monotonic() - t0, 1)})
    except Exception as exc:                              # report to the client, keep the server up
        traceback.print_exc()
        job.status = "failed"
        job.emit("stream_error", {"code": "INGEST_FAILED", "message": f"Ingestion failed: {exc}"})
