/**
 * Third-party exposure: the evidence a circuit owner gives its liability insurer.
 * GET /api/insurance/exposure/{circuit} · mirrors backend/api/schemas.py (ExposureMap).
 */
import type { SourceInfo } from "./api";
import type { RiskTier } from "./risk";

export interface SeasonCount {
  season: number;
  count: number;
}

export interface ZoneExposure {
  zone_id: string;
  /** 1 = most serious incidents at this circuit. */
  rank: number;
  serious_total: number;
  serious_per_weekend: number;
  /** Double yellows: a car stopped on track and marshals went out to clear it. */
  marshals_out_total: number;
  marshals_out_per_weekend: number;
  /** A grandstand overlooks this zone (official circuit list). */
  near_crowd: boolean;
  grandstands: string[];
  entry_speed_kph: number;
  by_season: SeasonCount[];
  /** 0–100: serious incidents per weekend relative to the busiest zone at this circuit (map colour). */
  score: number;
  tier: RiskTier;
}

export interface BacktestYear {
  season: number;
  trained_on: string;
  predicted: string[];
  hits: number;
  total: number;
}

export interface Backtest {
  top_k: number;
  years: BacktestYear[];
  hits: number;
  total: number;
  share: number;
  chance_share: number;
  lift: number;
}

export interface ExposureContext {
  attendance: number | null;
  attendance_year: number | null;
  attendance_source: string | null;
  history_year: number | null;
  history: string | null;
  history_source: string | null;
  task_force: string;
  task_force_source: string;
}

export type ExposureSourceKey = "data" | "serious" | "marshals" | "crowd" | "backtest" | "attendance" | "history";

export interface ExposureMap {
  circuit: string;
  weekends: number;
  sessions: number;
  seasons: number[];
  serious_total: number;
  serious_per_weekend: number;
  marshals_out_total: number;
  marshals_out_per_weekend: number;
  near_crowd_total: number;
  near_crowd_share: number;
  crowd_lap_share: number;
  backtest: Backtest;
  top_zones: string[];
  zones: ZoneExposure[];
  context: ExposureContext;
  sources: Partial<Record<ExposureSourceKey, SourceInfo | null>>;
}
