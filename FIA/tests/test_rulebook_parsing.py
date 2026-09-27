"""Parsing of FIA-style regulation PDFs. The mini rulebook below is synthetic test text."""
from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

from app.config import RagConfig, get_settings
from app.routers.fia import transcript_citations
from app.services import rag
from app.services.rag import HashingEmbedder, RulebookIndex, chunk_pages, clean_pages, ingest_rulebook_dir

HEADER = "SECTION X: TEST REGULATIONS"
FOOTER = "2026 Test Series: Sporting Regulations 01 January 2026"


def _page(body: str, n: int) -> str:
    return f"{HEADER}\n{body}\n{FOOTER}\nX1 {n}\n©2026 Test Federation Issue 01"


PAGES = [
    _page("CONTENTS\nARTICLE X1: RUNNING THE EVENT 2\nX1.1 General 2\nX1.2 Pit Lane 2\n"
          "X1.3 Driving 3\nAPPENDIX X1: DEFINITIONS 5", 1),
    _page("ARTICLE X1: RUNNING THE EVENT\nX1.1 General\n"
          "X1.1.1 All o`icials must be informed of any e`ort to modify the schedule.\n"
          "X1.2 Pit Lane\n"
          "X1.2.1 A speed limit of 80km/h applies in the pit lane during the whole event, and any breach\n"
          "Article X1.1.1 will apply to the resulting penalty.", 2),
    _page("X1.3 Driving\n"
          "X1.3.1 Drivers must make every reasonable effort to use the track at all times, and\n"
          "X1.1 will be referred to when a lasting advantage is gained.\n"
          "X1.3.2 A driver may not overtake behind the safety car.", 3),
    _page("X1.3.3 Stewards may impose a time penalty for causing a collision.", 4),
    _page("APPENDIX X1: DEFINITIONS\n1.1 Pit lane means the area between the pit entry and pit exit.\n"
          "1.2 Track means the surface bounded by the white lines.", 5),
]


def test_clean_pages_fixes_ligatures_and_strips_running_text():
    cleaned = clean_pages(PAGES)
    joined = "\n".join(cleaned)
    assert "officials" in joined and "effort" in joined and "`" not in joined
    assert HEADER not in joined and FOOTER not in joined and "Test Federation" not in joined
    assert "X1 2" not in joined.splitlines()


def test_chunker_structure():
    chunks = chunk_pages("Regs", PAGES, 900, 150)
    by_art = {c.article: c for c in chunks}
    # contents page skipped, bare titles not indexed on their own
    assert all(c.page != 1 for c in chunks)
    assert "X1" not in by_art and "X1.2" not in by_art
    # lettered numbering + breadcrumb heading
    assert by_art["X1.2.1"].heading == "ARTICLE X1: RUNNING THE EVENT › X1.2 Pit Lane"
    # wrapped lines that start with a reference stay in the article body
    assert "Article X1.1.1 will apply" in by_art["X1.2.1"].text
    assert "X1.1 will be referred to" in by_art["X1.3.1"].text
    assert [c.article for c in chunks if c.article == "X1.1.1"] == ["X1.1.1"]
    # appendix is its own section and its numbered list stays inside it
    app = by_art["Appendix X1"]
    assert app.page == 5 and "1.2 Track means" in app.text
    assert "1.1" not in by_art


def test_transcript_citations_ignore_chatter():
    idx = RulebookIndex(RagConfig(index_dir=Path("unused")), HashingEmbedder())
    idx.add_document("Regs", PAGES)
    cites = transcript_citations(idx, ["Box, box.", "He overtook me behind the safety car"], top_k=3)
    assert cites and cites[0].article == "X1.3.2"
    assert cites[0].citation == "Regs Art. X1.3.2 (p. 3)"


def test_ingest_rulebook_dir(tmp_path, monkeypatch):
    books = tmp_path / "rulebooks"
    books.mkdir()
    (books / "TestRegs.pdf").write_bytes(b"%PDF-stub")
    monkeypatch.setattr(rag, "extract_pdf_pages", lambda data: PAGES)
    cfg = RagConfig(index_dir=tmp_path / "idx", rulebook_dir=books)
    idx = RulebookIndex(cfg, HashingEmbedder())
    assert ingest_rulebook_dir(idx, books) == ["TestRegs"]
    assert ingest_rulebook_dir(idx, books) == []  # already indexed
    fresh = RulebookIndex(cfg, HashingEmbedder())
    assert fresh.load() and fresh.stats()["documents"] == ["TestRegs"]


REAL_PDF = next(iter(sorted(get_settings().rag.rulebook_dir.glob("*Sporting*.pdf"))), None)


@pytest.mark.skipif(REAL_PDF is None or importlib.util.find_spec("pdfplumber") is None,
                    reason="real FIA Sporting Regulations PDF / pdfplumber not available")
def test_real_fia_sporting_regulations():
    pages = rag.extract_pdf_pages(REAL_PDF.read_bytes())
    chunks = chunk_pages(REAL_PDF.stem, pages, 900, 150)
    arts = {c.article for c in chunks}
    assert len(chunks) > 400 and {"B1.8.6", "B5.13.1", "B1.9.3", "Appendix B1"} <= arts
    assert all(a and (a.startswith("B") or a.startswith("Appendix")) for a in arts)
    track = next(c for c in chunks if c.article == "B1.8.6")
    assert track.page == 12 and "use the track at all times" in track.text
    assert "B1.8 Driving" in track.heading
    assert not any("`" in c.text or "Fédération" in c.text for c in chunks)
