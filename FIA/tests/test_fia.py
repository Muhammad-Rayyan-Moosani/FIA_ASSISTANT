"""RAG + transcription tests. The rulebook text below is synthetic test data, not FIA wording."""
from __future__ import annotations

import importlib.util

import pytest

from app.config import RagConfig
from app.services.rag import HashingEmbedder, RulebookIndex, chunk_pages

RULEBOOK = (
    "ARTICLE 12 Track limits\n"
    "12.1 Competitors are required to keep the car within the white lines bordering the circuit.\n"
    "12.2 A competitor who leaves the circuit and gains a lasting advantage may be reported to the stewards.\n"
    "\f"
    "ARTICLE 30 Safety car\n"
    "30.1 The safety car may be deployed when marshals or competitors are in physical danger on track.\n"
    "30.2 While the safety car is deployed, overtaking is prohibited and cars remain within ten car lengths.\n"
    "\f"
    "ARTICLE 40 Pit lane\n"
    "40.1 The pit lane speed limit is 80 km/h and exceeding the pit lane speed limit results in a time penalty.\n"
    "40.2 An unsafe release from the pit stop box is reported to the stewards.\n"
)

Q = "/api/v1/fia-assistant/query-rules"


def _ingest(client):
    return client.post(
        "/api/v1/fia-assistant/ingest-rulebook",
        files=[("files", ("TestRegs2026.txt", RULEBOOK.encode(), "text/plain"))],
    )


def test_chunker_tracks_articles_and_pages():
    chunks = chunk_pages("Regs", RULEBOOK.split("\f"), max_chars=900, overlap=150)
    arts = [(c.article, c.page) for c in chunks]
    assert ("12.2", 1) in arts and ("30.1", 2) in arts and ("40.1", 3) in arts


def test_query_before_ingest_is_409(client):
    assert client.post(Q, json={"incident_description": "pit lane speeding"}).status_code == 409


def test_ingest_and_query(client):
    r = _ingest(client)
    assert r.status_code == 200, r.text
    assert r.json()["documents"][0]["pages"] == 3

    top = client.post(Q, json={"incident_description": "Car 22 exceeded the pit lane speed limit", "top_k": 3}).json()
    assert top["citations"][0]["article"] == "40.1"
    assert top["citations"][0]["citation"] == "TestRegs2026 Art. 40.1 (p. 3)"

    sc = client.post(Q, json={"incident_description": "driver overtaking behind the safety car"}).json()
    assert sc["citations"][0]["article"] == "30.2"

    tl = client.post(Q, json={"incident_description": "left the circuit and gained a lasting advantage"}).json()
    assert tl["citations"][0]["article"] == "12.2"


def test_reingest_replaces_document(client):
    _ingest(client)
    _ingest(client)
    stats = client.get("/api/v1/fia-assistant/index").json()
    assert stats["documents"] == ["TestRegs2026"]
    assert stats["total_chunks"] == len(chunk_pages("x", RULEBOOK.split("\f"), 900, 150))


def test_index_persists(tmp_path):
    cfg = RagConfig(index_dir=tmp_path / "idx", embedding_backend="hashing")
    idx = RulebookIndex(cfg, HashingEmbedder())
    idx.add_document("Regs", RULEBOOK.split("\f"))
    idx.save()
    fresh = RulebookIndex(cfg, HashingEmbedder())
    assert fresh.load()
    assert fresh.search("pit lane speed limit", 1)[0][0].article == "40.1"


@pytest.mark.skipif(importlib.util.find_spec("pydub") is not None, reason="audio stack installed")
def test_transcribe_without_backend_is_503(client):
    r = client.post(
        "/api/v1/fia-assistant/transcribe-radio",
        files={"file": ("radio.wav", b"RIFF....WAVEfmt ", "audio/wav")},
    )
    assert r.status_code == 503


def test_transcribe_empty_raw_body_is_422(client):
    r = client.post("/api/v1/fia-assistant/transcribe-radio/raw", content=b"",
                    headers={"content-type": "audio/wav"})
    assert r.status_code == 422
