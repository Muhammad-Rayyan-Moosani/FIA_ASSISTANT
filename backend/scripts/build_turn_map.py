"""Calibrate turn number -> lap fraction from track-limits messages.

Each "CAR n (ABC) TIME ... DELETED - TRACK LIMITS AT TURN t LAP k hh:mm:ss" message
names a car, a turn and the (local) time of the infraction. Looking up that car's
position at that time and snapping it onto the reference outline gives the turn's
place on the lap. The median over all samples is written to data/tracks/turns_{circuit}.json.

    cd backend && python -m scripts.build_turn_map
"""

from __future__ import annotations

import json
import re
import statistics
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path

from services.data_loader import DATA_DIR
from services.geolocate import iso
from services.openf1_client import OpenF1Client
from services.zones import load_outline, snap

OUT_DIR = Path(__file__).resolve().parents[2] / "data" / "tracks"
CIRCUITS = ["monza", "montreal"]

# Only the variants that carry a time; "(NEXT LAP)" messages have none.
TL_TIMED = re.compile(r"CAR (\d+) \(\w+\) (?:TIME .+?|LAP) DELETED - TRACK LIMITS AT TURN (\d+) LAP \d+ (\d\d):(\d\d):(\d\d)")


def infraction_time(m: dict, h: int, mi: int, s: int) -> datetime:
    """Embedded time is local; infer the UTC offset by rounding to the nearest hour."""
    posted = datetime.fromisoformat(m["date"])
    local = posted.replace(hour=h, minute=mi, second=s, microsecond=0)
    offset_h = round((local - posted).total_seconds() / 3600)
    return local - timedelta(hours=offset_h)


def build(circuit: str, client: OpenF1Client) -> None:
    data = json.load(open(DATA_DIR / f"{circuit}_2024.json"))
    key = data["session"]["session_key"]
    xy, frac = load_outline(circuit)

    samples: dict[int, list[float]] = defaultdict(list)
    for m in data["race_control"]:
        g = TL_TIMED.search(m["message"])
        if not g:
            continue
        car, turn = int(g.group(1)), int(g.group(2))
        t = infraction_time(m, int(g.group(3)), int(g.group(4)), int(g.group(5)))
        pts = client.location(key, car, iso(t - timedelta(seconds=1)), iso(t + timedelta(seconds=1)))
        if not pts:
            continue
        p = min(pts, key=lambda p: abs((datetime.fromisoformat(p["date"]) - t).total_seconds()))
        s, _ = snap(xy, frac, p["x"], p["y"])
        samples[turn].append(s)

    table = {
        str(t): {"lap_frac": round(statistics.median(v), 3), "n": len(v), "spread": round(max(v) - min(v), 3)}
        for t, v in sorted(samples.items())
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / f"turns_{circuit}.json"
    path.write_text(json.dumps(table, indent=1))
    print(f"[{circuit}] {path.name}: " + ", ".join(f"T{t}={v['lap_frac']}(n={v['n']},±{v['spread']})" for t, v in table.items()))


def main() -> None:
    with OpenF1Client() as client:
        for c in CIRCUITS:
            build(c, client)


if __name__ == "__main__":
    main()
