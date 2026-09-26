import re
import json
from dataclasses import dataclass
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parents[2] / "data" / "openf1"

@dataclass
class Incident:
    date: str            # race_control 'date' (UTC) -> your t0
    lap: int
    kind: str            # "collision" | "off_track" | "yellow" | "sc" | "vsc" | "red" | "track_limits"
    severity: str        # "high" | "medium" | "low"
    cars: list[int]
    turn: int | None
    sector: int | None
    text: str
    x: float | None = None
    y: float | None = None
    lap_frac: float | None = None
    geo_method: str | None = None
    geo_confidence: str | None = None

INCIDENT = re.compile(r"TURN (\d+) INCIDENT INVOLVING CARS? (.+?) NOTED - (.+)")
TRACK_LIMITS = re.compile(r"CAR (\d+) \(\w+\) (?:TIME .+?|LAP) DELETED - TRACK LIMITS AT TURN (\d+)")
CARS = re.compile(r"(\d+) \(\w{3}\)")          # run on the group from INCIDENT

def classify(m: dict) -> Incident | None:
    msg = m["message"]
    if msg.startswith("FIA STEWARDS"):        # duplicates of the NOTED line
        return None
    if (g := INCIDENT.search(msg)):
        turn = int(g.group(1))
        cars = [int(n) for n in CARS.findall(g.group(2))]
        reason = g.group(3)
        kind = "collision" if "COLLISION" in reason else "off_track"
        return Incident(m["date"], m["lap_number"], kind,
                    "high" if kind == "collision" else "medium",
                    cars, turn, None, msg)
    if (g := TRACK_LIMITS.search(msg)):
        return Incident(m["date"], m["lap_number"], "track_limits", "low",
                        [int(g.group(1))], int(g.group(2)), None, msg)
    return None


def load_incidents(circuit: str) -> list[Incident]:
    data = json.load(open(DATA_DIR / f"{circuit}_2024.json"))
    return [i for m in data["race_control"] if (i := classify(m))]
