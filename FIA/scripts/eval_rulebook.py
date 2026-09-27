"""Measure how well the rulebook search finds the right article.

    python scripts/eval_rulebook.py                       # both embedders, hashing vs sentence-transformers
    python scripts/eval_rulebook.py --embedders st --show-hits
    python scripts/eval_rulebook.py --split test          # only queries tagged "split": "test"
    python scripts/eval_rulebook.py --min-hit3 0.7        # exit 1 if hit@3 is below 70% (regression check)

Test cases live in tests/data/rulebook_queries.json:

    {"query": "...", "expected": ["B5.13"], "split": "dev", "document": "<pdf stem, optional>", "note": "..."}

`expected` lists every acceptable article. A prefix counts as a match ("B5.13" accepts "B5.13.1"),
so you can score at the level of a whole section. Cases with an empty `expected` are skipped and
counted as unlabelled.

Results are the top-k *distinct articles*: several chunks of the same article take one slot, which
is what a person reading the citations would see. The indexes are built in memory and never saved,
so data/rag_index is not touched.
"""
from __future__ import annotations

import argparse
import dataclasses
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.config import get_settings  # noqa: E402
from app.services.rag import HashingEmbedder, RulebookIndex, extract_pdf_pages  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

DEFAULT_QUERIES = ROOT / "tests" / "data" / "rulebook_queries.json"


def matches(article: str | None, expected: list[str]) -> bool:
    return bool(article) and any(article == e or article.startswith(e + ".") for e in expected)


def top_articles(index: RulebookIndex, query: str, k: int, document: str | None = None) -> list[tuple[str | None, int, float]]:
    """The k best distinct articles as (article, page, score); over-fetch chunks, then de-duplicate."""
    seen: set[str | None] = set()
    out = []
    for chunk, score in index.search(query, k * 5, document):
        if chunk.article in seen:
            continue
        seen.add(chunk.article)
        out.append((chunk.article, chunk.page, float(score)))
        if len(out) == k:
            break
    return out


def evaluate(index: RulebookIndex, cases: list[dict], k: int) -> tuple[dict, list[dict]]:
    rows = []
    for c in cases:
        got = top_articles(index, c["query"], k, c.get("document"))
        rank = next((i + 1 for i, (art, _, _) in enumerate(got) if matches(art, c["expected"])), None)
        rows.append({"case": c, "rank": rank, "got": got})
    n = len(rows)
    summary = {
        "n": n,
        "hit1": sum(r["rank"] == 1 for r in rows) / n,
        f"hit{k}": sum(r["rank"] is not None for r in rows) / n,
        "mrr": sum(1 / r["rank"] for r in rows if r["rank"]) / n,
    }
    return summary, rows


def build_index(name: str, cfg, pdfs: dict[str, list[str]]) -> RulebookIndex:
    if name == "hashing":
        index = RulebookIndex(cfg, HashingEmbedder())
    else:  # force the real model: raises instead of silently falling back to hashing
        index = RulebookIndex(dataclasses.replace(cfg, embedding_backend="sentence-transformers"))
    for stem, pages in pdfs.items():
        index.add_document(stem, pages)                 # in memory only: save() is never called
    return index


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--queries", type=Path, default=DEFAULT_QUERIES)
    ap.add_argument("--embedders", default="hashing,st", help="comma list of: hashing, st")
    ap.add_argument("--k", type=int, default=3)
    ap.add_argument("--split", help='only cases with this "split" value (e.g. dev / test)')
    ap.add_argument("--show-hits", action="store_true", help="also print the top results for queries that hit")
    ap.add_argument("--min-hit3", type=float, help="exit 1 if hit@k of the last-listed embedder is below this")
    a = ap.parse_args()

    cases = json.loads(a.queries.read_text(encoding="utf-8"))
    if a.split:
        cases = [c for c in cases if c.get("split") == a.split]
    labelled = [c for c in cases if c.get("expected")]
    print(f"{len(labelled)} labelled queries ({len(cases) - len(labelled)} unlabelled, skipped)")
    if not labelled:
        sys.exit("nothing to evaluate: fill in `expected` for some queries")

    cfg = get_settings().rag
    pdf_paths = sorted(cfg.rulebook_dir.glob("*.pdf"))
    if not pdf_paths:
        sys.exit(f"no PDFs in {cfg.rulebook_dir}")
    pdfs = {p.stem: extract_pdf_pages(p.read_bytes()) for p in pdf_paths}

    last = None
    for name in [e.strip() for e in a.embedders.split(",") if e.strip()]:
        t0 = time.perf_counter()
        index = build_index(name, cfg, pdfs)
        summary, rows = evaluate(index, labelled, a.k)
        last = summary
        print(f"\n=== {name}  ({index.embedder.name}, {len(index.chunks)} chunks, built in {time.perf_counter() - t0:.0f}s)")
        for r in rows:
            c = r["case"]
            if r["rank"] and not a.show_hits:
                continue
            mark = f"hit@{r['rank']}" if r["rank"] else "MISS"
            got = ", ".join(f"{art} p.{pg} ({sc:.2f})" for art, pg, sc in r["got"])
            print(f"  [{mark}] {c['query']}\n         expected {c['expected']}  got: {got}")
        print(f"  hit@1 {summary['hit1']:.0%} | hit@{a.k} {summary[f'hit{a.k}']:.0%} | MRR {summary['mrr']:.2f}  (n={summary['n']})")

    if a.min_hit3 is not None and last and last[f"hit{a.k}"] < a.min_hit3:
        sys.exit(f"hit@{a.k} {last[f'hit{a.k}']:.0%} is below the required {a.min_hit3:.0%}")


if __name__ == "__main__":
    main()
