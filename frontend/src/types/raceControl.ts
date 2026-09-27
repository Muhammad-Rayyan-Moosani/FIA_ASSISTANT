/**
 * Race control (the FIA safety loop) on the unified map. Mirrors backend/api/race_control.py and the
 * events of backend/services/race_control/session.py (SSE: /api/fia/{circuit}/stream).
 */

export type MastState = "clear" | "green" | "yellow" | "double_yellow" | "slippery" | "vsc" | "sc" | "red";
export type Deployment = "green" | "sc" | "vsc" | "red";
export type DeployAction = "sc" | "vsc" | "red" | "clear";
export type SuggestedFlag = "YELLOW" | "SLIPPERY" | "DOUBLE_YELLOW" | "VSC" | "SC" | "RED" | "CLEAR";
export type SeverityLabel = "Low slip" | "Medium incident" | "Critical crash";

export interface MarshalSector {
  sector: number;
  x: number;
  y: number;
  lap_frac: number;
  zone_id: string;
  zone_name: string;
}

export interface Mast extends MarshalSector {
  state: MastState;
}

/** Physics collision estimate from real OpenF1 telemetry (services/race_control/collision.py). */
export interface CollisionEstimate {
  driver: string;
  t: number;
  level: "incident" | "crash";
  kind: string;
  entry_speed_kph: number;
  impact_speed_kph: number;
  speed_drop_kph: number;
  peak_long_g: number;
  peak_lat_g: number;
  energy_mj: number;
  stopped: boolean;
  telemetry_score: number;
}

export interface DriverRef {
  number: string;
  code?: string | null;
  name?: string | null;
  team?: string | null;
  colour?: string | null;
}

export interface IncidentSummary {
  incident_id: string;
  season: number;
  session_type: string;
  occurred_at: string;
  raw_message: string;
  rule: string;
  zone_id: string;
  zone_name: string;
  marshal_sector: number | null;
  x: number;
  y: number;
  lap_frac: number;
  location_source: "telemetry" | "marshal_sector" | "zone";
  involved: DriverRef[];
  impact: CollisionEstimate | null;
  radio_clips: number;
  cars_in_window: number;
}

export interface IncidentList {
  circuit: string;
  source: string;
  built_from: string;
  incidents: IncidentSummary[];
}

export interface Advice {
  level: string;
  flag: SuggestedFlag;
  headline: string;
  why: string;
  action: string;
  say: string;
}

export interface StructureAtRisk {
  asset_id: string;
  name: string | null;
  category: string;
  distance_m: number;
  coverage: string[];
  position_source: "osm" | "official_list";
}

export interface InsuranceImpact {
  zone_id: string;
  zone_name: string;
  barrier_type: string | null;
  impact_speed_kph: number;
  impact_speed_source: "telemetry" | "assumed";
  energy_mj: number;
  estimated_cost_eur: number;
  zone_mean_cost_eur: number | null;
  zone_risk_score: number | null;
  zone_tier: string | null;
  structures_at_risk: StructureAtRisk[];
  structures_in_reach: number;
  lines_engaged: string[];
  sources: { cost: string; structures: string };
}

export interface RuleCitation {
  citation: string;
  document: string;
  article: string | null;
  page: number;
  score: number;
  heading: string | null;
  text: string;
}

export interface ActiveIncident extends IncidentSummary {
  advice: Advice;
  collision: CollisionEstimate | null;
  insurance: InsuranceImpact;
  rules: RuleCitation[];
  detected_at: string;
}

export interface VoiceLeg {
  score: number | null;
  distress?: number;
  keyword_score?: number;
  emotions: Record<string, number>;
  keywords: string[];
  reassured: boolean;
}

export interface AudioLeg {
  score: number;
  rms_dbfs: number | null;
  strain_ratio: number | null;
  transients_per_s: number;
  duration_s: number;
}

export interface SeverityResult {
  score: number | null;
  label: SeverityLabel | null;
  weights: Partial<Record<"telemetry" | "voice" | "audio", number>>;
  telemetry: CollisionEstimate | null;
  radio: {
    source: string;
    driver: string | null;
    offset_s: number | null;
    transcript?: string;
    voice?: VoiceLeg;
    audio?: AudioLeg;
    error?: string;
  } | null;
  radio_pending?: boolean;
  radio_error?: string;
  models?: { asr: string | null; emotion: string | null; error: string | null } | Record<string, unknown>;
}

export interface DriverWarning {
  tone: "yellow" | "double_yellow" | "sc" | "vsc" | "red" | "green";
  title: string;
  lines: string[];
  driver: string | null;
  code: string | null;
  colour: string | null;
  distance_m: number;
  sector: number | null;
  kind: string;
}

export interface LogEntry {
  at: string;
  text: string;
  tone: "info" | "warn" | "alert" | "action";
  replay_t: number | null;
}

export interface ReplayState {
  incident_id: string;
  t: number;
  t_start: number;
  t_end: number;
  speed: number;
  running: boolean;
}

export interface GripHazard {
  segment: number;
  level: "WATCH" | "ALERT";
  sector: number | null;
  zone_name: string;
  cars: string[];
  min_residual: number | null;
  lap_frac: number;
}

export interface RaceControlSnapshot {
  circuit: string;
  masts: Mast[];
  deployment: Deployment;
  incident: ActiveIncident | null;
  severity: SeverityResult | null;
  warning: DriverWarning | null;
  replay: ReplayState | null;
  log: LogEntry[];
  hazards: GripHazard[];
}

/** One replay frame: every car's real position at that moment. */
export interface ReplayCar {
  n: string;
  code: string | null;
  colour: string | null;
  involved: boolean;
  x: number;
  y: number;
  speed: number;
  lap_frac: number;
}

export interface CarsFrame {
  t: number;
  cars: ReplayCar[];
}

export type RaceControlEvent =
  | { type: "snapshot" | "reset"; data: RaceControlSnapshot }
  | { type: "cars"; data: CarsFrame }
  | { type: "masts"; data: { masts: Mast[] } }
  | { type: "incident"; data: ActiveIncident }
  | { type: "rules"; data: { incident_id: string; rules: RuleCitation[] } }
  | { type: "severity"; data: SeverityResult }
  | { type: "driver_warning"; data: DriverWarning }
  | { type: "deployment"; data: { deployment: Deployment; label: string; at: string } }
  | { type: "log"; data: LogEntry }
  | { type: "grip"; data: { segment: number; level: "NONE" | "WATCH" | "ALERT"; sector: number | null; cars: string[]; min_residual: number | null } }
  | { type: "replay_start"; data: ReplayState & { incident: IncidentSummary } }
  | { type: "replay_end"; data: ReplayState }
  | { type: "stream_error"; data: { message: string } };
