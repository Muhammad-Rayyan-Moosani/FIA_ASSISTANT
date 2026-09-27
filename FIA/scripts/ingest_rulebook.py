"""Build / refresh the FIA rulebook search index from PDFs.

    python scripts/ingest_rulebook.py                      # every PDF in data/rulebooks/
    python scripts/ingest_rulebook.py path/to/regs.pdf     # copy into data/rulebooks/ and index it
    python scripts/ingest_rulebook.py --rebuild            # re-index everything from scratch
    python scripts/ingest_rulebook.py --query "pit lane speed limit"

The server does the same automatically at start-up for new PDFs; running this first
just avoids the ~30 s background indexing on the first launch.
"""
from __future__ import annotations

import argparse
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.config import get_settings  # noqa: E402
from app.services.rag import RulebookIndex, ingest_rulebook_dir  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pdfs", nargs="*", type=Path, help="PDFs to copy into the rulebook folder before indexing")
    ap.add_argument("--rebuild", action="store_true", help="drop the saved index and re-index every PDF")
    ap.add_argument("--query", action="append", default=[], help="run a test query after indexing (repeatable)")
    a = ap.parse_args()

    cfg = get_settings().rag
    cfg.rulebook_dir.mkdir(parents=True, exist_ok=True)
    for pdf in a.pdfs:
        if not pdf.is_file() or pdf.suffix.lower() != ".pdf":
            sys.exit(f"not a PDF: {pdf}")
        dest = cfg.rulebook_dir / pdf.name
        if pdf.resolve() != dest.resolve():
            shutil.copy2(pdf, dest)
            print(f"copied {pdf.name} -> {dest}")

    index = RulebookIndex(cfg)
    if not a.rebuild:
        index.load()
    t0 = time.perf_counter()
    added = ingest_rulebook_dir(index, cfg.rulebook_dir)
    s = index.stats()
    print(f"indexed {added or 'nothing new'} in {time.perf_counter() - t0:.1f}s")
    print(f"index: {s['total_chunks']} chunks · {s['embedding_backend']} · {s['index_backend']} · {cfg.index_dir}")
    for d in s["documents"]:
        print(f"  • {d}")
    for q in a.query:
        print(f"\n? {q}")
        for chunk, score in index.search(q, 3):
            print(f"  {score:.2f}  Art. {chunk.article} (p. {chunk.page})  {chunk.text[:100]}…")


if __name__ == "__main__":
    main()
