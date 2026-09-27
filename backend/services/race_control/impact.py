"""Insurance side of a race-control incident: what this crash costs and which covered structures it threatens.

Uses the same Step 2 model as the risk map (insurance_model.crash_cost_eur: barrier repair + car damage for
the impact energy, deterministic, before the model's lognormal noise), the zone's barrier type and modelled
risk, and the real OpenStreetMap structures around the crash point.
"""
from __future__ import annotations

import math

import insurance_model as im
from services import actuarial, repository

DEBRIS_REACH_M = 100.0     # assumed: structures this close can be hit by debris or a car leaving the track


def _centroid(points: list) -> tuple[float, float]:
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return sum(xs) / len(xs), sum(ys) / len(ys)


def crash_impact(circuit: str, zone_id: str, x: float, y: float, impact_speed_kph: float | None) -> dict:
    zone = next(z for z in repository.load(circuit).track["zones"] if z["zone_id"] == zone_id)
    cfg = im.ModelConfig()
    barrier = im._norm_barrier(zone.get("barrier_type"))
    speed = impact_speed_kph if impact_speed_kph is not None else zone["v_apex_kph"] * cfg.impact_speed_factor
    energy = float(im.kinetic_energy_mj(speed, cfg.car_mass_kg))
    cost = float(min(im.crash_cost_eur(energy, barrier, cfg), cfg.max_loss_per_incident_eur))

    risk = next((z for z in actuarial.risk_map(circuit, "f1")["zones"] if z["zone_id"] == zone_id), None)
    assets = repository.assets(circuit)
    extent = assets["extent_m"]
    near = []
    for a in assets["assets"]:
        if a["category"] == "barrier":
            continue
        cx, cy = _centroid(a["points"])
        d = math.hypot(cx - x, cy - y) * extent
        if d <= actuarial.EXPOSURE_REACH_M:
            near.append({"asset_id": a["asset_id"], "name": a.get("name"), "category": a["category"],
                         "distance_m": round(d), "coverage": a["coverage"],
                         "position_source": a.get("position_source", "osm")})
    near.sort(key=lambda a: a["distance_m"])
    lines = {"participant_accident", "track_infrastructure"}
    for a in near:
        if a["distance_m"] <= DEBRIS_REACH_M:
            lines.update(a["coverage"])
    return {
        "zone_id": zone_id, "zone_name": repository.short_name(zone["name"]), "barrier_type": zone.get("barrier_type"),
        "impact_speed_kph": round(speed), "impact_speed_source": "telemetry" if impact_speed_kph is not None else "assumed",
        "energy_mj": round(energy, 2), "estimated_cost_eur": round(cost, -3),
        "zone_mean_cost_eur": round(risk["mean_cost_per_crash_eur"], -3) if risk and risk.get("mean_cost_per_crash_eur") else None,
        "zone_risk_score": risk["risk_score"] if risk else None, "zone_tier": risk["risk_tier"] if risk else None,
        "structures_at_risk": near[:6], "structures_in_reach": len(near),
        "lines_engaged": sorted(lines),
        "sources": {
            "cost": "Step 2 model: barrier repair + car damage for ½mv² at the impact speed (m = 800 kg), "
                    f"barrier '{barrier}' (assumed by zone type). Before the model's severity noise.",
            "structures": f"OpenStreetMap structures within {actuarial.EXPOSURE_REACH_M:.0f} m of the crash point; "
                          f"lines engaged by those within {DEBRIS_REACH_M:.0f} m (assumed debris reach).",
        },
    }
