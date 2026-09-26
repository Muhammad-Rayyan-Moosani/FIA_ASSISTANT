"""
Step 1 -- OpenF1 extractor
==========================

Pulls real Grand Prix race data from the OpenF1 API (https://openf1.org, free
historical data from 2023) and detects impacts from car telemetry:

    data/telemetry_impacts/tracks/<track_id>.json      track geometry + ~12 equal zones
    data/telemetry_impacts/incidents/<track_id>.json   detected crashes with impact speed
    data/telemetry_impacts/extraction_report.json      what was pulled / skipped / why

This is an alternative, telemetry-based detector. The app itself runs on the
race-control pipeline (`python -m scripts.ingest monza`), which owns
data/tracks/ and data/incidents/; writing here keeps the two from overwriting
each other. Measured impact speeds from this detector can later feed Step 2.

Run it on YOUR machine (needs internet); Step 2 stays fully offline:

    python backend/openf1_extract.py --years 2025 --max-races 3     # quick test
    python backend/openf1_extract.py                                # 2023 -> this year

Responses are cached in data/telemetry_impacts/.openf1_cache, so re-runs and resumes are free.
The free tier allows 30 requests/minute, so a full multi-season run takes
roughly an hour the first time.  Standard library + NumPy only.

HOW INCIDENTS ARE DETECTED  (OpenF1 has no "crash" table -- this is inferred)
-----------------------------------------------------------------------------
1. Candidate windows come from race control: incident messages (CarEvent, or
   "Other" messages mentioning INCIDENT / COLLISION / SPUN / OFF TRACK / STOPPED;
   every car number in the text).  Stewards' notes are stamped minutes after the
   crash, so their window is the mentioned car's lap named in the message, not
   the message time.  Also each retiring driver's final lap (session_result.dnf)
   and, with --deep, the ~2 min before every Safety Car / VSC / Red Flag for ALL cars.
2. Inside each window car_data (speed, ~3.7 Hz) is scanned for either
     a) STOP : speed falls from >=100 km/h to <=15 km/h within 4 s and stays
               slow, with a peak single-sample deceleration >= 5 g (normal braking measures
               <= ~2 g at this sample rate), or
     b) HIT  : a single-step deceleration >= 10 g and >= 60 km/h lost
               (the car hit something and carried on).
3. Impact speed = speed just before the largest single-step deceleration.
   Impact position = interpolated location (x, y) at that instant.
4. An event is kept only if corroborated: a race-control incident message for
   that car (in its lap window), the car retiring on that lap, a yellow flag
   within 90 s, a SC/VSC/Red within 4 min, or a very violent impact (>= 15 g).
5. Position -> zone: the impact point is projected onto that race's fastest
   lap of the winner (racing line) and converted to a fraction of lap distance;
   zones are equal-distance slices of the lap.  This is frame-independent, so
   different seasons at the same circuit line up.

KNOWN LIMITS (be honest about these in your write-up)
-----------------------------------------------------
* Detected from telemetry, not an official crash log: recall is limited to
  windows above, and car-to-car contact is indistinguishable from barrier hits.
* 3.7 Hz sampling smears very short impacts; impact speed is approximate.
* OpenF1 has NO barrier data.  Barrier type per zone is a heuristic
  (street circuit -> concrete; fast permanent zones -> TecPro; slow -> tyre
  wall).  Override it in data/telemetry_impacts/barrier_overrides.json, format:
      {"monza": {"default": "tecpro", "monza-z03": "safer"}}
* Race sessions only (no sprints, practice, qualifying); exposure counts every
  lap equally, including safety-car laps.
* Sessions whose reference lap length differs >3% from the latest layout are
  dropped (circuit layout changed).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

import numpy as np

BASE_URL = "https://api.openf1.org/v1"
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
G = 9.80665


# --------------------------------------------------------------------------- #
# HTTP client (cached, rate limited)
# --------------------------------------------------------------------------- #


class OpenF1Client:
    def __init__(self, cache_dir: Path, requests_per_minute: float = 27.0, retries: int = 5):
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.min_interval = 60.0 / requests_per_minute
        self.retries = retries
        self._last = 0.0
        self.n_net = 0
        self.n_cache = 0

    def get(self, endpoint: str, *filters: tuple[str, Any]) -> list[dict]:
        """filters are (key, value) pairs; key may carry an operator, e.g. ("date>=", "2024-03-02T15:05:30")."""
        qs = "&".join(f"{k}={quote(str(v), safe=':.-_T')}" for k, v in filters)
        url = f"{BASE_URL}/{endpoint}" + (f"?{qs}" if qs else "")
        cache = self.cache_dir / (hashlib.sha1(url.encode()).hexdigest() + ".json")
        if cache.exists():
            self.n_cache += 1
            return json.loads(cache.read_text())

        delay = 20.0
        for attempt in range(self.retries):
            wait = self.min_interval - (time.monotonic() - self._last)
            if wait > 0:
                time.sleep(wait)
            self._last = time.monotonic()
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "f1-insurance-step1/1.0",
                                                            "Accept": "application/json"})
                with urllib.request.urlopen(req, timeout=90) as r:
                    data = json.loads(r.read().decode("utf-8"))
                self.n_net += 1
                data = data if isinstance(data, list) else []
                cache.write_text(json.dumps(data))
                return data
            except urllib.error.HTTPError as e:
                if e.code == 404:                        # OpenF1 answers 404 for "no rows"
                    self.n_net += 1
                    cache.write_text("[]")
                    return []
                if e.code == 429 or e.code >= 500:
                    time.sleep(delay)
                    delay = min(delay * 2, 120)
                    continue
                raise
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                time.sleep(delay)
                delay = min(delay * 2, 120)
        raise RuntimeError(f"OpenF1 request failed after {self.retries} attempts: {url}")


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #

_TS = re.compile(r"^(.*?\d\d:\d\d:\d\d)(\.\d+)?(.*)$")


def parse_ts(s: str) -> float:
    """ISO-8601 -> epoch seconds (handles any fraction length on Python 3.9+)."""
    m = _TS.match(s.replace("Z", "+00:00"))
    head, frac, tail = m.group(1), (m.group(2) or ".0"), m.group(3) or "+00:00"
    return datetime.fromisoformat(f"{head}{frac[:7].ljust(7, '0')}{tail}").timestamp()


def fmt_ts(t: float) -> str:
    """epoch seconds -> naive-UTC string accepted by OpenF1 date filters."""
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3]


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def merge_windows(wins: list[tuple[float, float]], gap: float = 5.0) -> list[tuple[float, float]]:
    out: list[list[float]] = []
    for a, b in sorted(wins):
        if out and a <= out[-1][1] + gap:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return [(a, b) for a, b in out]


# --------------------------------------------------------------------------- #
# Impact detection (pure function on a speed trace -- unit-testable)
# --------------------------------------------------------------------------- #


def detect_impacts(t, v, *, min_entry_kph: float = 100.0, stop_kph: float = 15.0,
                   stop_window_s: float = 4.0, min_decel_g: float = 5.0,
                   hard_hit_g: float = 10.0, hard_hit_dv_kph: float = 60.0,
                   merge_s: float = 8.0) -> list[dict]:
    t, v = np.asarray(t, float), np.asarray(v, float)
    if len(t) < 4:
        return []
    dt, dv = np.diff(t), v[:-1] - v[1:]
    ok = (dt >= 0.05) & (dt <= 0.6)
    g = np.zeros_like(dt)
    g[ok] = dv[ok] / dt[ok] / 3.6 / G

    cands: list[tuple[int, str]] = []
    for i in np.where(ok & (g >= hard_hit_g) & (dv >= hard_hit_dv_kph))[0]:
        cands.append((int(i), "hit"))

    prev = -10
    for j in np.where(v <= stop_kph)[0]:                 # first sample of each slow run
        if j == prev + 1:
            prev = j
            continue
        prev = j
        lo = int(np.searchsorted(t, t[j] - stop_window_s))
        if j <= lo or v[lo:j + 1].max() < min_entry_kph:
            continue
        hi = int(np.searchsorted(t, t[j] + 2.0, side="right"))
        if v[j:hi].max() > 60:                            # not actually stopped
            continue
        k = lo + int(np.argmax(g[lo:j]))
        if g[k] >= min_decel_g:
            cands.append((k, "stop"))

    events: list[dict] = []
    for i, kind in sorted(cands):
        lo = int(np.searchsorted(t, t[i] - stop_window_s))
        ev = {"t": float(t[i]), "impact_speed_kph": float(v[i]),
              "entry_speed_kph": float(v[lo:i + 1].max()), "peak_decel_g": float(g[i]), "kind": kind}
        if events and ev["t"] - events[-1]["t"] <= merge_s:
            last = events[-1]
            if ev["peak_decel_g"] > last["peak_decel_g"]:
                ev["kind"] = "stop+hit" if kind != last["kind"] else kind
                events[-1] = ev
            elif kind != last["kind"]:
                last["kind"] = "stop+hit"
            continue
        events.append(ev)
    return events


# --------------------------------------------------------------------------- #
# Reference lap (racing line) for a session
# --------------------------------------------------------------------------- #


@dataclass
class Reference:
    session_key: int
    driver: int
    t0: float
    t1: float
    xy: np.ndarray            # (N, 2) racing line, OpenF1 units (0.1 m)
    tt: np.ndarray            # (N,) epoch seconds
    cum: np.ndarray           # (N,) cumulative distance
    total: float
    speed: np.ndarray | None = None

    def project(self, x: float, y: float) -> tuple[float, float]:
        """-> (fraction of lap distance in [0,1], distance from racing line)."""
        a, b = self.xy[:-1], self.xy[1:]
        ab = b - a
        L2 = np.maximum((ab ** 2).sum(1), 1e-9)
        u = np.clip((((x, y) - a) * ab).sum(1) / L2, 0, 1)
        proj = a + ab * u[:, None]
        d = np.hypot(proj[:, 0] - x, proj[:, 1] - y)
        i = int(np.argmin(d))
        pos = self.cum[i] + u[i] * math.sqrt(L2[i])
        return float(pos / self.total), float(d[i])


def build_reference(client: OpenF1Client, session_key: int, driver: int) -> Reference | None:
    laps = client.get("laps", ("session_key", session_key), ("driver_number", driver))
    good = [l for l in laps if l.get("lap_duration") and not l.get("is_pit_out_lap")
            and l.get("date_start") and (l.get("lap_number") or 0) >= 2]
    if not good:
        return None
    best = min(l["lap_duration"] for l in good)
    lap = min((l for l in good if l["lap_duration"] <= best * 1.10), key=lambda l: l["lap_duration"])
    t0 = parse_ts(lap["date_start"])
    t1 = t0 + float(lap["lap_duration"])
    loc = client.get("location", ("session_key", session_key), ("driver_number", driver),
                     ("date>=", fmt_ts(t0)), ("date<=", fmt_ts(t1)))
    if len(loc) < 100:
        return None
    tt = np.array([parse_ts(r["date"]) for r in loc])
    xy = np.array([[r["x"], r["y"]] for r in loc], float)
    order = np.argsort(tt)
    tt, xy = tt[order], xy[order]
    keep = np.r_[True, np.hypot(*np.diff(xy, axis=0).T) > 0]     # drop stationary duplicates
    tt, xy = tt[keep], xy[keep]
    cum = np.r_[0.0, np.cumsum(np.hypot(*np.diff(xy, axis=0).T))]
    return Reference(session_key, driver, t0, t1, xy, tt, cum, float(cum[-1]))


def add_reference_speeds(client: OpenF1Client, ref: Reference) -> None:
    car = client.get("car_data", ("session_key", ref.session_key), ("driver_number", ref.driver),
                     ("date>=", fmt_ts(ref.t0)), ("date<=", fmt_ts(ref.t1)))
    if len(car) < 50:
        return
    ct = np.array([parse_ts(r["date"]) for r in car])
    cv = np.array([r["speed"] for r in car], float)
    o = np.argsort(ct)
    ref.speed = np.interp(ref.tt, ct[o], cv[o])


# --------------------------------------------------------------------------- #
# One race
# --------------------------------------------------------------------------- #

_CAR_RE = re.compile(r"\b(\d{1,2}) \([A-Z]{3}\)")
_TURN_RE = re.compile(r"TURN (\d+)")
_INCIDENT_WORDS = ("INCIDENT", "COLLISION", "SPUN", "OFF TRACK", "STOPPED", "CONTACT", "ACCIDENT", "CRASH")


def _telemetry_windows(client, sk, windows_by_driver, all_driver_windows):
    """-> {driver: (t, v)} arrays covering every requested window."""
    rows: dict[int, list[tuple[float, float]]] = {}

    def ingest(data):
        for r in data:
            if r.get("speed") is None:
                continue
            rows.setdefault(int(r["driver_number"]), []).append((parse_ts(r["date"]), float(r["speed"])))

    for d, wins in windows_by_driver.items():
        for a, b in merge_windows(wins):
            ingest(client.get("car_data", ("session_key", sk), ("driver_number", d),
                              ("date>=", fmt_ts(a)), ("date<=", fmt_ts(b))))
    for a, b in merge_windows(all_driver_windows):
        ingest(client.get("car_data", ("session_key", sk), ("date>=", fmt_ts(a)), ("date<=", fmt_ts(b))))

    out = {}
    for d, lst in rows.items():
        arr = np.array(sorted(set(lst)))
        out[d] = (arr[:, 0], arr[:, 1])
    return out


def process_race(client: OpenF1Client, meeting: dict, session: dict, deep: bool, log) -> dict | None:
    sk = session["session_key"]
    results = client.get("session_result", ("session_key", sk))
    if not results:
        log(f"  no session_result for session {sk}; skipping")
        return None
    drivers = client.get("drivers", ("session_key", sk))
    acr = {d["driver_number"]: d.get("name_acronym") for d in drivers}
    grid = len({d["driver_number"] for d in drivers}) or 20
    winner = min((r for r in results if r.get("position")), key=lambda r: r["position"])
    race_laps = int(max((r.get("number_of_laps") or 0) for r in results))
    dnf = [r["driver_number"] for r in results if r.get("dnf")]
    rc = client.get("race_control", ("session_key", sk))

    t_start = next((parse_ts(r["date"]) for r in rc if r.get("category") == "SessionStatus"
                    and "STARTED" in (r.get("message") or "").upper()), parse_ts(session["date_start"]))
    t_end = max((parse_ts(r["date"]) for r in rc if r.get("flag") == "CHEQUERED"),
                default=parse_ts(session["date_end"]))

    # ---- candidate windows ------------------------------------------------- #
    per_driver: dict[int, list[tuple[float, float]]] = {}
    all_driver: list[tuple[float, float]] = []
    msg_wins: dict[int, list[tuple[float, float, str, int | None]]] = {}   # driver -> (a, b, text, lap)
    sc_times: list[float] = []
    yellow_times: list[float] = []
    laps_cache: dict[int, list[dict]] = {}

    def driver_laps(d: int) -> list[dict]:
        if d not in laps_cache:
            laps_cache[d] = [l for l in client.get("laps", ("session_key", sk), ("driver_number", d))
                             if l.get("lap_number")]
        return laps_cache[d]

    def lap_window(d: int, n: int) -> tuple[float, float] | None:
        by = {l["lap_number"]: l for l in driver_laps(d)}
        cur = by.get(n)
        if cur is None:
            return None
        prev = by.get(n - 1)
        a = parse_ts(prev["date_start"]) if prev and prev.get("date_start") else (
            parse_ts(cur["date_start"]) if cur.get("date_start") else t_start)
        a = max(a, t_start) - 3
        b = (parse_ts(cur["date_start"]) if cur.get("date_start") else a) + float(cur.get("lap_duration") or 150) + 3
        return a, b

    for r in rc:
        ts = parse_ts(r["date"])
        msg = (r.get("message") or "").upper()
        cat = r.get("category")
        if r.get("flag") in ("YELLOW", "DOUBLE YELLOW") and r.get("scope") == "Sector":
            yellow_times.append(ts)
        incident_like = cat == "CarEvent" or (cat == "Other" and any(w in msg for w in _INCIDENT_WORDS))
        if incident_like:
            nums = {int(n) for n in _CAR_RE.findall(msg)}
            if r.get("driver_number") is not None:
                nums.add(int(r["driver_number"]))
            for n in nums:
                wins = [(ts - 90, ts + 15)] if cat == "CarEvent" else []       # live messages: near the event
                if r.get("lap_number"):                                       # stewards' notes: use the lap
                    lw = lap_window(n, int(r["lap_number"]))
                    if lw:
                        wins.append(lw)
                for a, b in wins:
                    per_driver.setdefault(n, []).append((a, b))
                    msg_wins.setdefault(n, []).append((a, b, msg, r.get("lap_number")))
        is_sc = cat == "SafetyCar" and "DEPLOYED" in msg
        is_red = r.get("flag") == "RED" and r.get("scope") in (None, "Track")
        if is_sc or is_red:
            sc_times.append(ts)
            if deep:
                all_driver.append((ts - 110, ts + 5))
    dnf_windows: dict[int, tuple[float, float]] = {}
    for d in dnf:
        laps = [l for l in driver_laps(d) if l.get("date_start")]
        if laps:
            last = max(laps, key=lambda l: l["lap_number"])
            a = parse_ts(last["date_start"])
            dnf_windows[d] = (a - 3, a + 140)
            per_driver.setdefault(d, []).append(dnf_windows[d])

    tele = _telemetry_windows(client, sk, per_driver, all_driver)

    # ---- detect + corroborate --------------------------------------------- #
    raw: list[dict] = []
    for d, (t, v) in tele.items():
        for ev in detect_impacts(t, v):
            if not (t_start - 5 <= ev["t"] <= t_end + 5):
                continue
            evidence = []
            if any(a <= ev["t"] <= b for a, b, _, _ in msg_wins.get(d, [])):
                evidence.append("race_control")
            if any(0 <= yt - ev["t"] <= 90 for yt in yellow_times):
                evidence.append("yellow_flag")
            if d in dnf_windows and dnf_windows[d][0] <= ev["t"] <= dnf_windows[d][1]:
                evidence.append("retired")
            if any(0 <= st - ev["t"] <= 240 for st in sc_times):
                evidence.append("safety_car_or_red")
            if ev["peak_decel_g"] >= 15:
                evidence.append("violent_impact")
            if not evidence:
                continue
            raw.append({**ev, "driver": d, "evidence": evidence})

    incidents = []
    for ev in raw:
        loc = client.get("location", ("session_key", sk), ("driver_number", ev["driver"]),
                         ("date>=", fmt_ts(ev["t"] - 3)), ("date<=", fmt_ts(ev["t"] + 3)))
        if len(loc) < 2:
            continue
        lt = np.array([parse_ts(r["date"]) for r in loc])
        o = np.argsort(lt)
        x = float(np.interp(ev["t"], lt[o], np.array([r["x"] for r in loc], float)[o]))
        y = float(np.interp(ev["t"], lt[o], np.array([r["y"] for r in loc], float)[o]))
        near = [(txt, lp) for a, b, txt, lp in msg_wins.get(ev["driver"], []) if a <= ev["t"] <= b]
        turn = next((int(m.group(1)) for txt, _ in near if (m := _TURN_RE.search(txt))), None)
        lap = next((int(lp) for _, lp in near if lp), None)
        incidents.append({**ev, "x": x, "y": y, "turn": turn, "lap_number": lap})

    # reference lap is needed for every session (zone fractions + circuit geometry)
    ref = build_reference(client, sk, int(winner["driver_number"]))
    if ref is None:
        log(f"  could not build a reference lap for session {sk}; skipping")
        return None

    for inc in incidents:
        inc["frac"], inc["off_line"] = ref.project(inc["x"], inc["y"])
        inc["driver_code"] = acr.get(inc["driver"])

    return {"session_key": sk, "meeting_key": meeting["meeting_key"], "year": session["year"],
            "circuit_key": meeting["circuit_key"], "circuit_short_name": meeting["circuit_short_name"],
            "circuit_type": meeting.get("circuit_type", ""), "country": meeting.get("country_name"),
            "meeting_name": meeting["meeting_name"], "race_laps": race_laps, "grid_size": grid,
            "ref": ref, "incidents": incidents, "n_windows": sum(len(w) for w in per_driver.values()) + len(all_driver)}


# --------------------------------------------------------------------------- #
# Zones, barriers, output
# --------------------------------------------------------------------------- #


def heuristic_barrier(circuit_type: str, mean_speed: float | None) -> str:
    if "street" in circuit_type.lower():
        return "Concrete"
    if mean_speed is not None and mean_speed >= 200:
        return "TecPro"
    return "Tyre wall"


def build_track(races: list[dict], n_zones: int, overrides: dict, client: OpenF1Client, log) -> tuple[dict, list[dict], dict]:
    races = sorted(races, key=lambda r: r["year"])
    latest = races[-1]
    base = latest["ref"]
    add_reference_speeds(client, base)
    kept, dropped = [], []
    for r in races:
        (kept if abs(r["ref"].total / base.total - 1) <= 0.03 else dropped).append(r)
    track_id = slug(latest["circuit_short_name"])
    ov = overrides.get(track_id, {})

    frac_v = base.cum / base.total
    zones = []
    for k in range(n_zones):
        lo, hi = k / n_zones, (k + 1) / n_zones
        m = (frac_v >= lo) & (frac_v <= hi)
        sp = base.speed[m] if base.speed is not None and m.any() else None
        mid = base.xy[np.searchsorted(frac_v, (lo + hi) / 2).clip(0, len(frac_v) - 1)]
        mean_sp = float(sp.mean()) if sp is not None else None
        zid = f"{track_id}-z{k + 1:02d}"
        barrier = ov.get(zid) or ov.get("default")
        zones.append({
            "zone_id": zid, "name": f"Zone {k + 1}", "frac_start": round(lo, 4), "frac_end": round(hi, 4),
            "x": int(mid[0]), "y": int(mid[1]),
            "corner_speed_kph": round(mean_sp, 1) if mean_sp is not None else None,
            "min_speed_kph": round(float(sp.min()), 1) if sp is not None else None,
            "max_speed_kph": round(float(sp.max()), 1) if sp is not None else None,
            "barrier_type": barrier or heuristic_barrier(latest["circuit_type"], mean_sp),
            "barrier_source": "override" if barrier else "heuristic",
        })

    step = max(1, len(base.xy) // 300)
    track = {
        "track_id": track_id, "name": latest["meeting_name"], "circuit_key": latest["circuit_key"],
        "circuit_short_name": latest["circuit_short_name"], "country": latest["country"],
        "circuit_type": latest["circuit_type"], "laps": int(round(np.median([r["race_laps"] for r in kept]))),
        "grid_size": int(round(np.median([r["grid_size"] for r in kept]))), "races_per_season": 1,
        "seasons_observed": len(kept), "sessions_used": [{"year": r["year"], "session_key": r["session_key"]} for r in kept],
        "coordinate_units": "0.1 m (OpenF1 x/y)", "lap_length_m": round(base.total / 10, 0),
        "polyline": [[int(x), int(y)] for x, y in base.xy[::step]],
        "zones": zones, "source": "OpenF1 (api.openf1.org)", "synthetic": False,
        "extracted_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }

    incidents, n_far = [], 0
    for r in kept:
        for n, inc in enumerate(r["incidents"], 1):
            if inc["off_line"] > 1500:                     # > 150 m from racing line: pit lane / other layout
                n_far += 1
                continue
            zone = zones[min(int(inc["frac"] * n_zones), n_zones - 1)]
            incidents.append({
                "incident_id": f"{track_id}-{r['year']}-{inc['driver']}-{n}", "track_id": track_id,
                "zone_id": zone["zone_id"], "season": r["year"], "session_key": r["session_key"],
                "driver_number": inc["driver"], "driver": inc.get("driver_code"), "lap_number": inc["lap_number"],
                "turn": inc["turn"], "kind": inc["kind"], "evidence": inc["evidence"],
                "corner_speed_kph": zone["corner_speed_kph"], "impact_speed_kph": round(inc["impact_speed_kph"], 1),
                "entry_speed_kph": round(inc["entry_speed_kph"], 1), "peak_decel_g": round(inc["peak_decel_g"], 1),
                "barrier_type": zone["barrier_type"], "x": round(inc["x"]), "y": round(inc["y"]),
                "frac": round(inc["frac"], 4),
            })
    info = {"track_id": track_id, "races_used": len(kept), "races_dropped_layout": [r["year"] for r in dropped],
            "incidents": len(incidents), "incidents_dropped_off_line": n_far}
    return track, incidents, info


# --------------------------------------------------------------------------- #
# Orchestration / CLI
# --------------------------------------------------------------------------- #


def extract(years, out_dir: Path, circuits=None, deep=False, max_races=None, n_zones=12,
            rpm: float = 27.0, client: OpenF1Client | None = None, log=print) -> dict:
    out_dir = Path(out_dir)
    (out_dir / "tracks").mkdir(parents=True, exist_ok=True)
    (out_dir / "incidents").mkdir(parents=True, exist_ok=True)
    client = client or OpenF1Client(out_dir / ".openf1_cache", rpm)
    ov_path = out_dir / "barrier_overrides.json"
    overrides = json.loads(ov_path.read_text()) if ov_path.exists() else {}

    meetings = []
    for y in years:
        meetings += [m for m in client.get("meetings", ("year", y))
                     if "grand prix" in (m.get("meeting_name") or "").lower() and not m.get("is_cancelled")]
    if circuits:
        want = {slug(c) for c in circuits}
        meetings = [m for m in meetings if slug(m["circuit_short_name"]) in want or slug(m.get("location", "")) in want]
    meetings.sort(key=lambda m: m["date_start"])
    if max_races:
        meetings = meetings[-max_races:]
    log(f"{len(meetings)} Grand Prix weekends to process")

    now = time.time()
    by_circuit: dict[int, list[dict]] = {}
    skipped = []
    for i, m in enumerate(meetings, 1):
        sess = [s for s in client.get("sessions", ("meeting_key", m["meeting_key"]), ("session_name", "Race"))
                if s.get("session_type") == "Race" and not s.get("is_cancelled")]
        if not sess or parse_ts(sess[0]["date_end"]) > now:
            skipped.append({"meeting": m["meeting_name"], "year": m["year"], "reason": "no completed Race session"})
            continue
        log(f"[{i}/{len(meetings)}] {m['year']} {m['meeting_name']} (net {client.n_net}, cached {client.n_cache})")
        try:
            res = process_race(client, m, sess[0], deep, log)
        except Exception as e:                              # keep going; report at the end
            log(f"  FAILED: {e!r}")
            res = None
        if res is None:
            skipped.append({"meeting": m["meeting_name"], "year": m["year"], "reason": "no usable data"})
            continue
        log(f"  -> {len(res['incidents'])} incidents detected")
        by_circuit.setdefault(m["circuit_key"], []).append(res)

    infos = []
    for races in by_circuit.values():
        track, incidents, info = build_track(races, n_zones, overrides, client, log)
        (out_dir / "tracks" / f"{track['track_id']}.json").write_text(json.dumps(track, indent=1))
        (out_dir / "incidents" / f"{track['track_id']}.json").write_text(json.dumps({"incidents": incidents}, indent=1))
        infos.append(info)
        log(f"wrote {track['track_id']}: {info['races_used']} races, {info['incidents']} incidents")

    report = {"years": list(years), "tracks": infos, "skipped": skipped, "requests_network": client.n_net,
              "requests_cached": client.n_cache, "deep": deep,
              "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    (out_dir / "extraction_report.json").write_text(json.dumps(report, indent=1))
    return report


def main() -> None:
    ap = argparse.ArgumentParser(description="Extract F1 track zones and crash incidents from OpenF1.")
    ap.add_argument("--years", type=int, nargs="+", default=list(range(2023, datetime.now().year + 1)))
    ap.add_argument("--out", type=Path, default=DATA_DIR / "telemetry_impacts",
                    help="output folder (kept separate from the Step 1 race-control pipeline in data/tracks)")
    ap.add_argument("--circuits", nargs="+", help="filter by circuit/location name, e.g. monza spa")
    ap.add_argument("--max-races", type=int, help="only the N most recent race weekends (quick test)")
    ap.add_argument("--zones", type=int, default=12)
    ap.add_argument("--deep", action="store_true",
                    help="also scan ALL cars for 2 min before each Safety Car/VSC/Red Flag (finds more, costs more)")
    ap.add_argument("--requests-per-minute", type=float, default=27.0, help="free tier limit is 30")
    a = ap.parse_args()
    rep = extract(a.years, a.out, a.circuits, a.deep, a.max_races, a.zones, a.requests_per_minute)
    n = sum(t["incidents"] for t in rep["tracks"])
    print(f"\nDone: {len(rep['tracks'])} tracks, {n} incidents, {rep['requests_network']} API calls "
          f"({rep['requests_cached']} cached), {len(rep['skipped'])} skipped. Report: {a.out / 'extraction_report.json'}")


if __name__ == "__main__":
    sys.exit(main())
