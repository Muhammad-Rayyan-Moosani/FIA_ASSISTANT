"""Pre-download every local model race control uses, so the demo needs no internet (idea from Yash's
FIA/scripts/warm_models.py, for the backend's models).

    cd backend && python -m scripts.warm_models

Models are cached under ~/.cache/huggingface (not in this repo), so run it once on the laptop that will demo.
Then set HF_HUB_OFFLINE=1 to stop any accidental network calls. Also builds the rulebook index.
"""
from __future__ import annotations

import time


def main() -> None:
    from services import multimodal_severity as ms
    from services.race_control import rulebook

    t0 = time.perf_counter()
    print(f"loading {ms.ASR_MODEL} and {ms.EMOTION_MODEL} ...")
    if not ms.MODELS.load():
        raise SystemExit(f"could not load the radio models: {ms.MODELS.error}")
    print("building the FIA rulebook index (sentence-transformers) ...")
    stats = rulebook.get_index().stats()
    print(f"ready in {time.perf_counter() - t0:.0f} s · {stats['total_chunks']} regulation passages · {stats['embedding_backend']}")


if __name__ == "__main__":
    main()
