"""Plain-language race-control advice, driver cockpit warnings and marshal mast states.

Adapted from FIA/app/services/plain_alerts.py: every suggestion is decision SUPPORT; race control decides.
"""
from __future__ import annotations

FLAG_TEXT = {
    "YELLOW": "Show YELLOW in the sector. Send marshals to check the track.",
    "SLIPPERY": "Show the SLIPPERY SURFACE flag. Watch the next cars through the segment.",
    "DOUBLE_YELLOW": "Show DOUBLE YELLOW now. Send marshals. Be ready for the Virtual Safety Car.",
    "VSC": "Deploy the VIRTUAL SAFETY CAR: marshals need to work at the track side.",
    "SC": "Deploy the SAFETY CAR: a stopped car or debris needs recovery vehicles on track.",
    "RED": "Consider a RED FLAG if the barrier needs repair or the driver needs medical help.",
    "CLEAR": "Track clear: withdraw the flags once marshals confirm.",
}

# Mast panel states the map renders (FIA marshal light panels).
MAST_STATES = ("clear", "green", "yellow", "double_yellow", "slippery", "vsc", "sc", "red")


def driver_label(pack_drivers: dict, n: str) -> str:
    d = pack_drivers.get(n) or {}
    return f"Car {n} ({d['code']})" if d.get("code") else f"Car {n}"


def crash_advice(est: dict | None, who: str, where: str, sector: int | None, rc_message: str | None) -> dict:
    """Steward card content for a detected impact (or a race-control report without telemetry)."""
    sec = f"sector {sector}" if sector else where
    if est is None:
        flag = "DOUBLE_YELLOW" if rc_message and "DOUBLE" in rc_message.upper() else "YELLOW"
        why = f"Race control reported: {rc_message}. No impact is visible in the released telemetry."
        return {"level": "incident", "flag": flag, "headline": f"INCIDENT · {where.upper()}", "why": why,
                "action": FLAG_TEXT[flag], "say": f"Incident in {sec}. {FLAG_TEXT[flag]}"}
    speed = round(est["impact_speed_kph"])
    g = est["peak_long_g"]
    stopped = est["stopped"]
    hard = est["level"] == "crash"
    flag = "SC" if hard and stopped else ("VSC" if stopped else "DOUBLE_YELLOW")
    why = (f"{who} hit at about {speed} km/h ({g:.0f} g, {est['energy_mj']:.1f} MJ)"
           + (" and has stopped at the track side." if stopped else " and is still moving."))
    head = f"CRASH · {where.upper()}" if hard else f"IMPACT · {where.upper()}"
    return {"level": est["level"], "flag": flag, "headline": head, "why": why, "action": FLAG_TEXT[flag],
            "say": f"{head.title()}. {FLAG_TEXT[flag]}"}


def grip_advice(level: str, cars: list[str], min_residual: float | None, where: str) -> dict:
    pct = f"{round(min_residual * 100)}%" if min_residual is not None else "reduced"
    who = ", ".join(f"Car {c}" for c in cars) or "Cars"
    if level == "NONE":
        return {"level": "clear", "flag": "CLEAR", "headline": f"GRIP BACK · {where.upper()}",
                "why": "No car has lost braking grip here inside the last two minutes.", "action": FLAG_TEXT["CLEAR"],
                "say": f"Grip back at {where}."}
    flag = "SLIPPERY" if level == "ALERT" else "YELLOW"
    return {"level": "slip", "flag": flag, "headline": f"LOW GRIP · {where.upper()}",
            "why": f"{who} braked at {pct} of the deceleration a normal-grip surface gives at that speed.",
            "action": FLAG_TEXT[flag], "say": f"Low grip at {where}. {FLAG_TEXT[flag]}"}


def driver_warning(kind: str, sector: int | None, where: str, deployment: str) -> dict:
    """Cockpit / steering-wheel display text for cars approaching the incident."""
    sec = f"SECTOR {sector}" if sector else where.upper()
    if deployment == "sc":
        return {"tone": "sc", "title": "SAFETY CAR", "lines": ["SC DEPLOYED", "NO OVERTAKING", "FOLLOW THE DELTA"]}
    if deployment == "vsc":
        return {"tone": "vsc", "title": "VSC", "lines": ["VIRTUAL SAFETY CAR", "KEEP ABOVE DELTA TIME", "NO OVERTAKING"]}
    if deployment == "red":
        return {"tone": "red", "title": "RED FLAG", "lines": ["SESSION SUSPENDED", "RETURN TO PIT LANE", "SLOWLY"]}
    if kind == "slip":
        return {"tone": "yellow", "title": "CAUTION", "lines": [f"CAUTION · {sec}", "LOW GRIP AHEAD", "REDUCE SPEED"]}
    return {"tone": "double_yellow", "title": "CRASH AHEAD", "lines": [f"CRASH AHEAD · {sec}", "REDUCE SPEED", "BE PREPARED TO STOP"]}


ACTION_FOR_FLAG = {"SC": "SAFETY_CAR", "VSC": "VSC", "RED": "RED_FLAG", "DOUBLE_YELLOW": "DOUBLE_YELLOW", "YELLOW": "YELLOW",
                   "SLIPPERY": "YELLOW", "CLEAR": "MONITOR"}
STEPS_FOR_FLAG = {
    "SC": ["Show double yellow in the sector now", "Deploy the Safety Car", "Send recovery vehicle and medical car", "Check the barrier before green"],
    "VSC": ["Show double yellow in the sector now", "Deploy the VSC", "Marshals recover the car from the run-off", "End VSC once the track is clear"],
    "DOUBLE_YELLOW": ["Show double yellow in the sector", "Watch the car: be ready for the VSC", "Marshals check the barrier and track"],
    "YELLOW": ["Show yellow in the sector", "Watch the next cars through the corner"],
}


def rules_advisory(incident: dict, cars_behind: list[dict], reason: str) -> dict:
    """The deterministic card in the same shape as the Claude advisory (used without the agent)."""
    a = incident["advice"]
    sec = incident.get("marshal_sector")
    msgs = [{"driver": c["driver"],
             "message": f"CAUTION · SECTOR {sec}" if a["flag"] == "YELLOW" else f"CRASH AHEAD · SECTOR {sec}",
             "avoidance": "Reduce speed through the sector, no overtaking" if c["distance_m"] > 800 else "Lift now, avoid the scene, be ready to stop"}
            for c in cars_behind]
    return {"source": "rules", "reason": reason, "headline": a["headline"][:60], "recommended_action": ACTION_FOR_FLAG.get(a["flag"], "MONITOR"),
            "reasoning": f"{a['why']} {a['action']}", "citations": [], "driver_messages": msgs,
            "steward_steps": STEPS_FOR_FLAG.get(a["flag"], STEPS_FOR_FLAG["YELLOW"]), "marshal_instructions": "Check the barrier and the car; report driver status.",
            "spectator_safety": "", "confidence": "medium"}
