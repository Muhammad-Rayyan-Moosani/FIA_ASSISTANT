"""The wet-hairpin demo: two simulated cars, one standing-water patch, the whole safety loop for real.

The physics runs in the browser (frontend/src/lib/demoPhysics.ts: a dynamic bicycle model with a Pacejka-style
tyre, downforce, weight transfer and a spring-damper tyre barrier) because it must draw at 60 fps. Every event it
produces — car A's slip, its trip across the run-off, the impact, the stop, car B's reaction and pass — is posted
here, and from then on the loop is the same one a real replay drives: marshal masts, the cockpit warning for the
car behind, the steward card from the rulebook + Claude, the insurance impact of the crash, the severity score
and the log. Car B only reacts once the warning arrives over the SSE stream, so the message really is what saves
it. After the Nürburgring 2007 European GP, where a sudden downpour sent six cars off at Turn 1 within a lap.

Everything the demo produces is labelled "Demo · simulated physics"; nothing here is presented as real data.
"""
from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone

from services import multimodal_severity as ms
from services import repository
from services.race_control import alerts, collision, impact
from services.race_control import frame as fr

DEMO_ID = "demo-wet-hairpin"
LABEL = "Demo · simulated physics"
# car B's steering-wheel code / colour on the map and the cockpit display
CARS = {"A": {"number": "A", "code": None, "name": "Car A (simulated)", "team": LABEL, "colour": "e8002d"},
        "B": {"number": "B", "code": None, "name": "Car B (simulated)", "team": LABEL, "colour": "27f4d2"}}
MAX_DEMO_S = 45.0


def summary(circuit: str, zone_id: str, x: float, y: float, lap_frac: float) -> dict:
    zone = next(z for z in repository.load(circuit).track["zones"] if z["zone_id"] == zone_id)
    name = repository.short_name(zone["name"])
    return {
        "incident_id": DEMO_ID, "season": datetime.now(timezone.utc).year, "session_type": "Demo",
        "occurred_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "raw_message": f"Simulated: standing water in the braking zone of the {name} (after Nürburgring 2007)",
        "rule": "demo", "zone_id": zone_id, "zone_name": name,
        "marshal_sector": fr.sector_for_frac(circuit, lap_frac),
        "x": x, "y": y, "lap_frac": round(lap_frac, 4), "location_source": "zone",
        "involved": [CARS["A"]], "impact": None, "radio_clips": 0, "cars_in_window": 2,
    }


def slip_advice(where: str, measured_g: float, expected_g: float, speed_kph: float) -> dict:
    pct = round(100 * measured_g / expected_g) if expected_g else 0
    return {"level": "slip", "flag": "SLIPPERY", "headline": f"AQUAPLANING · {where.upper()}",
            "why": (f"Car A is braking at {measured_g:.1f} g where wet tyres give {expected_g:.1f} g ({pct}%) at "
                    f"{speed_kph:.0f} km/h: standing water. It will not make the corner."),
            "action": alerts.FLAG_TEXT["SLIPPERY"] + " Warn every car approaching NOW.",
            "say": f"Aquaplaning at the {where}. Slippery surface flag, warn the cars behind."}


def collision_estimate(e: dict, stopped: bool) -> dict:
    """The simulated impact, in the shape of the telemetry collision estimator's output."""
    v = float(e["impact_speed_kph"])
    energy = 0.5 * collision.CAR_MASS_KG * (v / 3.6) ** 2 / 1e6
    entry = float(e.get("entry_speed_kph", v))
    drop = entry if stopped else entry - v
    peak = float(e.get("peak_g") or 0.0)
    return {"driver": "A", "t": round(float(e["t"]), 2), "level": "crash", "kind": "barrier (simulated)",
            "entry_speed_kph": round(entry, 1), "impact_speed_kph": round(v, 1),
            "speed_drop_kph": round(drop, 1), "peak_long_g": round(peak, 1), "peak_lat_g": 0.0,
            "energy_mj": round(energy, 3), "stopped": stopped,
            "telemetry_score": collision.telemetry_score(peak, energy, stopped, drop)}


class DemoRun:
    """Race-control side of one demo run, driven by the browser's physics events."""

    def __init__(self, session, zone_id: str, x: float, y: float, lap_frac: float) -> None:
        self.s = session
        self.summary = summary(session.circuit, zone_id, x, y, lap_frac)
        self.started = time.monotonic()
        self.peak_g = 0.0
        self.impact: dict | None = None

    # ------------------------------------------------------------------ events
    async def event(self, e: dict) -> None:
        s = self.s
        if s.replay is None or s.replay.get("incident_id") != DEMO_ID:
            return
        s.replay["t"] = round(float(e.get("t", 0.0)), 2)
        kind = e["kind"]
        if kind == "tick":
            self._distance(e)
        elif kind == "slip":
            await self._slip(e)
        elif kind == "spin":
            s.note(f"Car A has lost it: {e.get('slide_deg', 0):.0f}° sideways at {e['speed_kph']:.0f} km/h, both feet in.", "alert")
        elif kind == "off":
            s.note(f"Car A off the track at {e['speed_kph']:.0f} km/h, sliding across the run-off.", "alert")
        elif kind == "impact":
            await self._impact(e)
        elif kind == "stopped":
            await self._stopped(e)
        elif kind == "reacted":
            s.note(f"Car B has the message (0.6 s to react) at {e['speed_kph']:.0f} km/h, {e.get('distance_m', 0):.0f} m before "
                   "the water: will brake early and take the dry strip on the inside.", "action")
        elif kind == "passed":
            s.note(f"Car B through the {self.summary['zone_name']} safely (slowest {e.get('min_speed_kph', 0):.0f} km/h). "
                   "Without the warning the physics sends it into the same barrier.", "action")
        elif kind == "end":
            self.end()

    def end(self) -> None:
        s = self.s
        if s.replay and s.replay.get("incident_id") == DEMO_ID and s.replay["running"]:
            s.replay["running"] = False
            s.publish("replay_end", s.replay)

    # ------------------------------------------------------------------ steps
    async def _slip(self, e: dict) -> None:
        s, sm = self.s, self.summary
        where = sm["zone_name"]
        advice = slip_advice(where, e["measured_g"], e["expected_g"], e["speed_kph"])
        # the slip point is the incident location; the insurance view prices a crash at the zone's assumed speed
        # until the physics produces the real one
        loss = await asyncio.to_thread(impact.crash_impact, s.circuit, sm["zone_id"], sm["x"], sm["y"], None)
        behind = [{"driver": "B", "code": None, "distance_m": round(e.get("distance_m", 0)), "speed_kph": round(e.get("b_speed_kph", 0))}]
        s.hazards["demo-water"] = {"segment": "demo-water", "level": "ALERT", "sector": sm["marshal_sector"],
                                   "zone_name": where, "cars": ["A"], "min_residual": round(e["measured_g"] / e["expected_g"], 2),
                                   "lap_frac": sm["lap_frac"]}
        d = round(e.get("distance_m", 0))
        s.incident = {**sm, "raw_message": f"Car A aquaplaning at {e['speed_kph']:.0f} km/h: {e['measured_g']:.1f} g of {e['expected_g']:.1f} g",
                      "advice": advice, "collision": None, "insurance": loss, "rules": [], "live": None,
                      "cars_behind": behind, "advisory": None, "detected_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                      "demo": True, "driver_hint": {"message": "STANDING WATER · AQUAPLANING", "avoidance": "Brake early and gently, keep to the inside line"}}
        s._recompute_masts()
        s.publish("incident", s.incident)
        s.note(f"{advice['headline']}: {advice['why']}", "alert")
        text = alerts.driver_warning("slip", sm["marshal_sector"], where, s.deployment)
        s.warning = {**text, "title": "AQUAPLANING", "lines": ["STANDING WATER AHEAD", "BRAKE EARLY · INSIDE LINE", f"{d} m to the incident"],
                     "driver": "B", "code": None, "colour": CARS["B"]["colour"], "distance_m": d,
                     "sector": sm["marshal_sector"], "kind": "slip", "demo": True}
        s.publish("driver_warning", s.warning)
        s.note(f"Cockpit warning sent to Car B, {d} m behind at {e.get('b_speed_kph', 0):.0f} km/h.", "action")
        s.severity = {**ms.fuse(0.35, None, None), "telemetry": None, "radio": None, "radio_pending": False, "models": ms.status()}
        s.publish("severity", s.severity)
        s._spawn(s._rules_then_advisory("SLIPPERY", False))

    async def _impact(self, e: dict) -> None:
        self.impact = e
        await self._crash(collision_estimate(e, stopped=False))

    async def _stopped(self, e: dict) -> None:
        if not self.impact:
            return
        await self._crash(collision_estimate({**self.impact, "peak_g": e.get("peak_g", 0.0)}, stopped=True))

    async def _crash(self, est: dict) -> None:
        s, inc = self.s, self.s.incident
        if not inc:
            return
        advice = alerts.crash_advice(est, "Car A", inc["zone_name"], inc["marshal_sector"], None)
        loss = await asyncio.to_thread(impact.crash_impact, s.circuit, inc["zone_id"], inc["x"], inc["y"], est["impact_speed_kph"])
        loss = {**loss, "impact_speed_source": "simulated"}
        inc.update(advice=advice, collision=est, insurance=loss,
                   raw_message=f"Car A into the tyre barrier at {est['impact_speed_kph']:.0f} km/h",
                   driver_hint={"message": "WATER + CAR IN BARRIER", "avoidance": "Brake early, inside line, no overtaking, ready to stop"})
        s._recompute_masts()
        s.publish("incident_update", inc)
        s.note(f"{advice['headline']}: {advice['why']}", "alert")
        text = alerts.driver_warning("crash", inc["marshal_sector"], inc["zone_name"], s.deployment)
        if s.warning:
            s.warning = {**s.warning, **text, "lines": [text["lines"][0], "WATER + CAR IN BARRIER", f"{s.warning['distance_m']} m to the incident"]}
            s.publish("driver_warning", s.warning)
        s.severity = {**ms.fuse(est["telemetry_score"], None, None), "telemetry": est, "radio": None,
                      "radio_pending": False, "models": ms.status()}
        s.publish("severity", s.severity)
        s._spawn(s._rules_then_advisory(advice["flag"], False))

    def _distance(self, e: dict) -> None:
        w = self.s.warning
        if w and w.get("driver") == "B" and "distance_m" in e:
            d = max(0, round(e["distance_m"]))
            where = f"{d} m to the incident" if d > 0 else "past the incident"
            lines = [*w["lines"][:2], where] if len(w["lines"]) >= 3 and w["lines"][2].endswith("incident") else w["lines"]
            self.s.warning = {**w, "distance_m": d, "lines": lines}
            self.s.publish("driver_warning", self.s.warning)
        if time.monotonic() - self.started > MAX_DEMO_S:
            self.end()
