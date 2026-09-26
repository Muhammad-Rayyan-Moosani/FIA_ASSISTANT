"""Download real reference data from OpenF1 into /data/openf1.

For each circuit we grab one clean race lap (x/y position + speed trace) which
becomes the track outline and speed profile, plus the full race-control message
log and the driver roster.

    cd backend && python -m scripts.fetch_openf1
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np

from services.openf1_client import OpenF1Client

DATA_DIR = Path(__file__).resolve().parents[2] / "data" / "openf1"

# circuit id -> (OpenF1 filters for the 2024 race, reference driver, reference lap)
CIRCUITS = {
    "monza": ({"year": 2024, "session_type": "Race", "circuit_short_name": "Monza"}, 16, 12),
    "silverstone": ({"year": 2024, "session_type": "Race", "circuit_short_name": "Silverstone"}, 44, 8),
    "spa": ({"year": 2024, "session_type": "Race", "circuit_short_name": "Spa-Francorchamps"}, 44, 30),
}


def _parse(ts: str) -> datetime:
    return datetime.fromisoformat(ts)


def fetch_circuit(client: OpenF1Client, circuit: str, filters: dict, driver: int, lap_no: int) -> None:
    sessions = client.sessions(**filters)
    if not sessions:
        print(f"[{circuit}] no session found for {filters}")
        return
    session = sessions[0]
    key = session["session_key"]

    lap = client.laps(key, driver_number=driver, lap_number=lap_no)[0]
    start = _parse(lap["date_start"])
    end = start + timedelta(seconds=lap["lap_duration"])
    iso = lambda d: d.isoformat().replace("+00:00", "")  # noqa: E731

    loc = client.location(key, driver, iso(start), iso(end))
    car = client.car_data(key, driver, iso(start), iso(end))

    # Interpolate the speed trace onto the position samples by timestamp.
    t_loc = np.array([(_parse(p["date"]) - start).total_seconds() for p in loc])
    t_car = np.array([(_parse(c["date"]) - start).total_seconds() for c in car])
    speed = np.interp(t_loc, t_car, np.array([c["speed"] for c in car], dtype=float))

    samples = [
        {"t": round(float(t), 3), "x": p["x"], "y": p["y"], "speed": round(float(s), 1)}
        for t, p, s in zip(t_loc, loc, speed)
    ]

    out = {
        "circuit": circuit,
        "session": {k: session[k] for k in ("session_key", "meeting_key", "circuit_short_name", "country_name", "date_start", "year")},
        "reference": {"driver_number": driver, "lap_number": lap_no, "lap_duration": lap["lap_duration"]},
        "samples": samples,
        "race_control": client.race_control(key),
        "drivers": [
            {k: d.get(k) for k in ("driver_number", "name_acronym", "full_name", "team_name", "team_colour")}
            for d in client.drivers(key)
        ],
    }
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    path = DATA_DIR / f"{circuit}_2024.json"
    path.write_text(json.dumps(out, indent=1))
    print(f"[{circuit}] session {key}: {len(samples)} samples, {len(out['race_control'])} RC msgs -> {path.name}")


def main() -> None:
    with OpenF1Client() as client:
        for circuit, (filters, driver, lap_no) in CIRCUITS.items():
            fetch_circuit(client, circuit, filters, driver, lap_no)


if __name__ == "__main__":
    main()
