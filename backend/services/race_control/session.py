"""Live race-control session per circuit: replays a real incident and drives the whole safety loop.

One replay = the real OpenF1 telemetry of every car around a real incident, streamed at (a multiple of) real
time. On each tick:

  cars          positions of every car (real location samples) for the map
  grip engine   braking residuals -> WATCH / ALERT segments -> slippery / yellow marshal masts
  collision     when the replay reaches the detected impact: steward card (plain advice + suggested flag),
                marshal masts (double yellow in the sector, yellow before it), a cockpit warning for the
                car closest behind, the insurance impact of the crash, matching FIA regulation articles,
                and the multimodal severity (telemetry at once, radio when the Hugging Face models finish)

Race control then deploys SC / VSC / red flag / clear from the steward card; masts, cockpit display and
the map's traffic follow. Every change is published to SSE subscribers.
"""
from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from datetime import datetime, timezone

import numpy as np

from services import multimodal_severity as ms
from services import repository
from services.race_control import alerts, impact, packs, rulebook
from services.race_control import frame as fr
from services.race_control.grip import GripEngine

log = logging.getLogger(__name__)

TICK_S = 0.25                  # simulated seconds per frame
AFTER_IMPACT_S = 14.0          # keep replaying this long after the impact
WARNING_RANGE_M = 2500.0       # cars further back than this are not warned
QUEUE_SIZE = 400
MAST_ORDER = {s: i for i, s in enumerate(alerts.MAST_STATES)}
DEPLOY_LABEL = {"sc": "Safety Car deployed", "vsc": "Virtual Safety Car deployed", "red": "Red flag",
                "green": "Track clear"}
RULE_QUERY = {
    "SC": "When is the safety car deployed and what must drivers do behind it?",
    "VSC": "Virtual safety car procedure: when it is used and the delta time drivers must keep",
    "DOUBLE_YELLOW": "Double waved yellow flags: drivers must slow significantly and be prepared to stop, no overtaking",
    "YELLOW": "Single waved yellow flag: reduce speed, no overtaking in the sector",
    "SLIPPERY": "Slippery surface flag and deteriorated grip on the track",
    "RED": "Red flag: suspending a session, cars return slowly to the pit lane",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class RaceControlSession:
    def __init__(self, circuit: str) -> None:
        self.circuit = circuit
        self.sectors = fr.marshal_sectors(circuit)
        self.subscribers: set[asyncio.Queue] = set()
        self.deployment = "green"
        self.incident: dict | None = None
        self.severity: dict | None = None
        self.warning: dict | None = None
        self.hazards: dict[int, dict] = {}          # grip segment -> {level, sector, cars, ...}
        self.masts = {s["sector"]: "clear" for s in self.sectors}
        self.log: deque[dict] = deque(maxlen=80)
        self.replay: dict | None = None
        self._task: asyncio.Task | None = None
        self._side: set[asyncio.Task] = set()
        self._green_until = 0.0
        self.grip = GripEngine(repository.load(circuit).cfg.length_m)

    # ------------------------------------------------------------------ pub/sub
    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=QUEUE_SIZE)
        self.subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self.subscribers.discard(q)

    def publish(self, kind: str, data: dict) -> None:
        event = {"type": kind, "circuit": self.circuit, "data": data}
        for q in list(self.subscribers):
            if q.full():                       # a stalled client drops its oldest frames, never blocks the replay
                q.get_nowait()
            q.put_nowait(event)

    def note(self, text: str, tone: str = "info") -> None:
        entry = {"at": _now(), "text": text, "tone": tone,
                 "replay_t": round(self.replay["t"], 1) if self.replay else None}
        self.log.appendleft(entry)
        self.publish("log", entry)

    def snapshot(self) -> dict:
        return {"circuit": self.circuit, "masts": self.mast_view(), "deployment": self.deployment,
                "incident": self.incident, "severity": self.severity, "warning": self.warning,
                "replay": self.replay, "log": list(self.log), "hazards": list(self.hazards.values())}

    # ------------------------------------------------------------------ masts
    def mast_view(self) -> list[dict]:
        return [{**s, "state": self.masts[s["sector"]]} for s in self.sectors]

    def _recompute_masts(self) -> None:
        state = {s: "clear" for s in self.masts}

        def raise_to(sector: int | None, level: str) -> None:
            if sector in state and MAST_ORDER[level] > MAST_ORDER[state[sector]]:
                state[sector] = level

        for h in self.hazards.values():
            raise_to(h["sector"], "slippery" if h["level"] == "ALERT" else "yellow")
        if self.incident:
            sec = self.incident["marshal_sector"]
            raise_to(sec, "yellow" if self.incident["advice"]["flag"] in ("YELLOW", "SLIPPERY") else "double_yellow")
            raise_to(fr.previous_sector(self.circuit, sec) if sec else None, "yellow")
        if self.deployment in ("sc", "vsc", "red"):
            state = {s: self.deployment for s in state}
        elif time.monotonic() < self._green_until:
            state = {s: "green" for s in state}
        if state != self.masts:
            self.masts = state
            self.publish("masts", {"masts": self.mast_view()})

    # ------------------------------------------------------------------ replay
    def _cancel(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
        for t in list(self._side):
            t.cancel()

    async def reset(self) -> None:
        self._cancel()
        self.grip.reset()
        self.deployment, self.incident, self.severity, self.warning, self.replay = "green", None, None, None, None
        self.hazards.clear()
        self.log.clear()
        self._green_until = 0.0
        self._recompute_masts()
        self.publish("reset", self.snapshot())

    async def start_replay(self, incident_id: str, speed: float = 1.0, lead_s: float = 15.0) -> dict:
        pack = packs.get(self.circuit, incident_id)
        await self.reset()
        summary = packs.summary(self.circuit, pack)
        self._task = asyncio.create_task(self._run(pack, summary, speed, lead_s))
        return summary

    def _prepare(self, pack: dict) -> dict[str, dict]:
        f = fr.frame(self.circuit)
        cars = {}
        for n, rows in pack["samples"].items():
            a = np.asarray(rows, float)
            nx, ny = f.norm(a[:, 4], a[:, 5])
            mx, my = zip(*(f.centre(float(x), float(y)) for x, y in zip(nx, ny)))
            _, idx = f.tree.query(a[:, 4:6])
            d = pack["drivers"].get(n) or {}
            cars[n] = {"t": a[:, 0], "v": a[:, 1], "brake": a[:, 3], "x": np.array(mx), "y": np.array(my),
                       "frac": f.frac[idx], "code": d.get("code"), "colour": d.get("colour"),
                       "involved": n in pack["involved"]}
        return cars

    async def _run(self, pack: dict, summary: dict, speed: float, lead_s: float) -> None:
        try:
            cars = await asyncio.to_thread(self._prepare, pack)
            imp = packs.primary_impact(pack)
            t_event = imp["t"] if imp else pack["message_offset_s"]
            t_last = max(float(c["t"][-1]) for c in cars.values())
            t0, t1 = max(0.0, t_event - lead_s), min(t_last, t_event + AFTER_IMPACT_S)
            self.replay = {"incident_id": pack["incident_id"], "t": 0.0, "t_start": t0 - t_event,
                           "t_end": t1 - t_event, "speed": speed, "running": True}
            self.publish("replay_start", {"incident": summary, **self.replay})
            self.note(f"Replaying {summary['session_type']} {summary['season']}: {summary['raw_message']}")
            fed = {n: int(np.searchsorted(c["t"], t0)) for n, c in cars.items()}
            triggered, last_hud = False, -1e9
            T = t0
            while T <= t1:
                frame_cars = []
                for n, c in cars.items():
                    # grip engine: every real sample up to T
                    while fed[n] < len(c["t"]) and c["t"][fed[n]] <= T:
                        i = fed[n]
                        for ev in self.grip.ingest(n, float(c["t"][i]), float(c["v"][i]), float(c["brake"][i]),
                                                   float(c["frac"][i])):
                            self._on_grip(ev)
                        fed[n] += 1
                    if c["t"][0] <= T <= c["t"][-1] + 1.0:
                        i = max(0, fed[n] - 1)
                        frame_cars.append({"n": n, "code": c["code"], "colour": c["colour"], "involved": c["involved"],
                                           "x": round(float(c["x"][i]), 5), "y": round(float(c["y"][i]), 5),
                                           "speed": round(float(c["v"][i])), "lap_frac": round(float(c["frac"][i]), 4)})
                self.replay["t"] = T - t_event
                if not triggered and T >= t_event:
                    triggered = True
                    await self._trigger(pack, summary, imp, cars, T)
                if self.warning and T - last_hud >= 1.0:
                    last_hud = T
                    self._update_warning_distance(cars, fed)
                self.publish("cars", {"t": round(T - t_event, 2), "cars": frame_cars})
                await asyncio.sleep(TICK_S / speed)
                T += TICK_S
            self.replay["running"] = False
            self.publish("replay_end", self.replay)
        except asyncio.CancelledError:
            raise
        except Exception as exc:                  # never leave the map hanging on a broken replay
            log.exception("replay failed")
            self.publish("stream_error", {"message": f"Replay failed: {exc}"})

    def _on_grip(self, ev) -> None:
        f = fr.frame(self.circuit)
        frac = ev.distance_m / self.grip.lap_length_m
        sector = fr.sector_for_frac(self.circuit, frac)
        zone = next((z for z in f.zones if z["start_frac"] <= frac < z["end_frac"]), f.zones[0])
        zone = {**zone, "name": repository.short_name(zone["name"])}
        if ev.level == "NONE":
            self.hazards.pop(ev.segment, None)
        else:
            self.hazards[ev.segment] = {"segment": ev.segment, "level": ev.level, "sector": sector,
                                        "zone_name": zone["name"], "cars": ev.cars, "min_residual": ev.min_residual,
                                        "lap_frac": round(frac, 4)}
        advice = alerts.grip_advice(ev.level, ev.cars, ev.min_residual, zone["name"])
        self.publish("grip", {"segment": ev.segment, "level": ev.level, "sector": sector, "advice": advice,
                              "cars": ev.cars, "min_residual": ev.min_residual})
        if ev.level == "ALERT" and ev.previous != "ALERT":
            self.note(f"{advice['headline']}: {advice['why']}", "warn")
        self._recompute_masts()

    async def _trigger(self, pack: dict, summary: dict, imp: dict | None, cars: dict, T: float) -> None:
        sector = summary["marshal_sector"]
        who = alerts.driver_label(pack["drivers"], imp["driver"]) if imp else \
            ", ".join(alerts.driver_label(pack["drivers"], n) for n in pack["involved"]) or "A car"
        advice = alerts.crash_advice(imp, who, summary["zone_name"], sector, pack["raw_message"])
        loss = await asyncio.to_thread(
            impact.crash_impact, self.circuit, summary["zone_id"], summary["x"], summary["y"],
            imp["impact_speed_kph"] if imp else None)
        self.incident = {**summary, "advice": advice, "collision": imp, "insurance": loss, "rules": [],
                         "detected_at": _now()}
        self._recompute_masts()
        self.publish("incident", self.incident)
        self.note(f"{advice['headline']}: {advice['why']}", "alert")

        kind = "slip" if advice["flag"] in ("YELLOW", "SLIPPERY") else "crash"
        self.warning = self._warning_for(kind, sector, summary, cars, T, exclude=set(pack["involved"]))
        if self.warning:
            self.publish("driver_warning", self.warning)

        radio = self._radio_for(pack, imp)
        self.severity = {**ms.fuse(imp["telemetry_score"] if imp else None, None, None), "telemetry": imp,
                         "radio": None, "radio_pending": radio is not None, "models": ms.status()}
        self.publish("severity", self.severity)
        self._spawn(self._rules(advice["flag"]))
        if radio:
            self._spawn(self._severity_with_radio(imp, radio, pack))

    def _radio_for(self, pack: dict, imp: dict | None) -> dict | None:
        clips = pack.get("radio") or []
        if imp:
            own = [c for c in clips if c["driver"] == imp["driver"]]
            clips = own or clips
        return min(clips, key=lambda c: abs(c["offset_s"]), default=None) if clips else None

    def _spawn(self, coro) -> None:
        task = asyncio.create_task(coro)
        self._side.add(task)
        task.add_done_callback(self._side.discard)

    async def _rules(self, flag: str) -> None:
        try:
            cites = await asyncio.to_thread(rulebook.search, RULE_QUERY.get(flag, RULE_QUERY["YELLOW"]), 3)
        except Exception as exc:
            log.warning("rulebook search failed: %s", exc)
            return
        if self.incident:
            self.incident["rules"] = cites
            self.publish("rules", {"incident_id": self.incident["incident_id"], "rules": cites})

    async def _severity_with_radio(self, imp: dict | None, clip: dict, pack: dict) -> None:
        try:
            data = await asyncio.to_thread(ms.fetch_radio, clip["url"])
            result = await asyncio.to_thread(
                ms.analyse, imp, ms.RadioInput(data, clip["url"], clip["driver"], clip["offset_s"]))
        except Exception as exc:
            self.severity = {**(self.severity or {}), "radio_pending": False, "radio_error": str(exc)}
            self.publish("severity", self.severity)
            return
        who = alerts.driver_label(pack["drivers"], clip["driver"])
        self.severity = {**result, "radio_pending": False}
        self.publish("severity", self.severity)
        heard = result.get("radio") or {}
        if heard.get("transcript"):
            self.note(f"Radio {who}: “{heard['transcript']}”", "info")

    def _warning_for(self, kind: str, sector: int | None, summary: dict, cars: dict, T: float, exclude: set) -> dict | None:
        length = self.grip.lap_length_m
        best = None
        for n, c in cars.items():
            if n in exclude or not (c["t"][0] <= T <= c["t"][-1]):
                continue
            i = int(np.clip(np.searchsorted(c["t"], T), 0, len(c["t"]) - 1))
            gap = (summary["lap_frac"] - c["frac"][i]) % 1.0      # how far this car is behind the crash point
            dist = gap * length
            if 0 < dist <= WARNING_RANGE_M and (best is None or dist < best[1]):
                best = (n, dist)
        if best is None:
            return None
        n, dist = best
        text = alerts.driver_warning(kind, sector, summary["zone_name"], self.deployment)
        return {**text, "driver": n, "code": cars[n]["code"], "colour": cars[n]["colour"],
                "distance_m": round(dist), "sector": sector, "kind": kind}

    def _update_warning_distance(self, cars: dict, fed: dict) -> None:
        w = self.warning
        c = cars.get(w["driver"]) if w else None
        if not c or not self.incident:
            return
        i = max(0, fed[w["driver"]] - 1)
        dist = ((self.incident["lap_frac"] - c["frac"][i]) % 1.0) * self.grip.lap_length_m
        w["distance_m"] = round(dist) if dist < WARNING_RANGE_M * 1.2 else 0
        self.publish("driver_warning", w)

    # ------------------------------------------------------------------ steward actions
    async def deploy(self, action: str) -> dict:
        if action not in DEPLOY_LABEL and action != "clear":
            raise ValueError(action)
        if action == "clear":
            self.deployment = "green"
            self.incident, self.warning = None, None
            self.hazards.clear()
            self._green_until = time.monotonic() + 6.0
            self._spawn(self._end_green())
        else:
            self.deployment = action
        self._recompute_masts()
        if self.warning:
            kind = self.warning["kind"]
            self.warning = {**self.warning, **alerts.driver_warning(kind, self.warning["sector"], "", self.deployment)}
            self.publish("driver_warning", self.warning)
        elif action == "clear":
            self.publish("driver_warning", {"tone": "green", "title": "TRACK CLEAR", "lines": ["GREEN FLAG", "RACING RESUMES"],
                                            "driver": None, "code": None, "colour": None, "distance_m": 0, "sector": None, "kind": "clear"})
        label = DEPLOY_LABEL["green" if action == "clear" else action]
        self.publish("deployment", {"deployment": self.deployment, "label": label, "at": _now()})
        self.note(f"Race control: {label}.", "action")
        return self.snapshot()

    async def _end_green(self) -> None:
        await asyncio.sleep(6.2)
        self._recompute_masts()


_SESSIONS: dict[str, RaceControlSession] = {}


def session(circuit: str) -> RaceControlSession:
    if circuit not in _SESSIONS:
        _SESSIONS[circuit] = RaceControlSession(circuit)
    return _SESSIONS[circuit]
