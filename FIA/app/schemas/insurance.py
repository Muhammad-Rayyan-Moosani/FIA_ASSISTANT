"""Request/response models for the insurance & track-risk API."""
from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field, model_validator


class Series(str, Enum):
    F1 = "F1"
    F2 = "F2"
    F3 = "F3"


class BarrierType(str, Enum):
    ARMCO = "armco"
    CONCRETE = "concrete"
    TYRE_WALL = "tyre_wall"
    TECPRO = "tecpro"
    SAFER = "safer"


class ZoneInput(BaseModel):
    """Historical incident record and geometry for one corner / track zone."""

    zone_id: str
    name: str | None = None
    crashes: int = Field(..., ge=0, description="Crashes observed over `seasons_observed`.")
    yellow_flags: int = Field(0, ge=0)
    warnings: int = Field(0, ge=0, description="Track-limit / stewards' warnings.")
    seasons_observed: float = Field(5.0, gt=0, description="Exposure (race weekends) behind the counts.")
    approach_speed_kph: float = Field(..., ge=0, le=400)
    top_speed_kph: float = Field(
        ..., ge=0, le=400,
        description="Reference speed subtracted from approach speed in the Speed Factor.",
    )
    grandstand_dist_m: float = Field(..., ge=0)
    marshal_dist_m: float = Field(..., ge=0)
    barrier_type: BarrierType = BarrierType.ARMCO


class RiskScoreRequest(BaseModel):
    zones: list[ZoneInput] | None = Field(None, description="Omit to use the bundled demo circuit.")


class ZoneRiskScore(BaseModel):
    zone_id: str
    name: str | None
    events: float
    speed_factor: float
    people_factor: float
    risk: float
    risk_share: float = Field(..., description="Fraction of total circuit risk.")
    rank: int


class RiskScoreResponse(BaseModel):
    track: str
    total_risk: float
    zones: list[ZoneRiskScore]


class RiskMapRequest(BaseModel):
    track_name: str | None = None
    zones: list[ZoneInput] | None = Field(None, description="Omit to use the bundled demo circuit.")
    series: Series = Series.F1
    n_seasons: int = Field(10_000, ge=1_000, le=200_000, description="Monte Carlo seasons.")
    seed: int | None = Field(42, description="RNG seed (reproducible results). null for random.")
    prior_strength: float = Field(
        2.0, gt=0, description="Gamma prior shape α₀; prior mean is the circuit-wide pooled crash rate.",
    )
    expense_loading: float = Field(0.25, ge=0, le=2, description="Premium loading on expected loss.")
    cost_of_capital: float = Field(0.10, ge=0, le=1, description="Charged on (VaR99 − EAL).")


class LossStats(BaseModel):
    expected_annual_loss: float
    var_99: float
    tvar_99: float
    std: float
    recommended_premium: float
    percentiles: dict[str, float]


class ZoneRiskMap(BaseModel):
    zone_id: str
    name: str | None
    risk_score: float
    posterior_alpha: float
    posterior_beta: float
    posterior_mean_rate: float = Field(..., description="Expected crashes per season (series-adjusted).")
    crash_probability: float = Field(..., description="P(≥1 crash in a season), posterior predictive.")
    mean_severity_usd: float
    loss: LossStats


class RiskMapResponse(BaseModel):
    track: str
    series: Series
    n_seasons: int
    zones: list[ZoneRiskMap]
    portfolio: LossStats
    diversification_benefit: float = Field(..., description="Σ zone VaR99 − portfolio VaR99.")


class ZoneModification(BaseModel):
    zone_id: str
    barrier_upgrade: BarrierType | None = None
    grandstand_shift_m: float = Field(0, ge=0, description="Move grandstand back by X metres.")
    marshal_shift_m: float = Field(0, ge=0, description="Move marshal post back by X metres.")
    approach_speed_delta_kph: float = Field(0, le=0, description="Negative = slower approach (e.g. new chicane).")
    upgrade_cost_usd: float | None = Field(None, ge=0, description="Override the default cost estimate.")

    @model_validator(mode="after")
    def _non_empty(self):
        if not (self.barrier_upgrade or self.grandstand_shift_m or self.marshal_shift_m or self.approach_speed_delta_kph):
            raise ValueError("modification must change at least one parameter")
        return self


class WhatIfRequest(RiskMapRequest):
    modifications: list[ZoneModification] = Field(..., min_length=1)


class ZoneWhatIf(BaseModel):
    zone_id: str
    name: str | None
    changes: list[str]
    baseline_eal: float
    modified_eal: float
    baseline_premium: float
    modified_premium: float
    eal_reduction: float
    premium_reduction: float
    upgrade_cost_usd: float
    payback_years: float | None


class WhatIfResponse(BaseModel):
    track: str
    series: Series
    n_seasons: int
    zones: list[ZoneWhatIf]
    baseline: LossStats
    modified: LossStats
    total_upgrade_cost_usd: float
    annual_premium_saving: float
    annual_eal_reduction: float
    payback_years: float | None = Field(..., description="Upgrade cost / annual premium saving.")
