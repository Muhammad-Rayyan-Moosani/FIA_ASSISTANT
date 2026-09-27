"""Incident stage -> regulation citations: a tiny synthetic rulebook (always runs) and the real PDF index (if present)."""
from __future__ import annotations

import dataclasses
import importlib.util

import pytest

from app.config import RagConfig, get_settings
from app.services.incident_query import incident_queries, rules_for_incident
from app.services.rag import HashingEmbedder, RulebookIndex

PAGES = [
    "ARTICLE X1: RUNNING THE EVENT\n"
    "X1.1 If an F1 Car stops on the track, it shall be the duty of the marshals to remove it as quickly as possible.\n"
    "X1.2 The Safety Car may be brought into operation to neutralise the session upon the order of the Race Director.\n"
    "X1.3 When a yellow flag is shown drivers must slow down and be prepared to change direction.\n"
    "X1.4 Virtual Safety Car procedure: all cars must stay above the minimum time and below the speed delta.\n"
    "X1.5 The pit lane speed limit is 80km/h during the whole event.",
]


def _index() -> RulebookIndex:
    idx = RulebookIndex(RagConfig(index_dir=__import__("pathlib").Path("unused")), HashingEmbedder())
    idx.add_document("Regs", PAGES)
    return idx


def test_every_stage_has_queries_and_unknown_stages_have_none():
    assert all(incident_queries(s) for s in ("slow", "crash", "stopped", "engine_off"))
    assert incident_queries("nonsense") == []


def test_each_stage_finds_its_article_and_dedupes():
    idx = _index()
    stopped = rules_for_incident(idx, "stopped", top_k=3, min_score=0.0)
    by_article = {r.article: r for r in stopped}
    assert len(by_article) == len(stopped)                                      # one entry per article
    assert {"X1.1", "X1.4"} <= set(by_article)                                  # marshals article and VSC article
    assert by_article["X1.1"].citation == "Regs Art. X1.1 (p. 1)"
    assert [r.score for r in stopped] == sorted((r.score for r in stopped), reverse=True)
    assert "X1.2" in {r.article for r in rules_for_incident(idx, "engine_off", top_k=3, min_score=0.0)}
    assert rules_for_incident(idx, "slow", top_k=1, min_score=0.0)[0].article == "X1.3"


def test_min_score_drops_weak_matches():
    assert rules_for_incident(_index(), "stopped", min_score=0.99) == []


# ----------------------------------------------------------------------------- the real 2026 Sporting Regulations
def _real_index() -> RulebookIndex:
    if importlib.util.find_spec("sentence_transformers") is None:
        pytest.skip("sentence-transformers not installed")
    cfg = dataclasses.replace(get_settings().rag, embedding_backend="sentence-transformers")
    idx = RulebookIndex(cfg)
    if not idx.load() or not idx.chunks:
        pytest.skip("no saved rulebook index (run scripts/ingest_rulebook.py with sentence-transformers)")
    return idx


def test_real_rulebook_citations_for_the_norris_stages():
    idx = _real_index()

    def arts(stage):
        return [r.article for r in rules_for_incident(idx, stage, top_k=5)]

    assert "B1.8.4" in arts("slow")                                              # yellow flag: slow down
    assert "B1.5.2" in arts("stopped") and any(a.startswith("B5.12") for a in arts("stopped"))    # marshals; VSC
    assert "B1.5.2" in arts("engine_off") and any(a.startswith("B5.13") for a in arts("engine_off"))   # marshals; SC
