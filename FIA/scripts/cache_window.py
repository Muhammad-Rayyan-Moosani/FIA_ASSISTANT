"""Cache a time window of one OpenF1 session for all cars, so it can be replayed offline.

    python FIA/scripts/cache_window.py --session-key 9963 --start 2025-06-15T19:25:30 --end 2025-06-15T19:27:45 \
        --out data/replay/montreal_2025_norris

Writes car_data.json, location.json, race_control.json, team_radio.json, drivers.json and meta.json.
Times are UTC. Each stream is fetched in `--chunk`-second slices (one request per slice, all drivers),
through the backend OpenF1 client, which retries when the free tier rate-limits.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from services.openf1_client import OpenF1Client  # noqa: E402


def iso(d: datetime) -> str:
    return d.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3]


def fetch_stream(client: OpenF1Client, path: str, key: int, start: datetime, end: datetime, chunk: int) -> list[dict]:
    rows, t = [], start
    while t < end:
        hi = min(t + timedelta(seconds=chunk), end)
        try:
            rows += client._get(path, session_key=key, **{"date>": iso(t), "date<": iso(hi)})
        except Exception as exc:                       # OpenF1 answers 404 for "no rows"
            print(f"  {path} {iso(t)}: {str(exc)[:60]}")
        time.sleep(1.2)
        t = hi
    seen, out = set(), []                              # slice edges can repeat a row
    for r in rows:
        k = (r["driver_number"], r["date"])
        if k not in seen:
            seen.add(k)
            out.append(r)
    return sorted(out, key=lambda r: (r["date"], r["driver_number"]))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--session-key", type=int, required=True)
    ap.add_argument("--start", required=True, help="UTC, e.g. 2025-06-15T19:25:30")
    ap.add_argument("--end", required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--chunk", type=int, default=30, help="seconds per request")
    a = ap.parse_args()

    start, end = datetime.fromisoformat(a.start), datetime.fromisoformat(a.end)
    out = a.out if a.out.is_absolute() else ROOT / a.out
    out.mkdir(parents=True, exist_ok=True)
    with OpenF1Client() as client:
        for stream in ("car_data", "location"):
            rows = fetch_stream(client, stream, a.session_key, start, end, a.chunk)
            (out / f"{stream}.json").write_text(json.dumps(rows), encoding="utf-8")
            print(f"{stream}: {len(rows)} rows, {len({r['driver_number'] for r in rows})} cars")
        rc = client._get("race_control", session_key=a.session_key)
        radio = client._get("team_radio", session_key=a.session_key)
        drivers = client._get("drivers", session_key=a.session_key)
    pad = timedelta(minutes=5)
    inside = lambda r: start - pad <= datetime.fromisoformat(r["date"]).replace(tzinfo=None) <= end + pad  # noqa: E731
    (out / "race_control.json").write_text(json.dumps([r for r in rc if inside(r)]), encoding="utf-8")
    (out / "team_radio.json").write_text(json.dumps([r for r in radio if inside(r)]), encoding="utf-8")
    (out / "drivers.json").write_text(json.dumps([{k: d.get(k) for k in ("driver_number", "name_acronym", "team_name")}
                                                  for d in drivers]), encoding="utf-8")
    (out / "meta.json").write_text(json.dumps({"session_key": a.session_key, "start": a.start, "end": a.end,
                                               "source": "OpenF1 (api.openf1.org)"}), encoding="utf-8")
    print("wrote", out)


if __name__ == "__main__":
    main()
