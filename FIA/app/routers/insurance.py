"""Insurance & track-risk routes.

Mounted at ``/api/v1/insurance`` and aliased at ``/api/insurance`` (the paths
used by the frontend spec: ``/api/insurance/risk-map``, ``/api/insurance/what-if``).
"""
from __future__ import annotations

import numpy as np
from fastapi import APIRouter, HTTPException, Request
from fastapi.concurrency import run_in_threadpool

from app.schemas.insurance import (
    RiskMapRequest,
    RiskMapResponse,
    RiskScoreRequest,
    RiskScoreResponse,
    Series,
    ZoneInput,
    ZoneRiskMap,
    ZoneRiskScore,
    ZoneWhatIf,
    WhatIfRequest,
    WhatIfResponse,
)
from app.services import risk

router = APIRouter(tags=["Insurance"])


def _resolve(request: Request, zones: list[ZoneInput] | None, name: str | None = None) -> tuple[str, list[ZoneInput]]:
    if zones:
        ids = [z.zone_id for z in zones]
        if len(set(ids)) != len(ids):
            raise HTTPException(422, "zone_id values must be unique")
        return name or "Custom circuit", zones
    track, demo = risk.load_demo_track(request.app.state.settings.data_dir)
    return name or track, list(demo)


def _payback(cost: float, saving: float) -> float | None:
    return round(cost / saving, 3) if saving > 0 else None


@router.get("/series-factors", summary="Series frequency / severity multipliers")
async def series_factors() -> dict[Series, dict[str, float]]:
    return risk.SERIES_FACTORS


@router.post("/risk-score", response_model=RiskScoreResponse, summary="Deterministic corner risk ranking")
async def risk_score(body: RiskScoreRequest, request: Request) -> RiskScoreResponse:
    """Risk = Events × SpeedFactor × PeopleFactor for each zone."""
    track, zones = _resolve(request, body.zones)
    df = risk.zones_frame(zones)
    comps = risk.risk_components(df)
    total = float(comps["risk"].sum())
    ranks = comps["risk"].rank(ascending=False, method="min").astype(int)
    return RiskScoreResponse(
        track=track,
        total_risk=round(total, 2),
        zones=[
            ZoneRiskScore(
                zone_id=z.zone_id,
                name=z.name,
                events=round(float(comps.at[i, "events"]), 3),
                speed_factor=round(float(comps.at[i, "speed_factor"]), 3),
                people_factor=round(float(comps.at[i, "people_factor"]), 5),
                risk=round(float(comps.at[i, "risk"]), 3),
                risk_share=round(float(comps.at[i, "risk"]) / total, 5) if total else 0.0,
                rank=int(ranks[i]),
            )
            for i, z in enumerate(zones)
        ],
    )


def _risk_map(body: RiskMapRequest, track: str, zones: list[ZoneInput]) -> RiskMapResponse:
    df = risk.zones_frame(zones)
    comps = risk.risk_components(df)
    factors = risk.SERIES_FACTORS[body.series]
    alpha, beta = risk.poisson_gamma_posterior(
        df["crashes"].to_numpy(float), df["seasons_observed"].to_numpy(float), body.prior_strength
    )
    sev = risk.severity_means(df, comps, body.series)
    draws = risk.draw_simulation(alpha, beta, factors["freq_mult"], body.n_seasons, body.seed)
    losses = risk.simulate_losses(draws, sev)
    zone_stats = risk.loss_stats(losses, body.expense_loading, body.cost_of_capital)
    (portfolio,) = risk.loss_stats(losses.sum(axis=1), body.expense_loading, body.cost_of_capital)
    p_crash = risk.crash_probability(alpha, beta, factors["freq_mult"])
    return RiskMapResponse(
        track=track,
        series=body.series,
        n_seasons=body.n_seasons,
        zones=[
            ZoneRiskMap(
                zone_id=z.zone_id,
                name=z.name,
                risk_score=round(float(comps.at[i, "risk"]), 3),
                posterior_alpha=round(float(alpha[i]), 4),
                posterior_beta=round(float(beta[i]), 4),
                posterior_mean_rate=round(float(alpha[i] / beta[i] * factors["freq_mult"]), 4),
                crash_probability=round(float(p_crash[i]), 4),
                mean_severity_usd=round(float(sev[i]), 2),
                loss=zone_stats[i],
            )
            for i, z in enumerate(zones)
        ],
        portfolio=portfolio,
        diversification_benefit=round(sum(s.var_99 for s in zone_stats) - portfolio.var_99, 2),
    )


@router.post("/risk-map", response_model=RiskMapResponse, summary="Bayesian Poisson-Gamma + Monte Carlo risk map")
async def risk_map(body: RiskMapRequest, request: Request) -> RiskMapResponse:
    """Per-zone crash probability, Expected Annual Loss, 99% VaR and recommended premium."""
    track, zones = _resolve(request, body.zones, body.track_name)
    return await run_in_threadpool(_risk_map, body, track, zones)


def _what_if(body: WhatIfRequest, track: str, zones: list[ZoneInput]) -> WhatIfResponse:
    try:
        modified, costs, notes = risk.apply_modifications(zones, body.modifications)
    except KeyError as exc:
        raise HTTPException(422, exc.args[0]) from exc
    factors = risk.SERIES_FACTORS[body.series]
    base_df, mod_df = risk.zones_frame(zones), risk.zones_frame(modified)
    alpha, beta = risk.poisson_gamma_posterior(
        base_df["crashes"].to_numpy(float), base_df["seasons_observed"].to_numpy(float), body.prior_strength
    )
    # Common random numbers: identical crash counts & noise, only severities change.
    draws = risk.draw_simulation(alpha, beta, factors["freq_mult"], body.n_seasons, body.seed)
    base_loss = risk.simulate_losses(draws, risk.severity_means(base_df, risk.risk_components(base_df), body.series))
    mod_loss = risk.simulate_losses(draws, risk.severity_means(mod_df, risk.risk_components(mod_df), body.series))

    ld, cc = body.expense_loading, body.cost_of_capital
    b_z, m_z = risk.loss_stats(base_loss, ld, cc), risk.loss_stats(mod_loss, ld, cc)
    (b_tot,) = risk.loss_stats(base_loss.sum(axis=1), ld, cc)
    (m_tot,) = risk.loss_stats(mod_loss.sum(axis=1), ld, cc)

    rows = []
    for i, z in enumerate(zones):
        if z.zone_id not in costs:
            continue
        prem_red = b_z[i].recommended_premium - m_z[i].recommended_premium
        rows.append(ZoneWhatIf(
            zone_id=z.zone_id,
            name=z.name,
            changes=notes[z.zone_id],
            baseline_eal=b_z[i].expected_annual_loss,
            modified_eal=m_z[i].expected_annual_loss,
            baseline_premium=b_z[i].recommended_premium,
            modified_premium=m_z[i].recommended_premium,
            eal_reduction=round(b_z[i].expected_annual_loss - m_z[i].expected_annual_loss, 2),
            premium_reduction=round(prem_red, 2),
            upgrade_cost_usd=round(costs[z.zone_id], 2),
            payback_years=_payback(costs[z.zone_id], prem_red),
        ))
    total_cost = float(np.sum(list(costs.values())))
    saving = b_tot.recommended_premium - m_tot.recommended_premium
    return WhatIfResponse(
        track=track,
        series=body.series,
        n_seasons=body.n_seasons,
        zones=rows,
        baseline=b_tot,
        modified=m_tot,
        total_upgrade_cost_usd=round(total_cost, 2),
        annual_premium_saving=round(saving, 2),
        annual_eal_reduction=round(b_tot.expected_annual_loss - m_tot.expected_annual_loss, 2),
        payback_years=_payback(total_cost, saving),
    )


@router.post("/what-if", response_model=WhatIfResponse, summary="Safety-upgrade what-if simulation")
async def what_if(body: WhatIfRequest, request: Request) -> WhatIfResponse:
    """Re-price the circuit after barrier upgrades / grandstand moves and compute payback period."""
    track, zones = _resolve(request, body.zones, body.track_name)
    return await run_in_threadpool(_what_if, body, track, zones)
