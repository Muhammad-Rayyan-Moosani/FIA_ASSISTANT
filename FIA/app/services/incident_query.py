"""Turn an incident stage into the regulation articles that apply to it.

The rulebook search matches on the regulations' own vocabulary, not on ours: "F1 Car stops on the
track", "Safety Car ... neutralise", "yellow flag" find the right articles, while "driver not
responding" does not. So each stage maps to a few short queries written that way, and the results are
merged by article. Only citations are returned, never generated text. Medical procedure is not covered:
it is not in Section B of the Sporting Regulations.
"""
from __future__ import annotations

from dataclasses import dataclass

from app.services.rag import RulebookIndex

STAGE_QUERIES: dict[str, list[str]] = {
    "slow": [
        "Drivers must slow down and be prepared to change direction when a yellow flag is shown",
    ],
    "crash": [
        "Car stationary on the track, marshals must remove it",
        "Safety Car deployed to neutralise the session on the order of the Race Director",
    ],
    "stopped": [
        "Car stationary on the track, marshals must remove it",
        "Virtual Safety Car procedure and speed requirements",
    ],
    "engine_off": [
        "Car stationary on the track, marshals must remove it",
        "Safety Car deployed to neutralise the session on the order of the Race Director",
    ],
}


@dataclass(frozen=True)
class RuleRef:
    citation: str           # e.g. "FIA 2026 ... Art. B1.5.2 (p. 6)"
    article: str | None
    page: int
    score: float
    text: str
    query: str              # which query found it


def incident_queries(stage: str) -> list[str]:
    return list(STAGE_QUERIES.get(stage, []))


def rules_for_incident(index: RulebookIndex, stage: str, top_k: int = 3, per_query: int = 3,
                       min_score: float = 0.55) -> list[RuleRef]:
    """The best-matching articles for an incident stage, one entry per article, best first.

    ``min_score`` is a cosine similarity for the default MiniLM model: the right articles score about
    0.57-0.69 and unrelated ones (penalties, pit lane) 0.47-0.52. It is not comparable across embedders.
    """
    best: dict[str | None, RuleRef] = {}
    for q in incident_queries(stage):
        seen: set[str | None] = set()
        for chunk, score in index.search(q, per_query * 4):
            if chunk.article in seen:
                continue
            seen.add(chunk.article)
            if len(seen) > per_query:
                break
            if score < min_score:
                continue
            ref = RuleRef(
                citation=f"{chunk.document}" + (f" Art. {chunk.article}" if chunk.article else "") + f" (p. {chunk.page})",
                article=chunk.article, page=chunk.page, score=round(float(score), 4), text=chunk.text, query=q)
            if chunk.article not in best or ref.score > best[chunk.article].score:
                best[chunk.article] = ref
    return sorted(best.values(), key=lambda r: -r.score)[:top_k]
