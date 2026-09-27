"""Third-party exposure: the evidence a circuit owner gives its liability insurer.

Three facts per circuit, all counted from the Step 1 data (no prices, no model parameters):

  1. How often people are exposed  - double yellows (a car stopped on track, marshals go out) per race weekend
  2. Where                          - share of serious incidents in zones next to a grandstand, vs how much
                                      of the lap those zones cover
  3. It is predictable              - backtest: the 3 busiest zones in earlier years, and the share of the
                                      next year's serious incidents that happened there

"Serious incident" = a Step 1 incident flagged loss_relevant: collision, car stopped (double yellow),
yellow flag (hazard on track), unsafe rejoin. Track limits and administrative messages are left out.

Plus sourced context (crowd size, what has happened before, why insurance is under pressure), each with
its link.
"""

from __future__ import annotations

from collections import Counter

from services import repository

TOP_K = 3
MARSHALS_OUT = "stopped"          # Step 1 type for a double yellow: car stopped, marshals on track

TASK_FORCE = {
    "text": "In September 2025 the FIA set up a global task force on motorsport insurance, citing "
            "escalating premiums, restricted coverage and reduced access.",
    "source": "https://api.fia.com/news/fia-president-launches-new-global-task-force-tackle-rising-costs-motorsport-insurance",
}

CONTEXT = {
    "monza": {
        "attendance": 369_041, "attendance_year": 2025,
        "attendance_source": "https://gpdestinations.com/attendance-reaches-370000-at-2025-italian-grand-prix/",
        "history_year": 2000,
        "history": "A marshal was killed by a wheel that flew over the barrier after a first-lap crash.",
        "history_source": "https://www.autosport.com/general/news/september-10-marshal-killed-at-monza-5018164/5018164/",
    },
    "montreal": {
        "attendance": 352_000, "attendance_year": 2025,
        "attendance_source": "https://gpdestinations.com/2025-canadian-grand-prix-weekend-attendance/",
        "history_year": 2013,
        "history": "A marshal was killed by the recovery vehicle while removing a stopped car.",
        "history_source": "https://www.autosport.com/f1/news/safety-failings-blamed-for-canadian-gp-marshal-death-4470426/4470426/",
    },
}


def _tier(score: int) -> str:
    return "CRITICAL" if score >= 85 else "HIGH" if score >= 60 else "MEDIUM" if score >= 25 else "LOW"


def _backtest(serious: list[dict], seasons: list[int], zone_names: dict[str, str], n_zones: int) -> dict:
    """For each year after the first: the TOP_K busiest zones in earlier years only, and how many of that
    year's serious incidents happened there. Chance = TOP_K / number of zones."""
    years, hits, total = [], 0, 0
    for year in seasons[1:]:
        past = Counter(r["zone_id"] for r in serious if r["season"] < year)
        top = [z for z, _ in past.most_common(TOP_K)]
        now = [r for r in serious if r["season"] == year]
        h = sum(r["zone_id"] in top for r in now)
        hits, total = hits + h, total + len(now)
        years.append({"season": year, "trained_on": f"{seasons[0]}–{year - 1}" if year - 1 > seasons[0] else str(seasons[0]),
                      "predicted": [zone_names[z] for z in top], "hits": h, "total": len(now)})
    share = hits / total if total else 0.0
    chance = TOP_K / n_zones
    return {"top_k": TOP_K, "years": years, "hits": hits, "total": total, "share": share,
            "chance_share": chance, "lift": share / chance if chance else 0.0}


def exposure(circuit: str) -> dict:
    d = repository.load(circuit)
    track = d.track
    seasons = track["data_coverage"]["seasons"]
    weekends = len(seasons)
    zones = track["zones"]
    names = {z["zone_id"]: repository.short_name(z["name"]) for z in zones}
    serious = [r for r in d.incidents if r["loss_relevant"]]
    marshals = [r for r in serious if r["incident_type"] == MARSHALS_OUT]

    by_zone = Counter(r["zone_id"] for r in serious)
    marshals_by_zone = Counter(r["zone_id"] for r in marshals)
    crowd_zones = {z["zone_id"] for z in zones if z["grandstands"]}
    near = sum(by_zone[z] for z in crowd_zones)
    crowd_lap = sum(z["length_m"] for z in zones if z["zone_id"] in crowd_zones) / track["length_m"]
    peak = max(by_zone.values(), default=0) / weekends or 1.0

    zone_rows = []
    for rank, (zid, _) in enumerate(sorted(((z["zone_id"], by_zone[z["zone_id"]]) for z in zones),
                                            key=lambda kv: -kv[1]), start=1):
        z = next(z for z in zones if z["zone_id"] == zid)
        per_wkd = by_zone[zid] / weekends
        score = int(round(100 * per_wkd / peak))
        zone_rows.append({
            "zone_id": zid, "rank": rank,
            "serious_total": by_zone[zid], "serious_per_weekend": per_wkd,
            "marshals_out_total": marshals_by_zone[zid], "marshals_out_per_weekend": marshals_by_zone[zid] / weekends,
            "near_crowd": zid in crowd_zones, "grandstands": z["grandstands"],
            "entry_speed_kph": z["v_entry_kph"],
            "by_season": [{"season": y, "count": sum(r["zone_id"] == zid and r["season"] == y for r in serious)}
                          for y in seasons],
            "score": score, "tier": _tier(score),
        })

    ctx = CONTEXT.get(circuit, {})
    sessions = len(track["data_coverage"]["sessions"])
    measured = lambda title, detail: {"provenance": "measured", "title": title, "detail": detail}  # noqa: E731
    return {
        "circuit": circuit,
        "weekends": weekends, "sessions": sessions, "seasons": seasons,
        "serious_total": len(serious), "serious_per_weekend": len(serious) / weekends,
        "marshals_out_total": len(marshals), "marshals_out_per_weekend": len(marshals) / weekends,
        "near_crowd_total": near, "near_crowd_share": near / len(serious) if serious else 0.0,
        "crowd_lap_share": crowd_lap,
        "backtest": _backtest(serious, seasons, names, len(zones)),
        "top_zones": [r["zone_id"] for r in zone_rows[:TOP_K]],
        "zones": zone_rows,
        "context": {
            "attendance": ctx.get("attendance"), "attendance_year": ctx.get("attendance_year"),
            "attendance_source": ctx.get("attendance_source"),
            "history_year": ctx.get("history_year"), "history": ctx.get("history"),
            "history_source": ctx.get("history_source"),
            "task_force": TASK_FORCE["text"], "task_force_source": TASK_FORCE["source"],
        },
        "sources": {
            "data": measured("Race-control data",
                             f"{sessions} sessions over {weekends} race weekends ({seasons[0]}–{seasons[-1]}) from OpenF1: "
                             "every flag, steward note and track-limits message, placed on the track zone where it happened."),
            "serious": measured("Serious incidents",
                                "Collisions, cars stopped on track (double yellow), yellow flags (a hazard on track) and unsafe "
                                "rejoins. Track-limits warnings and administrative notes are not counted. Repeats of the same "
                                "incident are counted once."),
            "marshals": measured("Marshals on a live track",
                                 "Double yellow flags: race control shows these when a car is stopped on or beside the track "
                                 "and marshals go out to clear it."),
            "crowd": measured("Next to the crowd",
                              "Zones with a grandstand, from the circuit's official grandstand list (which corners each "
                              "stand overlooks). Compared with how much of the lap those zones cover."),
            "backtest": measured("It predicts the next season",
                                 f"For each year, the {TOP_K} busiest zones from earlier years only, and the share of that "
                                 f"year's serious incidents that happened there. Chance = {TOP_K} of {len(zones)} zones "
                                 "(incidents spread evenly across zones)."),
            "attendance": measured("Crowd", f"Reported weekend attendance, {ctx.get('attendance_year')}: "
                                            f"{ctx.get('attendance_source')}") if ctx else None,
            "history": measured("It has happened here", f"{ctx.get('history_source')}") if ctx else None,
        },
    }
