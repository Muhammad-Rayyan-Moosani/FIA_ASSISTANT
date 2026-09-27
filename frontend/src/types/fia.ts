/** Contracts of the FIA service (FIA/ folder, FastAPI) used by the FIA page. */

export type Severity = "NONE" | "WATCH" | "ALERT";
export type HazardType = "grip_cliff" | "water_sheen" | "oil_streak" | "debris" | "stopped_car";
export type FlagSuggestion = "YELLOW_READY" | "YELLOW" | "DOUBLE_YELLOW" | "VSC" | "SC" | "RED" | "CLEAR";

export interface Point2D {
  x: number;
  y: number;
}

/** Plain-language summary attached to every feed message (FIA/app/services/plain_alerts.py). */
export interface PlainAlert {
  level: Severity;
  colour: "red" | "amber" | "green" | "grey";
  changed_from: string;
  headline: string;
  why: string;
  action: string;
  flag: FlagSuggestion;
  cars: string[];
  where: string;
  text: string;
  say: string;
  note: string;
}

export interface VisionDetection {
  hazard_type: HazardType;
  confidence: number;
  map_coordinates: Point2D;
  area_m2: number;
  bbox_px: [number, number, number, number];
  frame_index: number;
  detector: string;
}

export interface EvidenceCard {
  hazard_types: HazardType[];
  cars_flagged: string[];
  min_residual: number | null;
  mean_residual: number | null;
  flag_count: number;
  vision: VisionDetection[];
  narrative: string;
}

export interface HazardMessage {
  type: "hazard";
  sector_id: string;
  coordinates: Point2D;
  severity_level: Severity;
  previous_level: Severity;
  evidence_card_data: EvidenceCard;
  timestamp: number;
  plain: PlainAlert;
}

export interface CrashMessage {
  type: "crash";
  driver: string | null;
  driver_code: string | null;
  kind: string;
  impact_speed_kph: number | null;
  peak_decel_g: number | null;
  still_moving: boolean;
  coordinates: Point2D | null;
  severity_level: "ALERT";
  timestamp: number | null;
  plain: PlainAlert;
}

export interface CarPositionMessage {
  type: "car_position";
  car_id: string;
  timestamp: number;
  x: number;
  y: number;
  speed_kph: number;
  brake: number;
  throttle: number;
  residual: number | null;
  below_threshold: boolean;
}

/** Everything the service pushes on /ws/alerts. */
export type FeedMessage =
  | HazardMessage
  | CrashMessage
  | CarPositionMessage
  | { type: "vision_detections"; detections: VisionDetection[] }
  | { type: "demo_narration"; text: string }
  | { type: "demo_reset" }
  | { type: "snapshot"; segments: unknown[] }
  | { type: "pong" };

export interface FiaScenario {
  track: string;
  segment_length_m: number;
  residual_threshold: number;
  track_half_width_m: number;
  centerline: [number, number][];
  brake_point: [number, number];
  oil_zone: { from: [number, number]; to: [number, number]; grip: number };
  camera_quad_m: [number, number][];
  cars: { car_id: string; note: string }[];
  rulebook: string[];
  sample_queries: string[];
}

export interface CameraBox {
  hazard_type: HazardType;
  confidence: number;
  polygon_px: [number, number][];
}

export interface DemoVisionResult {
  detector: string;
  camera_size_px: [number, number];
  overhead_size_px: [number, number];
  detections: VisionDetection[];
  camera_boxes: CameraBox[];
  camera_png_b64: string | null;
  overhead_png_b64: string | null;
}

export interface RuleCitation {
  citation: string;
  document: string;
  article: string | null;
  page: number;
  score: number;
  text: string;
}

export interface RuleQueryResult {
  query: string;
  citations: RuleCitation[];
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface Transcription {
  text: string;
  language: string | null;
  duration_s: number;
  segments: TranscriptSegment[];
  model: string;
  related_rules: RuleCitation[];
}

export interface FiaHealth {
  status: string;
  rulebook: { documents: string[]; total_chunks: number; embedding_backend: string; status: string };
}
