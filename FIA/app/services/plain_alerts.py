"""
Plain-language alert messages for the live alert feed.

Takes the technical hazard payload the feed already sends over /ws/alerts, e.g.

    {"type": "hazard", "sector_id": "grid_23_0", "coordinates": {"x": 586.6, "y": 10.2},
     "severity_level": "ALERT", "previous_level": "WATCH",
     "evidence_card_data": {"hazard_types": ["grip_cliff"], "cars_flagged": ["1", "2"],
                            "min_residual": 0.4563, "flag_count": 4, "vision": [], ...},
     "timestamp": 37.6}

and adds a short message a race director can read in one glance:

    plain_alert(payload, location="Turn 1")
    -> {"level": "ALERT", "colour": "red",
        "headline": "SLIPPERY at Turn 1",
        "action": "Show YELLOW flag now. Send marshals to check the track.",
        "why": "Car 1 and Car 2 could only brake with 46% of normal grip.",
        "flag": "YELLOW", "text": "ALERT - SLIPPERY at Turn 1: ...", ...}

Also handles crash events from the OpenF1 detector (`type == "crash"`, see
`crash_payload()` below).  The suggestion is decision SUPPORT: race control decides.
No external calls; standard library only.
"""
from __future__ import annotations

from typing import Any

# ---- wording -------------------------------------------------------------- #

HAZARD_WORDS = {           # technical tag -> (short label, plain description)
    "grip_cliff":   ("SLIPPERY", "low grip"),
    "oil_streak":   ("OIL", "oil on the track"),
    "water_sheen":  ("WATER", "water on the track"),
    "debris":       ("DEBRIS", "debris on the track"),
    "stopped_car":  ("STOPPED CAR", "a stopped car"),
}

FLAG_TEXT = {              # what to do, in the fewest words
    "YELLOW_READY": "Get a YELLOW flag ready. Watch the next cars.",
    "YELLOW":       "Show YELLOW flag now. Send marshals to check the track.",
    "DOUBLE_YELLOW": "Show DOUBLE YELLOW now. Send marshals. Be ready for the Safety Car.",
    "VSC":          "Think about a Virtual Safety Car. Show YELLOW in the sector now.",
    "SC":           "Think about the Safety Car. Show DOUBLE YELLOW now.",
    "RED":          "Think about a RED flag. Stop the race if the track cannot be made safe.",
    "CLEAR":        "Flags can come in once marshals confirm the track is clean.",
}
COLOUR = {"WATCH": "amber", "ALERT": "red", "INFO": "grey", "NONE": "green"}


def _grip_words(residual: float | None) -> str:
    if residual is None:
        return "less grip than normal"
    pct = round(residual * 100)
    if pct >= 90:
        return f"almost normal grip ({pct}%)"
    if pct >= 75:
        return f"less grip than normal ({pct}%)"
    if pct >= 50:
        return f"low grip ({pct}% of normal)"
    return f"very little grip ({pct}% of normal)"


def _cars_text(cars: list[str]) -> str:
    cars = [str(c) for c in cars]
    if not cars:
        return "Cars"
    if len(cars) == 1:
        return f"Car {cars[0]}"
    if len(cars) == 2:
        return f"Car {cars[0]} and Car {cars[1]}"
    return "Cars " + ", ".join(cars[:-1]) + f" and {cars[-1]}"


def _where(payload: dict, location: str | None) -> str:
    if location:
        return location
    c = payload.get("coordinates") or {}
    if "x" in c:
        return f"the {round(c['x'])} m mark"
    return str(payload.get("sector_id", "the track"))


# ---- main ----------------------------------------------------------------- #


def plain_alert(payload: dict[str, Any], location: str | None = None) -> dict[str, Any]:
    """Turn one hazard/crash payload into a short, plain message plus a suggested flag."""
    if payload.get("type") == "crash":
        return _plain_crash(payload, location)

    ev = payload.get("evidence_card_data") or {}
    level = str(payload.get("severity_level", "WATCH")).upper()
    prev = str(payload.get("previous_level", "NONE")).upper()
    if level == "NONE":                                 # the engine's "hazard cleared" event
        return _plain_clear(payload, prev, location)
    cars = [str(c) for c in ev.get("cars_flagged", [])]
    tags = list(ev.get("hazard_types", []))
    vision = ev.get("vision") or []
    for v in vision:                                    # camera confirmations
        t = v.get("hazard_type") if isinstance(v, dict) else None
        if t and t not in tags:
            tags.append(t)
    residual = ev.get("min_residual")
    where = _where(payload, location)

    # headline: the most specific hazard first (camera-confirmed beats "low grip")
    order = ["oil_streak", "water_sheen", "debris", "stopped_car", "grip_cliff"]
    main = next((t for t in order if t in tags), tags[0] if tags else None)
    label = HAZARD_WORDS.get(main, ("HAZARD", "a hazard"))[0]
    headline = f"{label} at {where}"

    # what is happening, in one sentence
    seen = [HAZARD_WORDS.get(t, (t, t))[1] for t in tags if t != "grip_cliff"]
    why_parts = []
    if cars:
        verb = "is" if len(cars) == 1 else "are"
        why_parts.append(f"{_cars_text(cars)} {verb} getting {_grip_words(residual)}")
    if seen:
        why_parts.append("Camera sees " + " and ".join(seen))
    why = ". ".join(why_parts) + "." if why_parts else "Cars are getting less grip than normal."

    # what to do
    confirmed = any(t in tags for t in ("oil_streak", "water_sheen", "debris", "stopped_car"))
    n = len(cars)
    severe = residual is not None and residual < 0.6
    if level == "WATCH":
        flag = "YELLOW" if (confirmed and severe) else "YELLOW_READY"
    else:  # ALERT
        flag = "YELLOW"
        if n >= 3 or (n >= 2 and confirmed and severe):
            flag = "VSC"
    action = FLAG_TEXT[flag]

    verb = "Now" if level == "ALERT" else "Watch"
    text = f"{level} - {headline}. {why} {action}"
    return {
        "level": level, "colour": COLOUR.get(level, "grey"), "changed_from": prev,
        "headline": headline, "why": why, "action": action, "flag": flag,
        "cars": cars, "where": where, "text": text,
        "say": f"{verb}: {label.lower()} at {where}. {action}",     # for text-to-speech / radio
        "note": "Suggestion only. Race control decides.",
    }


def _plain_clear(payload: dict[str, Any], prev: str, location: str | None) -> dict[str, Any]:
    where = _where(payload, location)
    headline = f"CLEAR at {where}"
    why = "No car has lost grip here for a while."
    action = FLAG_TEXT["CLEAR"]
    return {
        "level": "NONE", "colour": COLOUR["NONE"], "changed_from": prev, "headline": headline,
        "why": why, "action": action, "flag": "CLEAR", "cars": [], "where": where,
        "text": f"CLEAR - {headline}. {why} {action}", "say": f"Clear at {where}. {action}",
        "note": "Suggestion only. Race control decides.",
    }


def crash_payload(event: dict[str, Any], location: str | None = None) -> dict[str, Any]:
    """Wrap a detected crash (from openf1_extract.detect_impacts) in the feed's payload shape."""
    return {"type": "crash", "location": location, "driver": event.get("driver"),
            "driver_code": event.get("driver_code"), "kind": event.get("kind", "stop"),
            "impact_speed_kph": event.get("impact_speed_kph"), "peak_decel_g": event.get("peak_decel_g"),
            "still_moving": event.get("still_moving", False), "coordinates": event.get("coordinates"),
            "severity_level": "ALERT", "timestamp": event.get("t")}


def _plain_crash(p: dict[str, Any], location: str | None) -> dict[str, Any]:
    who = p.get("driver_code") or (f"Car {p['driver']}" if p.get("driver") else "A car")
    where = location or p.get("location") or "the track"
    g = p.get("peak_decel_g") or 0
    speed = p.get("impact_speed_kph")
    hard = g >= 15
    stopped = not p.get("still_moving", False)
    flag = "SC" if (hard and stopped) else "DOUBLE_YELLOW"
    hit = f"hit something at about {round(speed)} km/h" if speed else "had a big impact"
    headline = f"CRASH at {where}"
    why = f"{who} {hit}" + (" and has stopped on the track." if stopped else " and is still moving.")
    if hard:
        why += " It was a very hard hit."
    action = FLAG_TEXT[flag]
    return {
        "level": "ALERT", "colour": "red", "changed_from": "NONE", "headline": headline, "why": why,
        "action": action, "flag": flag, "cars": [str(p["driver"])] if p.get("driver") else [],
        "where": where, "text": f"ALERT - {headline}. {why} {action}",
        "say": f"Now: crash at {where}. {action}", "note": "Suggestion only. Race control decides.",
    }


def merge_nearby(payloads: list[dict[str, Any]], radius_m: float = 60.0) -> list[dict[str, Any]]:
    """The map raises one alert per 25 m cell, so one oil patch can show up 2-3 times.
    Keep only the highest-severity payload per group of cells within `radius_m`."""
    rank = {"NONE": 0, "WATCH": 1, "ALERT": 2}
    kept: list[dict[str, Any]] = []
    for p in sorted(payloads, key=lambda p: -rank.get(str(p.get("severity_level")).upper(), 0)):
        c = p.get("coordinates") or {}
        dup = any(
            k.get("coordinates") and "x" in c
            and ((k["coordinates"]["x"] - c["x"]) ** 2 + (k["coordinates"]["y"] - c["y"]) ** 2) ** 0.5 <= radius_m
            for k in kept
        )
        if not dup:
            kept.append(p)
    return kept


if __name__ == "__main__":
    watch = {"type": "hazard", "sector_id": "grid_23_0", "coordinates": {"x": 586.1, "y": 10.4},
             "severity_level": "WATCH", "previous_level": "NONE",
             "evidence_card_data": {"hazard_types": ["grip_cliff"], "cars_flagged": ["1"], "min_residual": 0.4566,
                                    "vision": []}, "timestamp": 31.6}
    alert = {**watch, "severity_level": "ALERT", "previous_level": "WATCH",
             "evidence_card_data": {**watch["evidence_card_data"], "cars_flagged": ["1", "2"]}, "timestamp": 37.6}
    confirmed = {**alert, "evidence_card_data": {**alert["evidence_card_data"],
                 "vision": [{"hazard_type": "oil_streak", "confidence": 0.6}]}}
    crash = crash_payload({"driver": 11, "driver_code": "PER", "kind": "stop", "impact_speed_kph": 172,
                           "peak_decel_g": 8.3}, "Turn 1")
    for name, p in [("WATCH", watch), ("ALERT", alert), ("ALERT + camera sees oil", confirmed), ("CRASH", crash)]:
        a = plain_alert(p, "Turn 1")
        print(f"[{name}]\n  {a['text']}\n  say: {a['say']}\n")
