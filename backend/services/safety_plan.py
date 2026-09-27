"""Safety plan: for the corners where incidents happen next to the crowd, a few ways to protect
spectators, each with an estimated price in CAD.

Which corners: the zones next to a grandstand, ranked by serious incidents (services/exposure.py).
Why each one: its real numbers (incidents, marshal call-outs, entry speed, the stands it faces).
Which option is recommended: a plain rule on those real numbers (see `_recommend`).

Prices are ESTIMATES, taken at the LOW END of each estimate. Where a public price exists it is used and
linked; where none exists (F1-grade barriers and debris fences are sold on quotation only) the rate is
marked "estimate". Every rate,
length and seat count used is in PRICES / ASSUMPTIONS below.
"""

from __future__ import annotations

from services import exposure as exposure_service
from services import repository

# Bank of Canada 2025 annual average exchange rates (CAD per unit)
FX = {"USD": 1.3978, "EUR": 1.5782, "GBP": 1.8420}
FX_SOURCE = "https://www.bankofcanada.ca/rates/exchange/annual-average-exchange-rates/"

PRICES = {
    "guardrail": {
        "label": "Steel guardrail (Armco)", "per_m": 28 * FX["GBP"], "currency_note": "GBP 28 / m",
        "provenance": "sourced", "note": "supply only, installation not included",
        "source": "https://www.armcodirect.co.uk/armco-barriers/armco-barrier-prices/",
    },
    "tecpro": {
        "label": "TecPro energy-absorbing barrier", "per_m": 1_600 * FX["USD"], "currency_note": "about USD 1,600 / m",
        "provenance": "estimate", "note": "figure from a public forum, not a quote: ask TecPro for a price",
        "source": "https://rennlist.com/forums/racing-and-drivers-education-forum/989179-safer-barriers.html",
    },
    "debris_fence": {
        "label": "FIA debris fence (6 m)", "per_m_range": (1_000, 3_000), "currency_note": "no public price",
        "provenance": "estimate", "note": "rough estimate only: FIA-homologated fences (e.g. Geobrugg) are priced on quotation",
        "source": "https://www.geobrugg.com/en/Race-circuits-proving-grounds-199514.html",
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
    "rows_closed": 3,              # front rows emptied to move the crowd back
    "seats_per_row": 50,           # seats per row in one grandstand
    "guardrail_rails": 2,          # a double-rail guardrail
    "marshal_callouts": 1.5,       # call-outs per weekend above which cars keep stopping at the barrier
    "fast_apex_kph": 150,          # slowest speed in the corner above which debris flies far (the Monza 2000 wheel)
}
MAX_CORNERS = 3


def _range(lo: float, hi: float | None = None) -> dict:
    hi = lo if hi is None else hi
    return {"low": round(lo, -3), "high": round(hi, -3)}


def _recommend(z: dict, apex_kph: float) -> str:
    """Plain rule on the real numbers:
    cars stop at this barrier often          -> impacts are the danger  -> energy-absorbing barrier
    cars are still fast through the corner   -> debris flies far        -> debris fence
    otherwise (slow corner, fewer stops)     -> give the crowd distance -> close the front rows"""
    if z["marshals_out_per_weekend"] >= ASSUMPTIONS["marshal_callouts"]:
        return "tecpro"
    if apex_kph >= ASSUMPTIONS["fast_apex_kph"]:
        return "debris_fence"
    return "close_rows"


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
        seats = A["rows_closed"] * A["seats_per_row"] * len(stands)
        options = [
            {
                "key": "close_rows", "title": "Move the crowd back",
                "action": f"Close the front {A['rows_closed']} rows of the {len(stands)} grandstand{'s' if len(stands) > 1 else ''} here.",
                "protects_against": "Debris and cars that get past the barrier: the crowd is further away.",
                "cost": _range(seats * ticket["price"]) if ticket else None,
                "cost_basis": (f"{seats} seats × cheapest grandstand ticket ({ticket['currency_note']}), per race weekend"
                               if ticket else "ticket price not available"),
                "recurring": True, "provenance": "sourced ticket price, estimated seat count",
                "source": ticket["source"] if ticket else None,
            },
            {
                "key": "tecpro", "title": "Energy-absorbing barrier",
                "action": f"Replace the barrier along {frontage:.0f} m in front of the stands with TecPro modules.",
                "protects_against": "Cars hitting the barrier: softer impacts, less debris thrown towards the stands.",
                "cost": _range(frontage * PRICES["tecpro"]["per_m"]),
                "cost_basis": f"{frontage:.0f} m × {PRICES['tecpro']['currency_note']} (one-off)",
                "recurring": False, "provenance": PRICES["tecpro"]["provenance"], "source": PRICES["tecpro"]["source"],
                "note": PRICES["tecpro"]["note"],
            },
            {
                "key": "debris_fence", "title": "Higher debris fence",
                "action": f"Install a 6 m FIA debris fence along {frontage:.0f} m in front of the stands.",
                "protects_against": "Wheels and parts flying over the barrier into the crowd.",
                "cost": _range(frontage * PRICES["debris_fence"]["per_m_range"][0]),
                "cost_basis": f"{frontage:.0f} m × CAD 1,000 / m, the low end of CAD 1,000–3,000 / m (one-off, {PRICES['debris_fence']['currency_note']})",
                "recurring": False, "provenance": PRICES["debris_fence"]["provenance"], "source": PRICES["debris_fence"]["source"],
                "note": PRICES["debris_fence"]["note"],
            },
            {
                "key": "guardrail", "title": "Second guardrail line",
                "action": f"Add a double-rail steel guardrail along {frontage:.0f} m in front of the stands.",
                "protects_against": "Slower cars and debris at ground level (a cheap stop-gap, not F1-grade on its own).",
                "cost": _range(frontage * A["guardrail_rails"] * PRICES["guardrail"]["per_m"]),
                "cost_basis": f"{frontage:.0f} m × {A['guardrail_rails']} rails × {PRICES['guardrail']['currency_note']} (one-off)",
                "recurring": False, "provenance": PRICES["guardrail"]["provenance"], "source": PRICES["guardrail"]["source"],
                "note": PRICES["guardrail"]["note"],
            },
        ]
        rec = _recommend(z, tz["v_apex_kph"])
        for o in options:
            o["recommended"] = o["key"] == rec
            o.setdefault("note", None)
        corners.append({
            "zone_id": z["zone_id"], "name": repository.short_name(tz["name"]), "full_name": tz["name"],
            "rank": z["rank"], "serious_per_weekend": z["serious_per_weekend"],
            "marshals_out_per_weekend": z["marshals_out_per_weekend"], "entry_speed_kph": z["entry_speed_kph"],
            "apex_speed_kph": tz["v_apex_kph"], "grandstands": stands, "frontage_m": frontage,
            "why": _why(z, tz["v_apex_kph"], rec),
            "options": sorted(options, key=lambda o: (not o["recommended"], o["cost"]["low"] if o["cost"] else 0)),
        })

    return {
        "circuit": circuit, "currency": "CAD", "corners": corners,
        "assumptions": [
            {"label": "Track in front of one grandstand", "value": f"{A['frontage_per_stand_m']} m (assumed)"},
            {"label": "Crowd moved back", "value": f"front {A['rows_closed']} rows × {A['seats_per_row']} seats per stand (assumed)"},
            {"label": "Exchange rates", "value": f"Bank of Canada 2025: 1 USD = {FX['USD']}, 1 EUR = {FX['EUR']}, 1 GBP = {FX['GBP']} CAD",
             "source": FX_SOURCE},
        ],
        "disclaimer": "Low-end estimates for comparing options, not quotes. F1-grade barriers and debris fences are priced by the supplier on request.",
    }


def _why(z: dict, apex_kph: float, rec: str) -> str:
    busy = f"{z['serious_per_weekend']:.1f} serious incidents and {z['marshals_out_per_weekend']:.1f} marshal call-outs per weekend"
    speed = f"cars arrive at {z['entry_speed_kph']:.0f} km/h and are still at {apex_kph:.0f} km/h at the slowest point"
    reason = {
        "tecpro": "Cars stop at this barrier often, so softening the impacts comes first.",
        "debris_fence": "Cars stay fast through here, so debris can clear the barrier (as a wheel did at Monza in 2000): the fence comes first.",
        "close_rows": "It's a slow corner with fewer stops, so giving the crowd more distance is the quickest fix.",
    }[rec]
    return f"{busy}; {speed}. {reason}"
