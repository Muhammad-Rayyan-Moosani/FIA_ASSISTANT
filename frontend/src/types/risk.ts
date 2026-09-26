/**
 * Step 3 — Insurance API contracts (owner: R3 · API, logic by R2 · actuarial.py).
 * Served from /api/insurance/{risk-map,what-if,simulate,report}.
 */
import type { Provenance, Series, SourceMap } from "./api";
import type { BarrierType } from "./track";

export type RiskTier = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface SeriesFactors {
  grid: number;
  error: number;
  energy: number;
}

export interface RiskTotals {
  eal_eur: number;
  var99_eur: number;
  tvar99_eur: number;
  blanket_premium_eur: number;
  segmented_premium_eur: number;
  cost_delta_eur: number;
  cost_delta_pct: number;
  diversification_benefit_eur: number;
  tail_risk_margin_eur: number;
}

/** Crashes per race weekend: posterior mean and 90% credible interval. */
export interface CrashRate {
  mean: number;
  lo90: number;
  hi90: number;
  n_incidents: number;
  exposure: number;
}

export interface ZoneRisk {
  zone_id: string;
  risk_score: number;
  risk_tier: RiskTier;
  crash_rate: CrashRate;
  crash_prob_season: number;
  energy_kj_mean: number;
  breach_prob: number;
  eal_eur: number;
  var99_eur: number;
  share_of_loss_pct: number;
  premium_eur: number;
  tail_risk_margin_eur: number;
  recommended_limit_eur: number;
}

export interface Assumption {
  key: string;
  label: string;
  value: string;
  provenance: Provenance;
}

export type RiskSourceKey =
  | "premium"
  | "blanket"
  | "saving"
  | "eal"
  | "var99"
  | "diversification"
  | "series_factors"
  | "crash_rate"
  | "crash_prob"
  | "energy"
  | "zone_premium"
  | "limit"
  | "score"
  | "what_if"
  | "upgrade_costs"
  | "simulation"
  | "report";

/** Safety changes for one zone. Omitted fields keep the zone's current value. */
export interface ZoneChanges {
  barrier_type?: BarrierType;
  runoff_depth_m?: number;
  fence_height_m?: number;
}

/** Active what-if upgrades for a circuit, keyed by zone_id. */
export type UpgradeSet = Record<string, ZoneChanges>;

export interface RiskMapQuery {
  circuit: string;
  series: Series;
  upgrades?: UpgradeSet;
}

/** GET /api/insurance/risk-map */
export interface RiskMap {
  circuit: string;
  series: Series;
  series_factors: SeriesFactors;
  model_version: string;
  params_hash: string;
  n_seasons: number;
  seed: number;
  totals: RiskTotals;
  zones: ZoneRisk[];
  assumptions: Assumption[];
  sources: SourceMap<RiskSourceKey>;
}

/** POST /api/insurance/what-if */
export interface WhatIfRequest {
  circuit: string;
  series: Series;
  zone_id: string;
  changes: ZoneChanges;
  /** Upgrades already applied to other zones, so the result stacks on them. */
  upgrades: UpgradeSet;
}

export interface ZoneRiskSnapshot {
  eal_eur: number;
  var99_eur: number;
  premium_eur: number;
  risk_score: number;
}

export interface WhatIfResponse {
  zone_id: string;
  before: ZoneRiskSnapshot;
  after: ZoneRiskSnapshot;
  circuit_premium_before_eur: number;
  circuit_premium_after_eur: number;
  upgrade_cost_eur: number;
  payback_seasons: number | null;
  /** The full circuit repriced with every upgrade, including this one. */
  risk_map: RiskMap;
}

export interface SimulationQuery {
  circuit: string;
  series: Series;
  /** Number of sampled seasons to stream for animation (the full run is always n_seasons). */
  seasons: number;
  upgrades?: UpgradeSet;
}

/** Events on GET /api/insurance/simulate/stream (SSE). `type` is the SSE event name. */
export type SimulationStreamEvent =
  | { type: "season_start"; season: number }
  | {
      type: "crash";
      season: number;
      zone_id: string;
      x: number;
      y: number;
      lap_frac: number;
      energy_kj: number;
      loss_eur: number;
      breach: boolean;
    }
  | { type: "progress"; seasons_done: number; seasons_total: number; running_eal_eur: number; se_eur: number }
  | { type: "done"; n_seasons: number; eal_eur: number; var99_eur: number }
  | { type: "stream_error"; code: string; message: string };

export type SimulationCrash = Extract<SimulationStreamEvent, { type: "crash" }>;

export interface ReportQuery {
  circuit: string;
  series: Series;
  upgrades?: UpgradeSet;
}

export interface ZoneFinding {
  zone_id: string;
  headline: string;
  share_of_loss_pct: number;
  drivers: string[];
}

export interface Recommendation {
  zone_id: string;
  action: string;
  rationale: string;
  est_saving_eur: number | null;
  cost_eur: number | null;
  payback_seasons: number | null;
}

/** GET /api/insurance/report/export?format=json (ARCHITECTURE.md §6.2) */
export interface UnderwriterReport {
  circuit: string;
  series: Series;
  generated_at: string;
  narrative_source: "llm" | "template";
  model: string | null;
  executive_summary: string;
  risk_concentrations: ZoneFinding[];
  exposure_drivers: string[];
  premium_recommendations: Recommendation[];
  safety_recommendations: Recommendation[];
  caveats: string[];
  totals: RiskTotals;
  zones: ZoneRisk[];
}
