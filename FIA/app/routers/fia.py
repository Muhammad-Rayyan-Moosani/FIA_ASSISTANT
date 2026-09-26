"""FIA assistant routes: rulebook RAG and team-radio transcription (``/api/v1/fia-assistant``)."""
from __future__ import annotations

import os

from fastapi import APIRouter, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.concurrency import run_in_threadpool

from app.schemas.fia import (
    IndexStats,
    IngestedDocument,
    IngestResponse,
    RuleCitation,
    RuleQuery,
    RuleQueryResponse,
    TranscriptionResponse,
    TranscriptSegment,
)
from app.services.audio import AudioBackendUnavailable
from app.services.rag import RulebookIndex, extract_pdf_pages

router = APIRouter(prefix="/api/v1/fia-assistant", tags=["FIA Assistant"])

MAX_UPLOAD_BYTES = 50 * 1024 * 1024


def _index(request: Request) -> RulebookIndex:
    return request.app.state.rulebook


def _citations(index: RulebookIndex, q: RuleQuery) -> list[RuleCitation]:
    hits = index.search(q.incident_description, q.top_k, q.document)
    out = []
    for chunk, score in hits:
        if score < q.min_score:
            continue
        ref = f"{chunk.document}" + (f" Art. {chunk.article}" if chunk.article else "") + f" (p. {chunk.page})"
        out.append(RuleCitation(
            citation=ref, document=chunk.document, article=chunk.article,
            page=chunk.page, score=round(float(score), 4), text=chunk.text,
        ))
    return out


@router.post("/ingest-rulebook", response_model=IngestResponse, summary="Parse & index FIA rulebook PDFs")
async def ingest_rulebook(
    request: Request,
    files: list[UploadFile] = File(..., description="FIA regulation PDFs (or UTF-8 .txt, pages split by form-feed)."),
) -> IngestResponse:
    index = _index(request)
    docs: list[IngestedDocument] = []
    for f in files:
        data = await f.read()
        if len(data) > MAX_UPLOAD_BYTES:
            raise HTTPException(413, f"{f.filename} exceeds {MAX_UPLOAD_BYTES // 2**20} MB")
        name = os.path.splitext(os.path.basename(f.filename or "rulebook"))[0]
        is_pdf = (f.content_type == "application/pdf") or (f.filename or "").lower().endswith(".pdf")
        try:
            if is_pdf:
                pages = await run_in_threadpool(extract_pdf_pages, data)
            else:
                pages = data.decode("utf-8").split("\f")
        except ImportError as exc:
            raise HTTPException(503, "pdfplumber is not installed") from exc
        except Exception as exc:
            raise HTTPException(422, f"could not parse {f.filename}: {exc}") from exc
        n = await run_in_threadpool(index.add_document, name, pages)
        docs.append(IngestedDocument(document=name, pages=len(pages), chunks=n))
    await run_in_threadpool(index.save)
    stats = index.stats()
    return IngestResponse(
        documents=docs, total_chunks=stats["total_chunks"],
        embedding_backend=stats["embedding_backend"], index_backend=stats["index_backend"],
    )


@router.get("/index", response_model=IndexStats, summary="Rulebook index status")
async def index_stats(request: Request) -> IndexStats:
    return IndexStats(**_index(request).stats())


@router.post("/query-rules", response_model=RuleQueryResponse, summary="Retrieve rule citations for an incident")
async def query_rules(body: RuleQuery, request: Request) -> RuleQueryResponse:
    index = _index(request)
    if not index.chunks:
        raise HTTPException(409, "rulebook index is empty — POST PDFs to /ingest-rulebook first")
    cites = await run_in_threadpool(_citations, index, body)
    return RuleQueryResponse(query=body.incident_description, citations=cites)


async def _transcribe(request: Request, data: bytes, fmt: str | None, language: str | None,
                      match_rules: bool, top_k: int) -> TranscriptionResponse:
    if not data:
        raise HTTPException(422, "empty audio payload")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "audio payload too large")
    transcriber = request.app.state.transcriber
    try:
        tr = await run_in_threadpool(transcriber.transcribe, data, fmt, language)
    except AudioBackendUnavailable as exc:
        raise HTTPException(503, f"audio backend unavailable: {exc}") from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    related: list[RuleCitation] = []
    index = _index(request)
    if match_rules and tr.text and index.chunks:
        related = await run_in_threadpool(_citations, index, RuleQuery(incident_description=tr.text, top_k=top_k))
    return TranscriptionResponse(
        text=tr.text, language=tr.language, duration_s=tr.duration_s,
        segments=[TranscriptSegment(**s) for s in tr.segments],
        model=transcriber.model_name, related_rules=related,
    )


def _fmt_from(filename: str | None, content_type: str | None) -> str | None:
    ext = os.path.splitext(filename or "")[1].lstrip(".").lower()
    if ext:
        return ext
    if content_type and "/" in content_type:
        sub = content_type.split("/", 1)[1].split(";")[0]
        return {"mpeg": "mp3", "x-wav": "wav", "wave": "wav", "mp4": "m4a"}.get(sub, sub)
    return None


@router.post("/transcribe-radio", response_model=TranscriptionResponse, summary="Transcribe a team-radio clip")
async def transcribe_radio(
    request: Request,
    file: UploadFile = File(..., description="wav / mp3 / m4a / ogg / flac clip."),
    language: str | None = Form(None, description="ISO code; auto-detected if omitted."),
    match_rules: bool = Form(False, description="Also retrieve rule citations for the transcript."),
    top_k: int = Form(3, ge=1, le=10),
) -> TranscriptionResponse:
    data = await file.read()
    return await _transcribe(request, data, _fmt_from(file.filename, file.content_type), language, match_rules, top_k)


@router.post("/transcribe-radio/raw", response_model=TranscriptionResponse,
             summary="Transcribe a raw audio stream (request body)")
async def transcribe_radio_raw(
    request: Request,
    language: str | None = Query(None),
    match_rules: bool = Query(False),
    top_k: int = Query(3, ge=1, le=10),
    fmt: str | None = Query(None, description="Container hint, e.g. wav, mp3, ogg. Defaults to Content-Type."),
) -> TranscriptionResponse:
    """Send audio bytes directly as the body (``Content-Type: audio/wav`` etc.) — suitable for streamed uploads."""
    chunks = bytearray()
    async for part in request.stream():
        chunks.extend(part)
        if len(chunks) > MAX_UPLOAD_BYTES:
            raise HTTPException(413, "audio payload too large")
    fmt = fmt or _fmt_from(None, request.headers.get("content-type"))
    return await _transcribe(request, bytes(chunks), fmt, language, match_rules, top_k)
