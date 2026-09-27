"""Safety plan: low-cost ways to protect spectators and marshals at the corners where incidents happen
next to the crowd, each with a rough price in CAD.

Which corners: the zones next to a grandstand, ranked by serious incidents (services/exposure.py).
Why each one: its real numbers (incidents, marshal call-outs, entry speed, the stands it faces).
Plus one thing for the whole circuit: send the insurer the incident report every season, with the
year-by-year count at these corners.

Prices are rough, at the LOW END: a public price where one exists (linked), otherwise free because it
only moves people or changes a rule. Every rate and count used is in PRICES / ASSUMPTIONS below.
"""

from __future__ import annotations

import math

from services import exposure as exposure_service
from services import repository

# Bank of Canada 2025 annual average exchange rates (CAD per unit)
FX = {"USD": 1.3978, "EUR": 1.5782, "GBP": 1.8420}
FX_SOURCE = "https://www.bankofcanada.ca/rates/exchange/annual-average-exchange-rates/"

PRICES = {
    "guardrail": {
        "label": "Steel guardrail (Armco)", "per_m": 28 * FX["GBP"], "currency_note": "GBP 28 / m",
        "note": "supply only, installation not included",
        "source": "https://www.armcodirect.co.uk/armco-barriers/armco-barrier-prices/",
    },
    "camera": {
        "label": "Outdoor PTZ camera (Reolink TrackMix PoE)", "each": 199.99 * FX["USD"], "currency_note": "USD 199.99 each",
        "note": "camera only; cabling and a recorder not included",
        "source": "https://store.reolink.com/us/ptz-camera/",
    },
    "fence_hire": {
        "label": "Temporary crowd fence hire (Heras panel, 3.5 m)", "per_panel_week": 5.50 * FX["GBP"], "panel_m": 3.5,
        "currency_note": "GBP 5.50 per panel per week", "note": "hire price before VAT and delivery",
        "source": "https://hirein.co.uk/temporary-heras-fencing/",
    },
    "marshal_training": {
        "label": "Marshal training day",
        "note": "training days are run free by licensed trainers (e.g. Motorsport UK)",
        "source": "https://motorsportuk.org/volunteers/marshals/marshals-training/",
    },
}

# Cheapest published grandstand seat for the whole race weekend (official ticket sites).
TICKETS = {
    "monza": {"price": 665 * FX["EUR"], "currency_note": "EUR 665 (Ascari, 2026)",
              "source": "https://gpticketshop.com/en/f1/italian-f1-grand-prix/tickets.html"},
    "montreal": {"price": 630, "currency_note": "CAD 630 (Grandstand 10, 2026)",
                 "source": "https://2026.gpcanada.ca/en/vitrine/2026/"},
}

ASSUMPTIONS = {
    "frontage_per_stand_m": 100,   # length of track in front of one grandstand
    "guardrail_rails": 2,          # a double-rail guardrail
    "cameras_per_corner": 2,       # one on the barrier, one on the crowd side
}
MAX_CORNERS = 3


def _range(lo: float, hi: float | None = None) -> dict:
    """Round to the nearest CAD 100 (small costs) or CAD 1,000."""
    hi = lo if hi is None else hi
    step = -2 if hi < 10_000 else -3
    return {"low": round(lo, step), "high": round(hi, step)}


def safety_plan(circuit: str) -> dict:
    e = exposure_service.exposure(circuit)
    track = repository.load(circuit).track
    zones = {z["zone_id"]: z for z in track["zones"]}
    ticket = TICKETS.get(circuit)
    A = ASSUMPTIONS

    corners = []
    for z in [z for z in e["zones"] if z["near_crowd"]][:MAX_CORNERS]:
        tz = zones[z["zone_id"]]
        stands = z["grandstands"]
        frontage = min(tz["length_m"], A["frontage_per_stand_m"] * len(stands))
        panels = math.ceil(frontage / PRICES["fence_hire"]["panel_m"])
        cams = A["cameras_per_corner"]
        options = [
            {
                "key": "crews", "title": "Put crews at this corner",
                "action": "Station a medical car, fire crew and recovery team here instead of spreading them evenly.",
                "protects_against": "Slow response: help reaches a crash here in seconds.",
                "cost": _range(0), "cost_basis": "Free: moves crews you already have",
                "recurring": True, "provenance": "free", "source": None, "note": None,
            },
            {
                "key": "marshal_training", "title": "Refresher training for the marshals here",
                "action": f"Brief the marshals at this corner on its incidents ({z['marshals_out_per_weekend']:.1f} call-outs per weekend) before each event.",
                "protects_against": "Marshals hurt while recovering cars, and slow recoveries.",
                "cost": _range(0), "cost_basis": "Free: " + PRICES["marshal_training"]["note"],
                "recurring": True, "provenance": "sourced", "source": PRICES["marshal_training"]["source"], "note": None,
            },
            {
                "key": "move_crowd", "title": "Move standing areas back",
                "action": f"Set grass banks and standing areas back from the barrier with {panels} temporary fence panels along {frontage:.0f} m.",
                "protects_against": "Debris and cars reaching people standing close to the track.",
                "cost": _range(panels * PRICES["fence_hire"]["per_panel_week"]),
                "cost_basis": f"{panels} panels × {PRICES['fence_hire']['currency_note']}, per race weekend",
                "recurring": True, "provenance": "sourced", "source": PRICES["fence_hire"]["source"], "note": PRICES["fence_hire"]["note"],
            },
            {
                "key": "cameras", "title": "Cameras on this corner",
                "action": f"Put {cams} cameras here: one on the barrier, one on the crowd.",
                "protects_against": "Slow response, and claims you can't check: every incident is on video.",
                "cost": _range(cams * PRICES["camera"]["each"]),
                "cost_basis": f"{cams} × {PRICES['camera']['currency_note']} (one-off)",
                "recurring": False, "provenance": "sourced", "source": PRICES["camera"]["source"], "note": PRICES["camera"]["note"],
            },
            {
                "key": "guardrail", "title": "Second guardrail line",
                "action": f"Add a double-rail steel guardrail along {frontage:.0f} m in front of the stands.",
                "protects_against": "Slower cars and debris at ground level.",
                "cost": _range(frontage * A["guardrail_rails"] * PRICES["guardrail"]["per_m"]),
                "cost_basis": f"{frontage:.0f} m × {A['guardrail_rails']} rails × {PRICES['guardrail']['currency_note']} (one-off)",
                "recurring": False, "provenance": "sourced", "source": PRICES["guardrail"]["source"], "note": PRICES["guardrail"]["note"],
            },
        ]
        corners.append({
            "zone_id": z["zone_id"], "name": repository.short_name(tz["name"]), "full_name": tz["name"],
            "rank": z["rank"], "serious_per_weekend": z["serious_per_weekend"],
            "marshals_out_per_weekend": z["marshals_out_per_weekend"], "entry_speed_kph": z["entry_speed_kph"],
            "apex_speed_kph": tz["v_apex_kph"], "grandstands": stands, "frontage_m": frontage,
            "why": _why(z, tz["v_apex_kph"]),
            "options": options,
        })

    # The report for the insurer: serious incidents at these corners, year by year (one race weekend a year).
    picked = {c["zone_id"] for c in corners}
    trend = [{"season": y, "count": sum(bs["count"] for z in e["zones"] if z["zone_id"] in picked
                                        for bs in z["by_season"] if bs["season"] == y)}
             for y in e["seasons"]]

    return {
        "circuit": circuit, "currency": "CAD", "corners": corners,
        "report": {
            "title": "Send your insurer the incident report every season",
            "action": "Share it before each renewal: where incidents happen, how often marshals go out, and the "
                      "year-by-year count at these corners. Once the fixes are in, a falling count is the proof they work.",
            "cost": _range(0), "cost_basis": "Free: Circuit Guard builds it from your race control log",
            "trend": trend,
        },
        "assumptions": [
            {"label": "Track in front of one grandstand", "value": f"{A['frontage_per_stand_m']} m (assumed)"},
            {"label": "Cameras per corner", "value": f"{A['cameras_per_corner']} (assumed)"},
            {"label": "Exchange rates", "value": f"Bank of Canada 2025: 1 USD = {FX['USD']}, 1 EUR = {FX['EUR']}, 1 GBP = {FX['GBP']} CAD",
             "source": FX_SOURCE},
        ],
        "disclaimer": "Rough prices at the low end, to compare options. Not quotes.",
    }


def _why(z: dict, apex_kph: float) -> str:
    busy = f"{z['serious_per_weekend']:.1f} serious incidents and {z['marshals_out_per_weekend']:.1f} marshal call-outs per weekend"
    speed = f"cars arrive at {z['entry_speed_kph']:.0f} km/h and are still at {apex_kph:.0f} km/h at the slowest point"
    return f"{busy}; {speed}, right next to the crowd."
