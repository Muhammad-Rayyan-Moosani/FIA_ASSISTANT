"""Pre-download the ML models onto this machine, so the demo needs no internet.

Run this once, ahead of time, on whatever laptop will actually run the demo (models are cached
under ~/.cache/huggingface; they are NOT stored in this repo, so this must be re-run per machine,
or that cache folder copied over manually):

    python scripts/warm_models.py

Then, right before demoing, stop any accidental network calls with:

    setx HF_HUB_OFFLINE 1        (persists)   or   $env:HF_HUB_OFFLINE = "1"   (this session only)

Needs requirements-ml.txt installed first (sentence-transformers, faster-whisper).
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.config import get_settings  # noqa: E402


def warm_embedder() -> None:
    from sentence_transformers import SentenceTransformer

    cfg = get_settings().rag
    print(f"downloading {cfg.embedding_model} ...")
    model = SentenceTransformer(cfg.embedding_model)
    model.encode(["warm-up"])
    print("  ok:", model.get_sentence_embedding_dimension(), "dims")


def warm_whisper() -> None:
    from faster_whisper import WhisperModel

    cfg = get_settings().audio
    print(f"downloading faster-whisper {cfg.whisper_model} ...")
    WhisperModel(cfg.whisper_model, device=cfg.whisper_device, compute_type=cfg.whisper_compute_type)
    print("  ok")


def main() -> None:
    failures = []
    for name, fn in (("sentence-transformers", warm_embedder), ("faster-whisper", warm_whisper)):
        try:
            fn()
        except ImportError as exc:
            failures.append(name)
            print(f"  SKIPPED ({name} not installed): {exc}")
        except Exception as exc:
            failures.append(name)
            print(f"  FAILED ({name}): {exc}")
    if failures:
        sys.exit(f"\nnot fully warmed: {', '.join(failures)}. Fix and re-run before going offline.")
    print("\nBoth models are cached locally. You can now run with HF_HUB_OFFLINE=1.")


if __name__ == "__main__":
    main()
