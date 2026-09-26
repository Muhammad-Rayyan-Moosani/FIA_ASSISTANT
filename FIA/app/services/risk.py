"""Track-corner risk scoring and the actuarial Poisson-Gamma / Monte Carlo loss model.

Risk score (per zone)::

    Risk          = Events × SpeedFactor × PeopleFactor
    Events        = Crashes·1 + YellowFlags·1 + Warnings·0.1
    SpeedFactor   = (ApproachSpeed − TopSpeed)²
    PeopleFactor  = 1 + 2·exp(−GrandstandDist/50) + 0.5·exp(−MarshalDist/50)

Loss model (per zone z, per simulated season s)::

    λ_z   ~ Gamma(α₀ + crashes_z,  β₀ + exposure_z)       (posterior, rate form)
    N_sz  ~ Poisson(λ_z · freq_mult[series])
    X_i   ~ LogNormal(mean = severity_z, σ)                  i = 1..N_sz
    L_sz  = Σ X_i

with severity_z = base_cost[series] · (1 + SpeedFactor/20000) · PeopleFactor · barrier_mult.
All draws are fully vectorised; a 10 000-season × 20-zone run takes a few ms.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np
import pandas as pd

from app.schemas.insurance import BarrierType, LossStats, Series, ZoneInput, ZoneModification

# ----------------------------------------------------------------------------- constants
SERIES_FACTORS: dict[Series, dict[str, float]] = {
    # freq_mult: junior series crash more often; base_cost: mean cost of one crash (car + facility + liability)
    Series.F1: {"freq_mult": 1.00, "base_cost": 750_000.0},
    Series.F2: {"freq_mult": 1.35, "base_cost": 190_000.0},
    Series.F3: {"freq_mult": 1.60, "base_cost": 90_000.0},
}
BARRIER_SEVERITY: dict[BarrierType, float] = {
    BarrierType.CONCRETE: 1.10,
    BarrierType.ARMCO: 1.00,
    BarrierType.TYRE_WALL: 0.80,
    BarrierType.TECPRO: 0.60,
    BarrierType.SAFER: 0.55,
}
BARRIER_INSTALL_COST: dict[BarrierType, float] = {
    BarrierType.CONCRETE: 120_000.0,
    BarrierType.ARMCO: 80_000.0,
    BarrierType.TYRE_WALL: 60_000.0,
    BarrierType.TECPRO: 350_000.0,
    BarrierType.SAFER: 500_000.0,
}
GRANDSTAND_MOVE_COST_PER_M = 25_000.0
MARSHAL_MOVE_COST_PER_M = 2_000.0
CHICANE_COST_PER_KPH = 15_000.0
SPEED_REF = 20_000.0  # ~141 km/h approach-vs-reference differential doubles severity
SEVERITY_SIGMA = 1.0  # log-space dispersion -> heavy right tail
PERCENTILES = (50, 75, 90, 95, 99, 99.5)


# ----------------------------------------------------------------------------- scoring
def zones_frame(zones: list[ZoneInput]) -> pd.DataFrame:
    return pd.DataFrame([z.model_dump() for z in zones])


def risk_components(df: pd.DataFrame) -> pd.DataFrame:
    """Vectorised implementation of the exact track-risk formula."""
    out = pd.DataFrame(index=df.index)
    out["events"] = df["crashes"] * 1.0 + df["yellow_flags"] * 1.0 + df["warnings"] * 0.1
    out["speed_factor"] = (df["approach_speed_kph"] - df["top_speed_kph"]) ** 2
    out["people_factor"] = (
        1.0
        + 2.0 * np.exp(-df["grandstand_dist_m"] / 50.0)
        + 0.5 * np.exp(-df["marshal_dist_m"] / 50.0)
    )
    out["risk"] = out["events"] * out["speed_factor"] * out["people_factor"]
    return out


def severity_means(df: pd.DataFrame, comps: pd.DataFrame, series: Series) -> np.ndarray:
    barrier = df["barrier_type"].map(lambda b: BARRIER_SEVERITY[BarrierType(b)]).to_numpy(float)
    return (
        SERIES_FACTORS[series]["base_cost"]
        * (1.0 + comps["speed_factor"].to_numpy(float) / SPEED_REF)
        * comps["people_factor"].to_numpy(float)
        * barrier
    )


# ----------------------------------------------------------------------------- Bayesian frequency
def poisson_gamma_posterior(crashes: np.ndarray, exposure: np.ndarray, prior_strength: float) -> tuple[np.ndarray, np.ndarray]:
    """Empirical-Bayes Gamma prior centred on the pooled circuit rate, updated per zone.

    Prior Gamma(α₀, β₀) with α₀ = prior_strength and β₀ = α₀ / pooled_rate, so
    the prior is worth ``β₀`` seasons of pooled experience. Posterior is conjugate:
    α = α₀ + k, β = β₀ + exposure.
    """
    pooled = max(crashes.sum() / exposure.sum(), 1e-3)
    a0, b0 = prior_strength, prior_strength / pooled
    return a0 + crashes, b0 + exposure


def crash_probability(alpha: np.ndarray, beta: np.ndarray, freq_mult: float) -> np.ndarray:
    """P(N ≥ 1) under the Negative-Binomial posterior predictive for one season."""
    return 1.0 - (beta / (beta + freq_mult)) ** alpha


# ----------------------------------------------------------------------------- Monte Carlo
@dataclass
class SimDraws:
    """Random numbers shared between scenarios (common random numbers => clean what-if deltas)."""

    counts: np.ndarray       # (S, Z) crash counts
    flat_idx: np.ndarray     # (ΣN,) index into S*Z for each crash
    zone_idx: np.ndarray     # (ΣN,) zone of each crash
    z_normals: np.ndarray    # (ΣN,) standard normals for severity


def draw_simulation(alpha: np.ndarray, beta: np.ndarray, freq_mult: float, n_seasons: int, seed: int | None) -> SimDraws:
    rng = np.random.default_rng(seed)
    n_zones = alpha.size
    lam = rng.gamma(shape=alpha, scale=1.0 / beta, size=(n_seasons, n_zones)) * freq_mult
    counts = rng.poisson(lam)
    flat_counts = counts.ravel()
    flat_idx = np.repeat(np.arange(flat_counts.size), flat_counts)
    zone_idx = flat_idx % n_zones
    return SimDraws(counts, flat_idx, zone_idx, rng.standard_normal(flat_idx.size))


def simulate_losses(draws: SimDraws, sev_mean: np.ndarray, sigma: float = SEVERITY_SIGMA) -> np.ndarray:
    """(S, Z) annual loss matrix. LogNormal parameterised so E[X] = sev_mean."""
    mu = np.log(sev_mean) - 0.5 * sigma**2
    sev = np.exp(mu[draws.zone_idx] + sigma * draws.z_normals)
    s, z = draws.counts.shape
    return np.bincount(draws.flat_idx, weights=sev, minlength=s * z).reshape(s, z)


def loss_stats(losses: np.ndarray, expense_loading: float, cost_of_capital: float) -> list[LossStats]:
    """Column-wise stats for an (S, K) loss matrix."""
    losses = np.atleast_2d(losses.T).T
    eal = losses.mean(axis=0)
    std = losses.std(axis=0)
    pct = np.percentile(losses, PERCENTILES, axis=0)
    var99 = np.percentile(losses, 99, axis=0)
    tail = losses >= var99
    tvar99 = np.where(tail.any(axis=0), (losses * tail).sum(axis=0) / np.maximum(tail.sum(axis=0), 1), var99)
    premium = eal * (1 + expense_loading) + cost_of_capital * np.maximum(var99 - eal, 0)
    return [
        LossStats(
            expected_annual_loss=round(float(eal[k]), 2),
            var_99=round(float(var99[k]), 2),
            tvar_99=round(float(tvar99[k]), 2),
            std=round(float(std[k]), 2),
            recommended_premium=round(float(premium[k]), 2),
            percentiles={f"p{p:g}": round(float(pct[i, k]), 2) for i, p in enumerate(PERCENTILES)},
        )
        for k in range(losses.shape[1])
    ]


# ----------------------------------------------------------------------------- what-if
def apply_modifications(zones: list[ZoneInput], mods: list[ZoneModification]) -> tuple[list[ZoneInput], dict[str, float], dict[str, list[str]]]:
    by_id = {z.zone_id: z for z in zones}
    unknown = [m.zone_id for m in mods if m.zone_id not in by_id]
    if unknown:
        raise KeyError(f"unknown zone_id(s): {', '.join(unknown)}")
    costs: dict[str, float] = {}
    notes: dict[str, list[str]] = {}
    updated = dict(by_id)
    for m in mods:
        z = updated[m.zone_id]
        changes: dict = {}
        cost = 0.0
        desc: list[str] = []
        if m.barrier_upgrade and m.barrier_upgrade != z.barrier_type:
            changes["barrier_type"] = m.barrier_upgrade
            cost += BARRIER_INSTALL_COST[m.barrier_upgrade]
            desc.append(f"barrier {z.barrier_type.value} → {m.barrier_upgrade.value}")
        if m.grandstand_shift_m:
            changes["grandstand_dist_m"] = z.grandstand_dist_m + m.grandstand_shift_m
            cost += GRANDSTAND_MOVE_COST_PER_M * m.grandstand_shift_m
            desc.append(f"grandstand +{m.grandstand_shift_m:g} m")
        if m.marshal_shift_m:
            changes["marshal_dist_m"] = z.marshal_dist_m + m.marshal_shift_m
            cost += MARSHAL_MOVE_COST_PER_M * m.marshal_shift_m
            desc.append(f"marshal post +{m.marshal_shift_m:g} m")
        if m.approach_speed_delta_kph:
            changes["approach_speed_kph"] = max(z.approach_speed_kph + m.approach_speed_delta_kph, 0)
            cost += CHICANE_COST_PER_KPH * -m.approach_speed_delta_kph
            desc.append(f"approach {m.approach_speed_delta_kph:+g} km/h")
        updated[m.zone_id] = z.model_copy(update=changes)
        costs[m.zone_id] = costs.get(m.zone_id, 0.0) + (m.upgrade_cost_usd if m.upgrade_cost_usd is not None else cost)
        notes.setdefault(m.zone_id, []).extend(desc)
    return [updated[z.zone_id] for z in zones], costs, notes


# ----------------------------------------------------------------------------- demo data
@lru_cache
def load_demo_track(data_dir: Path) -> tuple[str, tuple[ZoneInput, ...]]:
    raw = json.loads((data_dir / "demo_track.json").read_text(encoding="utf-8"))
    return raw["track"], tuple(ZoneInput(**z) for z in raw["zones"])
