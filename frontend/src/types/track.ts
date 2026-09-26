/**
 * Step 1 — Data Ingestion contracts (owner: R1 · Data).
 * Produced by backend/services/data_loader.py + zones.py and served from /api/insurance/{circuits,tracks,incidents}.
 */
import type { SourceMap } from "./api";

export type ZoneType = "braking" | "high_speed" | "straight" | "pit_lane";
export type BarrierType = "tyre_wall" | "guardrail" | "tecpro" | "concrete" | "safer";
export type RunoffType = "gravel" | "asphalt" | "grass";

export interface DataCoverage {
  seasons: number[];
  sessions: number;
  incidents: number;
  loss_relevant: number;
  last_ingested_at: string | null;
}

/** GET /api/insurance/circuits */
export interface CircuitSummary {
  id: string;
  name: string;
  short_name: string;
  country: string;
  length_m: number;
  zone_count: number;
  coverage: DataCoverage;
}

export interface SafetyInventory {
  barrier_type: BarrierType;
  runoff_type: RunoffType;
  runoff_depth_m: number;
  fence_height_m: number;
  /** Official grandstand names next to the zone. */
  grandstands: string[];
  grandstand_capacity: number;
  distance_to_stand_m: number | null;
  marshal_posts: number;
  asset_value_eur: number;
  inventory_source: string;
}

export interface TrackZone extends SafetyInventory {
  zone_id: string;
  name: string;
  short_name: string;
  zone_type: ZoneType;
  /** Official turn numbers inside the zone; turn_number is the first of them. */
  turns: number[];
  turn_number: number | null;
  /** Lap-distance fractions in [0, 1]. */
  start_frac: number;
  end_frac: number;
  length_m: number;
  v_entry_kph: number;
  v_apex_kph: number;
  n_incidents: number;
  n_loss_relevant: number;
}

/** The OpenF1 lap the outline and speed profile were taken from. */
export interface ReferenceLap {
  season: number;
  event_name: string;
  session_key: number;
  session_type: string;
  driver_number: number;
  driver_name: string | null;
  lap_number: number;
  lap_duration_s: number;
  sample_count: number;
}

export type TrackSourceKey = "outline" | "speeds" | "zones" | "safety_inventory" | "incidents";

/** GET /api/insurance/tracks/{circuit} */
export interface TrackGeometry {
  circuit: string;
  name: string;
  country: string;
  length_m: number;
  /** Normalised [x, y] points in [-0.5, 0.5], in lap order. */
  outline: [number, number][];
  zones: TrackZone[];
  reference: ReferenceLap;
  sources: SourceMap<TrackSourceKey>;
}

export type IncidentType =
  | "crash"
  | "spin"
  | "stopped"
  | "debris"
  | "collision"
  | "track_limits"
  | "flag_only"
  | "administrative";

export type GeoMethod = "turn_in_message" | "driver_location" | "inferred_slowest_car" | "marshal_sector";
export type GeoConfidence = "high" | "medium" | "low";

/** GET /api/insurance/incidents — one processed race-control incident (ARCHITECTURE.md §4.4). */
export interface Incident {
  incident_id: string;
  circuit: string;
  season: number;
  session_type: string;
  session_key: number;
  lap: number | null;
  occurred_at: string;
  raw_message: string;
  car_numbers: number[];
  turn_number: number | null;
  incident_type: IncidentType;
  severity_score: number;
  loss_relevant: boolean;
  x: number;
  y: number;
  lap_frac: number;
  zone_id: string | null;
  geo_method: GeoMethod;
  geo_confidence: GeoConfidence;
  /** Marshal sector for yellow-flag incidents placed by sector. */
  marshal_sector: number | null;
  entry_speed_kph: number | null;
  kinetic_energy_kj: number | null;
  extraction: { method: "regex" | "llm"; rule: string | null; model: string | null };
}

export interface IncidentQuery {
  circuit: string;
  zone_id?: string;
  season?: number;
}

/** POST /api/insurance/incidents/ingest */
export interface IngestRequest {
  circuit: string;
  /** Re-download race control and track points instead of using the cache. */
  refresh?: boolean;
}

export type IngestStatus = "queued" | "running" | "succeeded" | "failed";

export interface IngestJob {
  job_id: string;
  circuit: string;
  status: IngestStatus;
  created_at: string;
}

/** Pipeline stages in the order scripts/ingest.py runs them. */
export type IngestStage = "fetch" | "load" | "zones" | "extract" | "geolocate" | "write";

/** Events on GET /api/insurance/incidents/ingest/{job_id}/stream (SSE). `type` is the SSE event name. */
export type IngestStreamEvent =
  | { type: "progress"; stage: IngestStage; done: number; total: number; message: string | null }
  | { type: "incident"; incident: Incident }
  | { type: "done"; job_id: string; incidents_written: number; duration_s: number }
  | { type: "stream_error"; code: string; message: string };
