"""R1 · Data: fetch, cache and turn OpenF1 race-control messages into placed incidents.

Pipeline (see ARCHITECTURE.md §4):
  1. fetch_raw()        OpenF1 race_control for every session 2023+, plus turn and marshal-sector
                        positions (MultiViewer circuit API) -> data/openf1/ (raw cache, run once)
  2. extract_events()   parse messages, drop repeats, classify each event (regex fast path)
  3. place_events()     put every event in a zone:
                          turn_in_message  "TURN 8 INCIDENT ..." / "TRACK LIMITS AT TURN 2"  -> high
                          marshal_sector   "YELLOW IN TRACK SECTOR 6" -> turn nearest that
                                           marshal post (checked against race control's own
                                           "RECOVERY VEHICLE AT TURN n" messages)           -> medium
  4. to_records()       incident records in the §4.4 schema, with entry speed and crash energy

Why the corner named in the message beats car location for steward incidents: steward notes
("TURN 8 INCIDENT ... NOTED") are posted a minute or more after the event, so a car's position
at the message time is not where the incident happened. The turn in the text is.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import httpx
import numpy as np

from services.openf1_client import OpenF1Client

ROOT_DIR = Path(__file__).resolve().parents[2] / "data"
DATA_DIR = ROOT_DIR / "openf1"     # raw OpenF1 cache (name kept: scripts/build_turn_map.py uses it)
RAW_DIR = DATA_DIR
MULTIVIEWER_URL = "https://api.multiviewer.app/api/v1/circuits/{key}/{year}"

CAR_MASS_KG = 798          # F1 minimum mass incl. driver (ARCHITECTURE.md §4.4)
FIRST_SEASON = 2023


@dataclass(frozen=True)
class CircuitConfig:
    id: str
    name: str
    openf1_name: str                 # OpenF1 circuit_short_name
    multiviewer_key: int
    reference_lap: str               # file in data/openf1 with x, y, speed samples
    length_m: float                  # official lap length: the outline is calibrated to it
    turn_names: dict[int, str]       # official turn number -> corner name
    reference_year: int = 2024
    short_name: str = ""              # display name (e.g. "Monza")
    country: str = ""
    event_name: str = ""              # Grand Prix held at the circuit
    race_laps: int = 0               # scheduled Grand Prix distance in laps (Step 2 per-pass exposure)
    grid_size: int = 20              # cars per race (Step 2 per-pass exposure)


CIRCUITS = {
    "monza": CircuitConfig(
        id="monza", name="Autodromo Nazionale Monza", openf1_name="Monza", multiviewer_key=39,
        reference_lap="monza_2024.json", length_m=5793,
        turn_names={1: "Variante del Rettifilo", 2: "Variante del Rettifilo", 3: "Curva Biassono (Curva Grande)",
                    4: "Variante della Roggia", 5: "Variante della Roggia", 6: "Lesmo 1", 7: "Lesmo 2",
                    8: "Variante Ascari", 9: "Variante Ascari", 10: "Variante Ascari",
                    11: "Curva Alboreto (Parabolica)"},
        short_name="Monza", country="Italy", event_name="Italian Grand Prix", race_laps=53, grid_size=20,
    ),
    "montreal": CircuitConfig(
        id="montreal", name="Circuit Gilles Villeneuve", openf1_name="Montreal", multiviewer_key=23,
        reference_lap="montreal_lap.json", length_m=4361, reference_year=2025,   # 2025: dry race (2024 was wet)
        turn_names={1: "Senna Curve", 2: "Senna Curve", 3: "Turns 3–4", 4: "Turns 3–4", 5: "Turn 5",
                    6: "Turns 6–7", 7: "Turns 6–7", 8: "Turns 8–9", 9: "Turns 8–9", 10: "Hairpin",
                    11: "Turn 11 (Casino Straight)", 12: "Turn 12",
                    13: "Final chicane (Wall of Champions)", 14: "Final chicane (Wall of Champions)"},
        short_name="Montreal", country="Canada", event_name="Canadian Grand Prix", race_laps=70, grid_size=20,
    ),
}


# ----------------------------------------------------------------------------- 1. fetch + cache
def _parse_time(ts: str) -> datetime:
    return datetime.fromisoformat(ts)


def fetch_raw(cfg: CircuitConfig, refresh: bool = False) -> None:
    """Download race control for every past session and the MultiViewer track points. Cached."""
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    rc_path, pts_path = RAW_DIR / f"{cfg.id}_rc.json", RAW_DIR / f"{cfg.id}_track_points.json"

    if refresh or not rc_path.exists():
        now = datetime.now(timezone.utc)
        with OpenF1Client() as client:
            sessions = [s for s in client.sessions(circuit_short_name=cfg.openf1_name)
                        if s["year"] >= FIRST_SEASON and _parse_time(s["date_start"]) < now]
            out = [{
                "session_key": s["session_key"], "year": s["year"], "session_name": s["session_name"],
                "session_type": s["session_type"], "date_start": s["date_start"],
                "messages": client.race_control(s["session_key"]),
            } for s in sessions]
        rc_path.write_text(json.dumps(out, indent=1))
        print(f"[{cfg.id}] race control: {sum(len(s['messages']) for s in out)} messages, {len(out)} sessions")

    if refresh or not pts_path.exists():
        resp = httpx.get(MULTIVIEWER_URL.format(key=cfg.multiviewer_key, year=cfg.reference_year),
                         headers={"User-Agent": "Mozilla/5.0"}, timeout=30)
        resp.raise_for_status()
        d = resp.json()
        point = lambda c: {"number": c["number"], "x": round(c["trackPosition"]["x"]),  # noqa: E731
                           "y": round(c["trackPosition"]["y"])}
        pts_path.write_text(json.dumps({
            "source": f"MultiViewer circuit API, circuit {cfg.multiviewer_key}, {cfg.reference_year}",
            "units": "same x/y grid as OpenF1 location (1 unit = 0.1 m)",
            "rotation_deg": d.get("rotation", 0),
            "turns": [point(c) for c in d["corners"]],
            "marshal_sectors": [point(c) for c in d["marshalSectors"]],
        }, indent=1))
        print(f"[{cfg.id}] track points: {len(d['corners'])} turns, {len(d['marshalSectors'])} marshal sectors")


def load_raw(cfg: CircuitConfig) -> tuple[list[dict], dict, list[dict]]:
    """(sessions with messages, track points, reference-lap samples) from the cache."""
    sessions = json.loads((RAW_DIR / f"{cfg.id}_rc.json").read_text())
    points = json.loads((RAW_DIR / f"{cfg.id}_track_points.json").read_text())
    lap = json.loads((RAW_DIR / cfg.reference_lap).read_text())["samples"]
    return sessions, points, lap


# ----------------------------------------------------------------------------- 2. extract + classify
TURN_RE = re.compile(r"TURN\s*(\d+)")
CAR_RE = re.compile(r"(\d+) \(")
YELLOW_MERGE_S = 300        # repeat yellows in the same marshal sector within 5 min = one event
YELLOW_WARNING_S = 30       # a yellow in the sector just before another yellow = warning only

# (pattern, incident_type, severity_score, loss_relevant, rule). First match wins. Order matters.
# severity_score is a regex-path estimate (0..1) of how physical the event was, not a measured value.
RULES = [
    (re.compile(r"TRACK LIMITS"), "track_limits", 0.05, False, "track_limits"),
    (re.compile(r"LEAVING THE TRACK AND GAINING"), "track_limits", 0.05, False, "gaining_advantage"),
    (re.compile(r"COLLISION"), "collision", 0.6, True, "collision"),
    (re.compile(r"FORCING ANOTHER DRIVER OFF"), "collision", 0.4, True, "forced_off"),
    (re.compile(r"REJOIN"), "spin", 0.4, True, "unsafe_rejoin"),
    (re.compile(r"\bSPUN\b"), "spin", 0.3, False, "spun_and_continued"),
    (re.compile(r"OFF TRACK AND CONTINUED"), "spin", 0.2, False, "off_track_and_continued"),
    (re.compile(r"DEBRIS"), "debris", 0.3, True, "debris"),
    (re.compile(r"CRASH|STOPPED|BARRIER"), "crash", 0.7, True, "crash_or_stopped"),
    (re.compile(r"PIT|IMPEDING|DELTA|FAILING TO|INFRINGEMENT|SPEEDING|UNSAFE RELEASE|START"),
     "administrative", 0.0, False, "administrative"),
    # A steward incident at a named turn with no stated reason: some on-track contact or off.
    (re.compile(r"INCIDENT"), "collision", 0.4, True, "incident_no_reason"),
]


@dataclass
class Event:
    session: dict
    message: dict
    incident_type: str
    severity_score: float
    loss_relevant: bool
    rule: str
    turn: int | None = None
    sector: int | None = None
    car_numbers: list[int] = field(default_factory=list)


def classify(text: str) -> tuple[str, float, bool, str]:
    for pattern, kind, sev, loss, rule in RULES:
        if pattern.search(text):
            return kind, sev, loss, rule
    return "administrative", 0.0, False, "unmatched"


def _cars(text: str) -> list[int]:
    return [int(c) for c in CAR_RE.findall(text.split("INVOLVING", 1)[-1])]


def _yellow_events(session: dict, n_sectors: int) -> list[Event]:
    """Merge repeat yellow flags per marshal sector and drop the warning yellow shown one sector early."""
    flags = sorted((m for m in session["messages"]
                    if m.get("flag") in ("YELLOW", "DOUBLE YELLOW") and m.get("sector")), key=lambda m: m["date"])
    groups: list[dict] = []
    last: dict[int, dict] = {}
    for m in flags:
        t, sec = _parse_time(m["date"]), m["sector"]
        g = last.get(sec)
        if g and (t - g["last"]).total_seconds() <= YELLOW_MERGE_S:
            g["last"], g["double"] = t, g["double"] or m["flag"] == "DOUBLE YELLOW"
            continue
        g = {"first_msg": m, "first": t, "last": t, "double": m["flag"] == "DOUBLE YELLOW", "sector": sec}
        groups.append(g)
        last[sec] = g

    def warning_only(g: dict) -> bool:
        nxt = g["sector"] % n_sectors + 1
        return any(f["sector"] == nxt and abs((_parse_time(f["date"]) - g["first"]).total_seconds()) <= YELLOW_WARNING_S
                   for f in flags)

    return [Event(session, g["first_msg"],
                  "stopped" if g["double"] else "flag_only", 0.5 if g["double"] else 0.3, True,
                  "double_yellow" if g["double"] else "yellow", sector=g["sector"])
            for g in groups if not warning_only(g)]


def extract_events(sessions: list[dict], n_sectors: int) -> tuple[list[Event], dict]:
    """All events, each counted once, plus counts of what could not be placed on the track."""
    events: list[Event] = []
    skipped = {"no_location_admin": 0, "no_location_loss_relevant": 0,
               "safety_car": 0, "virtual_safety_car": 0, "red_flag": 0}
    for s in sessions:
        seen: dict[tuple, Event] = {}
        for m in s["messages"]:
            text = m.get("message") or ""
            if m.get("flag") == "RED":
                skipped["red_flag"] += 1
            if "VIRTUAL SAFETY CAR DEPLOYED" in text:
                skipped["virtual_safety_car"] += 1
            elif "SAFETY CAR DEPLOYED" in text:
                skipped["safety_car"] += 1
            is_steward = "INCIDENT" in text
            if not (is_steward or "TRACK LIMITS" in text or "OFF TRACK" in text or "SPUN" in text):
                continue
            kind, sev, loss, rule = classify(text)
            turn = TURN_RE.search(text)
            cars = _cars(text) if is_steward else [int(c) for c in CAR_RE.findall(text)[:1]]
            if not turn:
                skipped["no_location_loss_relevant" if loss else "no_location_admin"] += 1
                continue
            turn = int(turn.group(1))
            # Same event repeated (noted -> under investigation -> decision, or a CORRECTION: re-post)
            if is_steward:
                key = ("incident", turn, frozenset(cars))
            elif rule == "track_limits":
                key = ("track_limits", text)
            else:
                key = ("excursion", turn, tuple(cars))          # SPUN / OFF TRACK / CORRECTION
            if key in seen:
                first = seen[key]
                if first.rule == "incident_no_reason" and rule != "incident_no_reason":
                    # a later message gives the reason: keep the first time, take the better label
                    first.incident_type, first.severity_score, first.loss_relevant, first.rule = kind, sev, loss, rule
                continue
            seen[key] = Event(s, m, kind, sev, loss, rule, turn=turn, car_numbers=cars)
            events.append(seen[key])
        events.extend(_yellow_events(s, n_sectors))
    return events, skipped


# ----------------------------------------------------------------------------- 3. place + 4. records
SESSION_CODES = {"Practice 1": "FP1", "Practice 2": "FP2", "Practice 3": "FP3", "Qualifying": "Q",
                 "Sprint Qualifying": "SQ", "Sprint Shootout": "SQ", "Sprint": "S", "Race": "R"}


def kinetic_energy_kj(speed_kph: float, mass_kg: float = CAR_MASS_KG) -> float:
    """E_k = ½ m v², v in m/s. 331 km/h and 798 kg -> about 3,372 kJ."""
    v = speed_kph / 3.6
    return 0.5 * mass_kg * v * v / 1000


def sector_to_turn(geo: dict, turns: list[dict], marshals: list[dict]) -> dict[int, int]:
    """Marshal sector -> turn nearest its marshal post along the lap (checked: Montreal 3/6 exact and
    5/6 within one corner, Monza 2/3 in the right zone, against race control's own named-turn messages)."""
    from services.zones import nearest_index

    n = len(geo["v"])
    t_idx = {t["number"]: nearest_index(geo, t["x"], t["y"]) for t in turns}
    out = {}
    for m in marshals:
        i = nearest_index(geo, m["x"], m["y"])
        out[m["number"]] = min(t_idx, key=lambda t: min(abs(t_idx[t] - i), n - abs(t_idx[t] - i)))
    return out


def to_records(cfg: CircuitConfig, events: list[Event], zones: list[dict], geo: dict, norm,
               turns: list[dict], marshals: list[dict]) -> list[dict]:
    """Incident records in the ARCHITECTURE.md §4.4 schema, sorted by time."""
    from services.zones import nearest_index, zone_for_frac

    turn_xy = {t["number"]: (t["x"], t["y"]) for t in turns}
    to_turn = sector_to_turn(geo, turns, marshals)
    records, counters = [], {}
    for e in sorted(events, key=lambda e: e.message["date"]):
        s = e.session
        turn = e.turn if e.turn is not None else to_turn[e.sector]
        method, confidence = ("turn_in_message", "high") if e.turn is not None else ("marshal_sector", "medium")
        x_raw, y_raw = turn_xy[turn]
        i = nearest_index(geo, x_raw, y_raw)
        lap_frac = float(geo["frac"][i])
        zone = zone_for_frac(zones, lap_frac)
        nx, ny = norm(x_raw, y_raw)
        code = SESSION_CODES.get(s["session_name"], s["session_name"])
        counters[(s["year"], code)] = counters.get((s["year"], code), 0) + 1
        records.append({
            "incident_id": f"{cfg.id}-{s['year']}-{code}-{counters[(s['year'], code)]:04d}",
            "circuit": cfg.id, "season": s["year"], "session_type": s["session_name"],
            "session_key": s["session_key"],
            "lap": e.message.get("lap_number"), "occurred_at": e.message["date"],
            "raw_message": e.message.get("message"),
            "car_numbers": e.car_numbers,
            "turn_number": turn,
            "incident_type": e.incident_type,
            "severity_score": e.severity_score,
            "loss_relevant": e.loss_relevant,
            "x": round(float(nx), 4), "y": round(float(ny), 4), "lap_frac": round(lap_frac, 4),
            "zone_id": zone["zone_id"],
            "geo_method": method, "geo_confidence": confidence,
            "marshal_sector": e.sector,
            "entry_speed_kph": zone["v_entry_kph"],
            "kinetic_energy_kj": round(kinetic_energy_kj(zone["v_entry_kph"]), 1),
            "extraction": {"method": "regex", "rule": e.rule},
        })
    return records


def coverage(sessions: list[dict], records: list[dict], skipped: dict) -> dict:
    """What the data covers and what could not be placed (feeds the assumptions drawer, §10.3 H+30)."""
    by_type: dict[str, int] = {}
    for r in records:
        by_type[r["incident_type"]] = by_type.get(r["incident_type"], 0) + 1
    return {
        "seasons": sorted({s["year"] for s in sessions}),
        "sessions": [{"session_key": s["session_key"], "season": s["year"], "session_type": s["session_name"]}
                     for s in sessions],
        "race_control_messages": sum(len(s["messages"]) for s in sessions),
        "incidents": len(records),
        "loss_relevant": sum(r["loss_relevant"] for r in records),
        "by_type": dict(sorted(by_type.items(), key=lambda kv: -kv[1])),
        "by_geo_method": {m: sum(r["geo_method"] == m for r in records) for m in ("turn_in_message", "marshal_sector")},
        "not_placed": skipped,
    }
