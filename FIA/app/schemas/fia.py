"""Request/response models for the FIA assistant (rulebook RAG + radio transcription)."""
from __future__ import annotations

from pydantic import BaseModel, Field


class IngestedDocument(BaseModel):
    document: str
    pages: int
    chunks: int


class IngestResponse(BaseModel):
    documents: list[IngestedDocument]
    total_chunks: int
    embedding_backend: str
    index_backend: str


class IndexStats(BaseModel):
    documents: list[str]
    total_chunks: int
    dim: int
    embedding_backend: str
    index_backend: str


class RuleQuery(BaseModel):
    incident_description: str = Field(
        ..., min_length=3, examples=["Car 16 left the track at Turn 4 and gained a lasting advantage"],
    )
    top_k: int = Field(5, ge=1, le=25)
    min_score: float = Field(0.0, ge=-1, le=1, description="Drop citations below this cosine similarity.")
    document: str | None = Field(None, description="Restrict search to one ingested document.")


class RuleCitation(BaseModel):
    citation: str = Field(..., description='Human-readable reference, e.g. "2026 Sporting Regs Art. 33.3 (p. 41)".')
    document: str
    article: str | None
    page: int
    score: float
    text: str


class RuleQueryResponse(BaseModel):
    query: str
    citations: list[RuleCitation]


class TranscriptSegment(BaseModel):
    start: float
    end: float
    text: str
    avg_logprob: float | None = None
    no_speech_prob: float | None = None


class TranscriptionResponse(BaseModel):
    text: str
    language: str | None
    duration_s: float
    segments: list[TranscriptSegment]
    model: str
    related_rules: list[RuleCitation] = Field(
        default_factory=list, description="Populated when `match_rules=true`.",
    )
