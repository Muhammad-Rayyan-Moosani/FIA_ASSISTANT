/**
 * Safety plan: ways to protect spectators at the busiest corners next to the crowd, with estimated prices.
 * GET /api/insurance/safety-plan/{circuit} · mirrors backend/api/schemas.py (SafetyPlan).
 */

export type SafetyOptionKey = "close_rows" | "tecpro" | "debris_fence" | "guardrail";

export interface CostRange {
  low: number;
  high: number;
}

export interface SafetyOption {
  key: SafetyOptionKey;
  title: string;
  action: string;
  protects_against: string;
  /** CAD. low === high when the estimate is a single figure. */
  cost: CostRange | null;
  cost_basis: string;
  /** true = cost per race weekend (lost tickets); false = one-off. */
  recurring: boolean;
  /** "sourced" | "estimate" | a mix, in words. */
  provenance: string;
  source: string | null;
  note: string | null;
  recommended: boolean;
}

export interface SafetyCorner {
  zone_id: string;
  name: string;
  full_name: string;
  rank: number;
  serious_per_weekend: number;
  marshals_out_per_weekend: number;
  entry_speed_kph: number;
  apex_speed_kph: number;
  grandstands: string[];
  frontage_m: number;
  why: string;
  /** Recommended option first. */
  options: SafetyOption[];
}

export interface SafetyPlan {
  circuit: string;
  currency: "CAD";
  corners: SafetyCorner[];
  assumptions: { label: string; value: string; source?: string | null }[];
  disclaimer: string;
}
