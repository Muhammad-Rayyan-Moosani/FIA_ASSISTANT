"""R2 ⇄ R3 · Run the Step 2 insurance model (insurance_model.py) on real Step 1 data, shaped for the API.

insurance_model.py is the maths (Rushil, R2): Jeffreys Poisson-Gamma frequency per zone, lognormal
impact speed → kinetic energy → barrier + car repair cost, 10,000-season Monte Carlo with common random
numbers, and zone vs blanket pricing. This module only adapts inputs and outputs:

  Step 1 zone / incident  →  model input
    zone.v_entry_kph      →  corner_speed_kph   (impact speed = corner speed × 0.75 prior; no measured impacts)
    zone.barrier_type     →  barrier_type       (tyre_wall→tirewall, guardrail→armco, …)
    counted crashes per zone (services/crash_filter.py) → n_crashes
    seasons in data_coverage          → seasons of exposure (one race weekend per season)
    race laps × grid                  → car-passes (only for the per-pass probability; not shown in the UI)

  Series factors (F2 / F3): frequency × grid × error; impact energy × energy (via car mass, E = ½mv²).
  What-if changes use the model's own levers: barrier_type, speed_factor, frequency_multiplier.
"""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass, replace
from functools import lru_cache

import numpy as np
import pandas as pd
from scipy import stats

import insurance_model as im
from services import crash_filter, repository

N_SEASONS = 10_000
SEED = 42
MODEL_VERSION = "step2-insurance-model"
COST_OF_CAPITAL = 0.08
EXPENSE_RATIO = 0.15
BLANKET_BASIS = 0.75
SEVERE_QUANTILE = 0.95        # crashes costlier than 95% of all simulated crashes are flagged "severe"

SERIES_FACTORS: dict[str, dict[str, float]] = {
    # Project brief defaults (ARCHITECTURE.md §4.5). Assumptions, not measurements: OpenF1 has no F2/F3 data.
    "f1": {"grid": 1.0, "error": 1.0, "energy": 1.0},
    "f2": {"grid": 1.1, "error": 1.3, "energy": 0.8},
    "f3": {"grid": 1.5, "error": 1.8, "energy": 0.6},
}


class UnknownZone(KeyError):
    pass


# ----------------------------------------------------------------------------- inputs
def load_model_inputs(circuit: str) -> tuple[list[dict], pd.DataFrame]:
    """Step 1 data for one circuit in the input schema documented at the top of insurance_model.py."""
    d = repository.load(circuit)
    return _model_inputs(circuit, d.version)


@lru_cache(maxsize=4)
def _model_inputs(circuit: str, version: float) -> tuple[list[dict], pd.DataFrame]:
    d = repository.load(circuit)
    zones = d.track["zones"]
    seasons = d.track["data_coverage"]["seasons"]
    track = {
        "track_id": circuit, "name": d.track["name"], "laps": d.cfg.race_laps, "grid_size": d.cfg.grid_size,
        "races_per_season": 1, "seasons_observed": len(seasons),
        "zones": [{"zone_id": z["zone_id"], "name": z["name"], "corner_speed_kph": z["v_entry_kph"],
                   "barrier_type": z["barrier_type"]} for z in zones],
    }
    speed = {z["zone_id"]: z["v_entry_kph"] for z in zones}
    barrier = {z["zone_id"]: z["barrier_type"] for z in zones}
    rows = [{"incident_id": r["incident_id"], "track_id": circuit, "zone_id": r["zone_id"], "season": r["season"],
             "corner_speed_kph": speed[r["zone_id"]], "impact_speed_kph": np.nan,
             "barrier_type": barrier[r["zone_id"]], "x": r["x"], "y": r["y"]}
            for r in crash_filter.crash_events(d.incidents) if r["zone_id"] in speed]
    cols = ["incident_id", "track_id", "zone_id", "season", "corner_speed_kph", "impact_speed_kph", "barrier_type", "x", "y"]
    return [track], pd.DataFrame(rows, columns=cols)


# ----------------------------------------------------------------------------- scenario runs
def upgrades_key(upgrades: dict[str, dict] | None) -> str:
    clean = {z: {k: v for k, v in c.items() if v is not None} for z, c in (upgrades or {}).items()}
    return json.dumps({z: c for z, c in sorted(clean.items()) if c}, sort_keys=True, separators=(",", ":"))


def _model_changes(c: dict) -> dict:
    return {k: v for k, v in c.items() if v is not None and k in ("barrier_type", "speed_factor", "frequency_multiplier")}


@dataclass(frozen=True)
class Run:
    circuit: str
    series: str
    res: im.SimResults
    pr: dict
    zones: list[im.ZoneModel]


def run(circuit: str, series: str, upgrades: dict[str, dict] | None = None) -> Run:
    if series not in SERIES_FACTORS:
        raise ValueError(f"Unknown series {series!r}")
    version = repository.data_version(circuit)
    return _run(circuit, series, upgrades_key(upgrades), version)


@lru_cache(maxsize=64)
def _run(circuit: str, series: str, upgrades_json: str, version: float) -> Run:
    tracks, incidents = _model_inputs(circuit, version)
    f = SERIES_FACTORS[series]
    base = im.ModelConfig(seed=SEED)
    cfg = replace(base, car_mass_kg=base.car_mass_kg * f["energy"])
    zones = im.build_zone_models(tracks, incidents, cfg)
    ids = {z.zone_id: i for i, z in enumerate(zones)}
    for z in zones:
        z.frequency_multiplier = f["grid"] * f["error"]
    for zone_id, changes in json.loads(upgrades_json).items():
        if zone_id not in ids:
            raise UnknownZone(zone_id)
        zones[ids[zone_id]] = im._apply_changes(zones[ids[zone_id]], _model_changes(changes), cfg)
    seeds = np.random.SeedSequence(cfg.seed).spawn(len(zones))
    loss = np.column_stack([im._simulate_zone(z, N_SEASONS, cfg, s) for z, s in zip(zones, seeds)])
    res = im._assemble(zones, loss, cfg, seeds)
    pr = im.price(res, cost_of_capital=COST_OF_CAPITAL, expense_ratio=EXPENSE_RATIO, blanket_basis=BLANKET_BASIS)
    return Run(circuit, series, res, pr, zones)


def _score_reference(circuit: str) -> float:
    """Score scale: the most expensive zone in the F1 baseline scores 100, so F2/F3 and upgrades move the colours."""
    base = run(circuit, "f1")
    return float(base.pr["zone_premiums"]["premium"].max()) or 1.0


def _tier(score: int) -> str:
    return "CRITICAL" if score >= 85 else "HIGH" if score >= 60 else "MEDIUM" if score >= 25 else "LOW"


def _score(premium: float, ref: float) -> int:
    return int(round(min(100.0, 100.0 * math.sqrt(max(premium, 0.0) / ref))))


# ----------------------------------------------------------------------------- risk map
def risk_map(circuit: str, series: str, upgrades: dict[str, dict] | None = None) -> dict:
    r = run(circuit, series, upgrades)
    ref = _score_reference(circuit)
    zs, zp = r.res.zone_stats, r.pr["zone_premiums"]
    loss = r.res.context.loss
    zones = []
    trm_total = 0.0
    for j, zm in enumerate(r.zones):
        s, p = zs.iloc[j], zp.iloc[j]
        a = zm.n_crashes + 0.5                     # Jeffreys posterior used by the simulation
        scale = zm.frequency_multiplier / zm.seasons_exposure
        trm = COST_OF_CAPITAL * max(float(s["var99"]) - float(s["eal"]), 0.0) / (1 - EXPENSE_RATIO)
        trm_total += trm
        score = _score(float(p["premium"]), ref)
        zones.append({
            "zone_id": zm.zone_id, "risk_score": score, "risk_tier": _tier(score),
            "crash_rate": {"mean": a * scale, "lo90": float(stats.gamma.ppf(0.05, a)) * scale,
                           "hi90": float(stats.gamma.ppf(0.95, a)) * scale,
                           "n_incidents": zm.n_crashes, "exposure": zm.seasons_exposure},
            "crash_prob_season": float((loss[:, j] > 0).mean()),
            "energy_kj_mean": float(s["mean_energy_mj"]) * 1000,
            "mean_cost_per_crash_eur": float(s["mean_cost_per_crash"]),
            "eal_eur": float(s["eal"]), "var99_eur": float(s["var99"]),
            "share_of_loss_pct": float(s["eal_share"]) * 100,
            "premium_eur": float(p["premium"]), "tail_risk_margin_eur": trm,
            "recommended_limit_eur": float(s["var99"]),
        })
    t = r.res.track_stats.iloc[0]
    f = SERIES_FACTORS[series]
    return {
        "circuit": circuit, "series": series, "series_factors": f,
        "model_version": MODEL_VERSION, "params_hash": _params_hash(r.res.context.cfg),
        "n_seasons": N_SEASONS, "seed": SEED,
        "totals": {
            "eal_eur": float(t["eal"]), "var99_eur": float(t["var99"]), "tvar99_eur": float(t["tvar99"]),
            "blanket_premium_eur": r.pr["blanket_premium"], "segmented_premium_eur": r.pr["zone_premium_total"],
            "cost_delta_eur": r.pr["net_saved"], "cost_delta_pct": r.pr["net_saved_pct"] * 100,
            "diversification_benefit_eur": float(zs["var99"].sum() - t["var99"]),
            "tail_risk_margin_eur": trm_total,
        },
        "zones": zones,
        "assumptions": _assumptions(circuit, r),
        "sources": _risk_sources(circuit, r),
    }


def _params_hash(cfg: im.ModelConfig) -> str:
    blob = json.dumps({"cfg": repr(cfg), "coc": COST_OF_CAPITAL, "exp": EXPENSE_RATIO, "blanket": BLANKET_BASIS})
    return hashlib.sha256(blob.encode()).hexdigest()[:12]


def _assumptions(circuit: str, r: Run) -> list[dict]:
    cfg = r.res.context.cfg
    seasons = repository.load(circuit).track["data_coverage"]["seasons"]
    barriers = " · ".join(f"{name} €{b.fixed_eur / 1000:.0f}k + €{b.per_mj_eur / 1000:.0f}k/MJ, "
                          f"{b.energy_transfer:.0%} to car" for name, b in cfg.barriers.items() if name != "unknown")
    f = SERIES_FACTORS[r.series]
    return [
        {"key": "exposure", "label": "Exposure", "provenance": "measured",
         "value": f"{len(seasons)} race weekends ({seasons[0]}–{seasons[-1]}), every session type"},
        {"key": "impact_speed", "label": "Impact speed", "provenance": "assumed",
         "value": f"{cfg.impact_speed_factor:.0%} of the zone's entry speed (no measured impact speeds yet), lognormal spread"},
        {"key": "car_mass", "label": "Car mass", "provenance": "assumed",
         "value": f"{cfg.car_mass_kg:.0f} kg (800 kg × energy factor {f['energy']})"},
        {"key": "barrier_costs", "label": "Barrier repair cost", "provenance": "assumed", "value": barriers},
        {"key": "car_damage", "label": "Car damage", "provenance": "assumed",
         "value": f"€{cfg.car_damage_eur_per_mj:,.0f} per MJ reaching the car, capped at €{cfg.max_loss_per_incident_eur / 1e6:.0f}M per crash"},
        {"key": "pricing", "label": "Pricing", "provenance": "assumed",
         "value": f"premium = (EAL + {COST_OF_CAPITAL:.0%} × (VaR99 − EAL)) ÷ (1 − {EXPENSE_RATIO:.0%} expenses)"},
        {"key": "blanket", "label": "Blanket policy", "provenance": "assumed",
         "value": f"every zone charged the {BLANKET_BASIS:.0%} quantile of this circuit's zone premiums"},
        {"key": "series", "label": "Series factors", "provenance": "assumed",
         "value": "F2 grid 1.1 × error 1.3, energy 0.8 · F3 grid 1.5 × error 1.8, energy 0.6"},
    ]


def _risk_sources(circuit: str, r: Run) -> dict:
    d = repository.load(circuit)
    cov = d.track["data_coverage"]
    n_seasons = len(cov["seasons"])
    model = ("Step 2 model (insurance_model.py): crash rate per zone from its counted crashes with a Jeffreys "
             "Gamma posterior; impact speed → energy E = ½mv² → barrier repair + car damage cost; "
             f"{N_SEASONS:,} simulated race weekends.")
    placeholder = ("Barrier costs, car-damage cost and impact-speed share are placeholders, so the euro values show the "
                   "method rather than a quotable price.")
    src = lambda title, detail: {"provenance": "modelled", "title": title, "detail": f"{detail}\n\n{model}\n\n{placeholder}"}  # noqa: E731
    return {
        "premium": src("Zone-based premium", "Sum of every zone's premium. Zone premium = (expected loss + 8% of the gap between "
                                             "its 1-in-100 worst weekend and its expected loss) ÷ (1 − 15% expenses)."),
        "blanket": src("Blanket premium", f"What a flat policy charges when every zone pays the same rate: the {BLANKET_BASIS:.0%} "
                                          "quantile of this circuit's zone premiums, times the number of zones."),
        "saving": src("Saving", "Blanket premium minus zone-based premium: the cross-subsidy removed when each zone is priced "
                                "on its own risk. It depends on the blanket rule above."),
        "eal": src("Expected loss (EAL)", "Average simulated loss per race weekend."),
        "var99": src("1-in-100 worst case (VaR99)", "The loss exceeded in only 1% of simulated weekends."),
        "diversification": src("Diversification", "Sum of each zone's own VaR99 minus the circuit's VaR99: bad weekends rarely "
                                                  "hit every zone at once."),
        "series_factors": {"provenance": "assumed", "title": "Series factors",
                           "detail": "F2 and F3 race at Monza but OpenF1 has no F2/F3 data. Their risk is F1's crash rate × "
                                     "grid × error factors, with impact energy × the energy factor (project brief defaults)."},
        "crash_rate": src("Crashes per weekend", f"Counted crashes in this zone over {n_seasons} race weekends "
                                                 f"({cov['seasons'][0]}–{cov['seasons'][-1]}), Jeffreys Gamma posterior mean "
                                                 f"and 90% interval, times the series factor.\n\n{crash_filter.describe()}"),
        "crash_prob": src("Chance of a crash", "Share of simulated weekends with at least one crash in this zone."),
        "energy": src("Mean impact energy", "E = ½mv² at the simulated impact speed (75% of the real entry speed, lognormal spread)."),
        "zone_premium": src("Zone premium", "(expected loss + 8% × (VaR99 − expected loss)) ÷ 0.85."),
        "limit": src("Recommended cover limit", "The zone's 1-in-100 worst weekend (VaR99)."),
        "score": src("Risk score", "100 × √(zone premium ÷ most expensive F1 zone premium at this circuit), capped at 100. "
                                   "LOW < 25 ≤ MEDIUM < 60 ≤ HIGH < 85 ≤ CRITICAL."),
        "what_if": src("Safety what-if", "Re-runs the zone with the same random numbers after changing the barrier type, "
                                         "impact speed or crash frequency, then reprices the circuit."),
        "simulation": src("Simulated season", "Replays sampled weekends from the Monte Carlo; crash positions are spread along "
                                              "the zone because the model prices zones, not exact points."),
        "report": src("Underwriter report", "Generated from the model output above with a fixed template."),
    }


# ----------------------------------------------------------------------------- what-if
def _snapshot(rm: dict, zone_id: str) -> dict:
    z = next(z for z in rm["zones"] if z["zone_id"] == zone_id)
    return {k: z[k] for k in ("eal_eur", "var99_eur", "premium_eur", "risk_score")}


def what_if(circuit: str, series: str, zone_id: str, changes: dict, upgrades: dict[str, dict]) -> dict:
    others = {z: c for z, c in upgrades.items() if z != zone_id}
    before = risk_map(circuit, series, others)
    if zone_id not in {z["zone_id"] for z in before["zones"]}:
        raise UnknownZone(zone_id)
    after = risk_map(circuit, series, {**others, zone_id: changes})
    return {
        "zone_id": zone_id, "before": _snapshot(before, zone_id), "after": _snapshot(after, zone_id),
        "circuit_premium_before_eur": before["totals"]["segmented_premium_eur"],
        "circuit_premium_after_eur": after["totals"]["segmented_premium_eur"],
        "risk_map": after,
    }


# ----------------------------------------------------------------------------- simulation replay
def simulation_events(circuit: str, series: str, upgrades: dict[str, dict] | None, seasons: int) -> dict:
    """Every simulated crash in the first `seasons` weekends of the Monte Carlo (same random numbers as the
    risk map), placed along its zone, plus the running expected loss for the convergence chart."""
    r = run(circuit, series, upgrades)
    ctx = r.res.context
    track_zones = {z["zone_id"]: z for z in repository.load(circuit).track["zones"]}
    crashes, all_costs = [], []
    for zm, seed in zip(r.zones, ctx.seeds):
        _, (season_idx, _speed, energy, cost) = im._simulate_zone(zm, N_SEASONS, ctx.cfg, seed, detail=True)
        all_costs.append(cost)
        z = track_zones[zm.zone_id]
        for k in np.flatnonzero(season_idx < seasons):
            # golden-ratio spacing spreads repeat crashes along the zone deterministically
            frac = z["start_frac"] + (z["end_frac"] - z["start_frac"]) * ((len(crashes) * 0.618034) % 1.0)
            x, y = repository.outline_point(circuit, frac)
            crashes.append({"season": int(season_idx[k]), "zone_id": zm.zone_id, "x": x, "y": y,
                            "lap_frac": round(frac, 4), "energy_kj": float(energy[k]) * 1000, "loss_eur": float(cost[k])})
    costs = np.concatenate(all_costs) if all_costs else np.zeros(0)
    threshold = float(np.quantile(costs, SEVERE_QUANTILE)) if costs.size else math.inf
    for c in crashes:
        c["severe"] = c["loss_eur"] >= threshold
    total = r.res.annual_losses
    running = [float(total[: max(1, round((k + 1) / seasons * N_SEASONS))].mean()) for k in range(seasons)]
    return {"crashes": sorted(crashes, key=lambda c: c["season"]), "running_eal": running,
            "eal": float(total.mean()), "var99": float(np.quantile(total, 0.99)),
            "se": float(total.std(ddof=1) / math.sqrt(N_SEASONS))}


# ----------------------------------------------------------------------------- insured structures
EXPOSURE_REACH_M = 200.0      # assumed: beyond this distance from the track a crash cannot reach a structure


def asset_map(circuit: str, series: str, upgrades: dict[str, dict] | None = None) -> dict:
    """Real structures (OpenStreetMap) with an exposure score from the risk of the zone they face."""
    data = repository.assets(circuit)
    rm = risk_map(circuit, series, upgrades)
    zone_score = {z["zone_id"]: z["risk_score"] for z in rm["zones"]}
    out = []
    for a in data["assets"]:
        reach = max(0.0, 1.0 - a["distance_to_track_m"] / EXPOSURE_REACH_M)
        score = int(round(zone_score.get(a["nearest_zone_id"], 0) * reach))
        out.append({**a, "exposure_score": score, "exposure_tier": _tier(score)})
    summary = []
    for key, (label, description) in repository.COVERAGE_LINES.items():
        items = [a for a in out if key in a["coverage"]]
        count = len(items) + (data["marshal_posts"] if key == "participant_accident" else 0)
        summary.append({"line": key, "label": label, "description": description, "count": count,
                        "high_exposure": sum(a["exposure_tier"] in ("HIGH", "CRITICAL") for a in items)})
    counts = data["counts"]
    return {
        "circuit": circuit, "series": series, "attribution": data["source"],
        "alignment_error_m": data["alignment"]["median_error_m"], "extent_m": data["extent_m"],
        "marshal_posts": data["marshal_posts"], "coverage": summary, "assets": out, "context": data["context"],
        "sources": {
            "structures": {"provenance": "measured", "title": "Structures",
                           "detail": f"{sum(counts.values())} structures from OpenStreetMap ({data['source']}): "
                                     + ", ".join(f"{v} {k.replace('_', ' ')}" for k, v in counts.items())
                                     + f". Aligned to the OpenF1 track by matching OSM's raceway to the real lap "
                                       f"(median error {data['alignment']['median_error_m']} m).\n\n"
                                       "Heights come from OSM where mapped; otherwise a default by building type (labelled assumed)."},
            "coverage": {"provenance": "assumed", "title": "Coverage lines",
                         "detail": "Which insurance lines each structure type falls under follows common venue and event "
                                   "programmes (property, spectator liability, business interruption, broadcast equipment, "
                                   "participant accident, track infrastructure). Marshal posts are the real MultiViewer count."},
            "exposure": {"provenance": "modelled", "title": "Exposure",
                         "detail": f"Risk score of the zone the structure faces × (1 − distance ÷ {EXPOSURE_REACH_M:.0f} m). "
                                   f"The {EXPOSURE_REACH_M:.0f} m reach is an assumption."},
        },
    }
