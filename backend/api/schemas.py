"""API contract (Pydantic). Mirrors frontend/src/types/{api,track,risk}.ts field for field.

Every route declares one of these as its response_model, so FastAPI validates and filters the JSON
it emits: if the backend drifts from the contract, the request fails loudly instead of the UI breaking.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Series = Literal["f1", "f2", "f3"]
Provenance = Literal["measured", "assumed", "modelled"]
BarrierType = Literal["tyre_wall", "guardrail", "tecpro", "concrete", "safer"]
RunoffType = Literal["gravel", "asphalt", "grass"]
ZoneType = Literal["braking", "high_speed", "straight", "pit_lane"]
RiskTier = Literal["LOW", "MEDIUM", "HIGH", "CRITICAL"]
IncidentType = Literal["crash", "spin", "stopped", "debris", "collision", "track_limits", "flag_only", "administrative"]
GeoMethod = Literal["turn_in_message", "driver_location", "inferred_slowest_car", "marshal_sector"]
GeoConfidence = Literal["high", "medium", "low"]


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ------------------------------------------------------------------ shared (api.ts)
class SourceInfo(Contract):
    provenance: Provenance
    title: str
    detail: str


class ErrorBody(Contract):
    code: str
    message: str
    detail: dict | None = None


class ErrorEnvelope(Contract):
    error: ErrorBody


# ------------------------------------------------------------------ Step 1 (track.ts)
class DataCoverage(Contract):
    seasons: list[int]
    sessions: int
    incidents: int
    loss_relevant: int
    last_ingested_at: str | None


class CircuitSummary(Contract):
    id: str
    name: str
    short_name: str
    country: str
    length_m: float
    zone_count: int
    coverage: DataCoverage


class TrackZone(Contract):
    zone_id: str
    name: str
    short_name: str
    zone_type: ZoneType
    turns: list[int]
    turn_number: int | None
    start_frac: float
    end_frac: float
    length_m: float
    v_entry_kph: float
    v_apex_kph: float
    barrier_type: BarrierType
    runoff_type: RunoffType
    runoff_depth_m: float
    fence_height_m: float
    grandstands: list[str]
    grandstand_capacity: int
    distance_to_stand_m: float | None
    marshal_posts: int
    asset_value_eur: float
    inventory_source: str
    n_incidents: int
    n_loss_relevant: int


class ReferenceLap(Contract):
    season: int
    event_name: str
    session_key: int
    session_type: str
    driver_number: int
    driver_name: str | None
    lap_number: int
    lap_duration_s: float
    sample_count: int


TrackSourceKey = Literal["outline", "speeds", "zones", "safety_inventory", "incidents"]


class TrackGeometry(Contract):
    circuit: str
    name: str
    country: str
    length_m: float
    outline: list[tuple[float, float]]
    speed_kph: list[float]
    extent_m: float
    zones: list[TrackZone]
    reference: ReferenceLap
    sources: dict[TrackSourceKey, SourceInfo]


class Extraction(Contract):
    method: Literal["regex", "llm"]
    rule: str | None
    model: str | None


class Incident(Contract):
    incident_id: str
    circuit: str
    season: int
    session_type: str
    session_key: int
    lap: int | None
    occurred_at: str
    raw_message: str
    car_numbers: list[int]
    turn_number: int | None
    incident_type: IncidentType
    severity_score: float
    loss_relevant: bool
    x: float
    y: float
    lap_frac: float
    zone_id: str | None
    geo_method: GeoMethod
    geo_confidence: GeoConfidence
    marshal_sector: int | None
    counts_as_crash: bool
    entry_speed_kph: float | None
    kinetic_energy_kj: float | None
    extraction: Extraction


class IngestRequest(Contract):
    circuit: str
    refresh: bool = False


class IngestJob(Contract):
    job_id: str
    circuit: str
    status: Literal["queued", "running", "succeeded", "failed"]
    created_at: str


# ------------------------------------------------------------------ Step 3 (risk.ts)
class SeriesFactors(Contract):
    grid: float
    error: float
    energy: float


class RiskTotals(Contract):
    eal_eur: float
    var99_eur: float
    tvar99_eur: float
    blanket_premium_eur: float
    segmented_premium_eur: float
    cost_delta_eur: float
    cost_delta_pct: float
    diversification_benefit_eur: float
    tail_risk_margin_eur: float


class CrashRate(Contract):
    mean: float
    lo90: float
    hi90: float
    n_incidents: int
    exposure: float


class ZoneRisk(Contract):
    zone_id: str
    risk_score: int
    risk_tier: RiskTier
    crash_rate: CrashRate
    crash_prob_season: float
    energy_kj_mean: float
    mean_cost_per_crash_eur: float
    eal_eur: float
    var99_eur: float
    share_of_loss_pct: float
    premium_eur: float
    tail_risk_margin_eur: float
    recommended_limit_eur: float


class Assumption(Contract):
    key: str
    label: str
    value: str
    provenance: Provenance


RiskSourceKey = Literal[
    "premium", "blanket", "saving", "eal", "var99", "diversification", "series_factors", "crash_rate",
    "crash_prob", "energy", "zone_premium", "limit", "score", "what_if", "simulation", "report",
]


class RiskMap(Contract):
    circuit: str
    series: Series
    series_factors: SeriesFactors
    model_version: str
    params_hash: str
    n_seasons: int
    seed: int
    totals: RiskTotals
    zones: list[ZoneRisk]
    assumptions: list[Assumption]
    sources: dict[RiskSourceKey, SourceInfo]


class ZoneChanges(Contract):
    barrier_type: BarrierType | None = None
    speed_factor: float | None = Field(default=None, gt=0, le=1.5)
    frequency_multiplier: float | None = Field(default=None, ge=0, le=3)


class WhatIfRequest(Contract):
    circuit: str
    series: Series
    zone_id: str
    changes: ZoneChanges
    upgrades: dict[str, ZoneChanges] = {}


class ZoneRiskSnapshot(Contract):
    eal_eur: float
    var99_eur: float
    premium_eur: float
    risk_score: int


class WhatIfResponse(Contract):
    zone_id: str
    before: ZoneRiskSnapshot
    after: ZoneRiskSnapshot
    circuit_premium_before_eur: float
    circuit_premium_after_eur: float
    risk_map: RiskMap


class ZoneFinding(Contract):
    zone_id: str
    headline: str
    share_of_loss_pct: float
    drivers: list[str]


class Recommendation(Contract):
    zone_id: str
    action: str
    rationale: str
    est_saving_eur: float | None


class UnderwriterReport(Contract):
    circuit: str
    series: Series
    generated_at: str
    narrative_source: Literal["llm", "template"]
    model: str | None
    executive_summary: str
    risk_concentrations: list[ZoneFinding]
    exposure_drivers: list[str]
    premium_recommendations: list[Recommendation]
    safety_recommendations: list[Recommendation]
    caveats: list[str]
    totals: RiskTotals
    zones: list[ZoneRisk]


# ------------------------------------------------------------------ insured structures (assets.ts)
AssetCategory = Literal["grandstand", "pit_building", "paddock", "hospitality", "race_control", "media", "medical",
                        "podium", "building", "tower", "bridge", "barrier"]
CoverageLine = Literal["property", "spectator_liability", "business_interruption", "broadcast_equipment",
                       "participant_accident", "track_infrastructure"]


class Asset(Contract):
    asset_id: str
    position_source: Literal["osm", "official_list"]
    name: str | None
    category: AssetCategory
    osm_tag: str
    coverage: list[CoverageLine]
    geometry: Literal["polygon", "line", "point"]
    points: list[tuple[float, float]]
    height_m: float
    height_source: Literal["osm_height", "osm_levels", "assumed"]
    distance_to_track_m: float
    nearest_lap_frac: float
    nearest_zone_id: str
    exposure_score: int
    exposure_tier: RiskTier


class CoverageSummary(Contract):
    line: CoverageLine
    label: str
    description: str
    count: int
    high_exposure: int


GroundKind = Literal["water", "land", "wood", "grass", "beach", "parking", "pitch"]


class GroundArea(Contract):
    kind: GroundKind
    points: list[tuple[float, float]]


class ContextRoad(Contract):
    kind: Literal["major", "minor", "service", "path", "rail"]
    width_m: float
    bridge: bool
    points: list[tuple[float, float]]


class ContextBuilding(Contract):
    height_m: float
    points: list[tuple[float, float]]


class AssetContext(Contract):
    """Surroundings from OpenStreetMap (not insured): drawn for a true picture of the site."""
    woods: list[list[tuple[float, float]]]
    pit_lane: list[list[tuple[float, float]]]
    other_raceways: list[list[tuple[float, float]]]
    ground: list[GroundArea] = Field(description="Painter's order: draw first to last (largest areas first).")
    roads: list[ContextRoad]
    buildings: list[ContextBuilding]


AssetSourceKey = Literal["structures", "coverage", "exposure"]


class AssetMap(Contract):
    circuit: str
    series: Series
    attribution: str
    alignment_error_m: float
    extent_m: float
    marshal_posts: int
    coverage: list[CoverageSummary]
    assets: list[Asset]
    context: AssetContext
    sources: dict[AssetSourceKey, SourceInfo]


# ------------------------------------------------------------------ third-party exposure (exposure.ts)
class SeasonCount(Contract):
    season: int
    count: int


class ZoneExposure(Contract):
    zone_id: str
    rank: int
    serious_total: int
    serious_per_weekend: float
    marshals_out_total: int
    marshals_out_per_weekend: float
    near_crowd: bool
    grandstands: list[str]
    entry_speed_kph: float
    by_season: list[SeasonCount]
    score: int = Field(ge=0, le=100)
    tier: RiskTier


class BacktestYear(Contract):
    season: int
    trained_on: str
    predicted: list[str]
    hits: int
    total: int


class Backtest(Contract):
    top_k: int
    years: list[BacktestYear]
    hits: int
    total: int
    share: float
    chance_share: float
    lift: float


class ExposureContext(Contract):
    attendance: int | None
    attendance_year: int | None
    attendance_source: str | None
    history_year: int | None
    history: str | None
    history_source: str | None
    task_force: str
    task_force_source: str


class ExposureMap(Contract):
    circuit: str
    weekends: int
    sessions: int
    seasons: list[int]
    serious_total: int
    serious_per_weekend: float
    marshals_out_total: int
    marshals_out_per_weekend: float
    near_crowd_total: int
    near_crowd_share: float
    crowd_lap_share: float
    backtest: Backtest
    top_zones: list[str]
    zones: list[ZoneExposure]
    context: ExposureContext
    sources: dict[str, SourceInfo | None]


# ------------------------------------------------------------------ safety plan (safetyPlan.ts)
class CostRange(Contract):
    low: float
    high: float


class SafetyOption(Contract):
    key: Literal["crews", "marshal_training", "move_crowd", "cameras", "guardrail"]
    title: str
    action: str
    protects_against: str
    cost: CostRange | None
    cost_basis: str
    recurring: bool
    provenance: str
    source: str | None
    note: str | None


class SafetyCorner(Contract):
    zone_id: str
    name: str
    full_name: str
    rank: int
    serious_per_weekend: float
    marshals_out_per_weekend: float
    entry_speed_kph: float
    apex_speed_kph: float
    grandstands: list[str]
    frontage_m: float
    why: str
    options: list[SafetyOption]


class PlanAssumption(Contract):
    label: str
    value: str
    source: str | None = None


class SeasonCount(Contract):
    season: int
    count: int


class InsurerReport(Contract):
    title: str
    action: str
    cost: CostRange
    cost_basis: str
    trend: list[SeasonCount]


class SafetyPlan(Contract):
    circuit: str
    currency: Literal["CAD"]
    corners: list[SafetyCorner]
    report: InsurerReport
    assumptions: list[PlanAssumption]
    disclaimer: str
