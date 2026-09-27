/**
 * Insured structures around the circuit (Step 1 data from OpenStreetMap, exposure from Step 3).
 * Served from /api/insurance/assets/{circuit}. Mirrors backend/api/schemas.py.
 */
import type { Series, SourceMap } from "./api";
import type { RiskTier } from "./risk";

export type AssetCategory =
  | "grandstand"
  | "pit_building"
  | "paddock"
  | "hospitality"
  | "race_control"
  | "media"
  | "medical"
  | "podium"
  | "building"
  | "tower"
  | "bridge"
  | "barrier";

export type CoverageLine =
  | "property"
  | "spectator_liability"
  | "business_interruption"
  | "broadcast_equipment"
  | "participant_accident"
  | "track_infrastructure";

export interface Asset {
  asset_id: string;
  /** "osm": footprint mapped in OpenStreetMap. "official_list": temporary grandstand placed by the corner the official list names (footprint assumed). */
  position_source: "osm" | "official_list";
  name: string | null;
  category: AssetCategory;
  osm_tag: string;
  coverage: CoverageLine[];
  geometry: "polygon" | "line" | "point";
  /** Centred, normalised coordinates in the same frame as TrackGeometry.outline. */
  points: [number, number][];
  height_m: number;
  height_source: "osm_height" | "osm_levels" | "assumed";
  distance_to_track_m: number;
  nearest_lap_frac: number;
  nearest_zone_id: string;
  exposure_score: number;
  exposure_tier: RiskTier;
}

export interface CoverageSummary {
  line: CoverageLine;
  label: string;
  description: string;
  count: number;
  high_exposure: number;
}

export type GroundKind = "water" | "land" | "wood" | "grass" | "beach" | "parking" | "pitch";

export interface GroundArea {
  kind: GroundKind;
  points: [number, number][];
}

export interface ContextRoad {
  kind: "major" | "minor" | "service" | "path" | "rail";
  width_m: number;
  bridge: boolean;
  points: [number, number][];
}

export interface ContextBuilding {
  height_m: number;
  points: [number, number][];
}

/** Surroundings from OpenStreetMap (not insured), drawn for a true picture of the site. */
export interface AssetContext {
  woods: [number, number][][];
  pit_lane: [number, number][][];
  other_raceways: [number, number][][];
  /** Painter's order: draw first to last (largest areas first: river, islands, lakes, woods, ...). */
  ground: GroundArea[];
  roads: ContextRoad[];
  buildings: ContextBuilding[];
}

export type AssetSourceKey = "structures" | "coverage" | "exposure";

/** GET /api/insurance/assets/{circuit}?series&upgrades */
export interface AssetMap {
  circuit: string;
  series: Series;
  attribution: string;
  alignment_error_m: number;
  extent_m: number;
  marshal_posts: number;
  coverage: CoverageSummary[];
  assets: Asset[];
  context: AssetContext;
  sources: SourceMap<AssetSourceKey>;
}
