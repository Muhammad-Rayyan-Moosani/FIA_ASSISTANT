"""Which Step 1 incidents count as insurable crashes for the Step 2 model.

Step 1 marks an incident `loss_relevant` when something physical *may* have happened, which includes
every yellow flag and every steward note. Pricing each of those as a crash with car and barrier damage
overstated losses about threefold. Only events that indicate physical damage are counted here:

  counted                                          not counted
  double yellow   car stopped or crashed           yellow flag          a warning, often just a car off
  collision       steward: "CAUSING A COLLISION"   "INCIDENT … NOTED"   no contact confirmed
  crash_or_stopped  "CRASH" / "STOPPED" / "BARRIER"  forcing off / rejoin  driving standards, no contact
  debris          debris on track                  track limits, offs   no damage

A collision note and the double yellow it caused are usually one event, so counted events in the same
session and zone within DEDUP_WINDOW_S are merged (the first one is kept).
"""

from __future__ import annotations

from datetime import datetime

CRASH_RULES: dict[str, str] = {
    "double_yellow": "car stopped or crashed (double yellow)",
    "collision": "collision confirmed by the stewards",
    "crash_or_stopped": "crash or stopped car named in the message",
    "debris": "debris on track",
}
DEDUP_WINDOW_S = 300


def _rule(incident: dict) -> str | None:
    return (incident.get("extraction") or {}).get("rule")


def crash_events(incidents: list[dict]) -> list[dict]:
    """Counted crashes, one per physical event, in time order."""
    kept: list[dict] = []
    last: dict[tuple, datetime] = {}
    for r in sorted(incidents, key=lambda r: r["occurred_at"]):
        if _rule(r) not in CRASH_RULES or not r.get("zone_id"):
            continue
        t = datetime.fromisoformat(r["occurred_at"])
        key = (r["session_key"], r["zone_id"])
        if key in last and (t - last[key]).total_seconds() <= DEDUP_WINDOW_S:
            continue
        last[key] = t
        kept.append(r)
    return kept


def crash_ids(incidents: list[dict]) -> set[str]:
    return {r["incident_id"] for r in crash_events(incidents)}


def describe() -> str:
    """Plain-language rule for source pop-ups and reports."""
    counted = ", ".join(CRASH_RULES.values())
    return (f"Counted as crashes: {counted}. Merged when two fall in the same session and zone within "
            f"{DEDUP_WINDOW_S // 60} minutes. Not counted: plain yellow flags, steward notes without a confirmed "
            "collision, driving-standards notes, track limits and cars that went off and continued.")
