import type {
  CarPositionMessage,
  CrashMessage,
  FeedMessage,
  HazardMessage,
  PlainAlert,
  Point2D,
  Severity,
  VisionDetection,
} from "@/types/fia";

/** Trail points kept per car (10 Hz ⇒ ~20 s of track). */
export const TRAIL_LIMIT = 240;
/** Feed cards kept on screen. */
export const FEED_LIMIT = 60;

export interface TrailPoint {
  x: number;
  y: number;
  residual: number | null;
}

export interface CarState {
  id: string;
  x: number;
  y: number;
  speedKph: number;
  brake: number;
  throttle: number;
  residual: number | null;
  trail: TrailPoint[];
}

export interface FeedEntry {
  id: number;
  plain: PlainAlert;
  message: HazardMessage | CrashMessage;
}

export interface FiaFeedState {
  cars: CarState[];
  /** Active 25 m cells (WATCH/ALERT) by sector id. */
  cells: Record<string, Exclude<Severity, "NONE">>;
  /** Newest first. */
  feed: FeedEntry[];
  /** Latest plain-language message for the race director. */
  director: PlainAlert | null;
  narration: string | null;
  vision: VisionDetection[];
  crashes: Point2D[];
  nextId: number;
}

export const initialFeedState: FiaFeedState = {
  cars: [],
  cells: {},
  feed: [],
  director: null,
  narration: null,
  vision: [],
  crashes: [],
  nextId: 1,
};

function withCar(cars: CarState[], m: CarPositionMessage): CarState[] {
  const point: TrailPoint = { x: m.x, y: m.y, residual: m.residual };
  const next = { id: m.car_id, x: m.x, y: m.y, speedKph: m.speed_kph, brake: m.brake, throttle: m.throttle, residual: m.residual };
  const i = cars.findIndex((c) => c.id === m.car_id);
  if (i === -1) return [...cars, { ...next, trail: [point] }];
  const prev = cars[i]!;
  const trail = prev.trail.length >= TRAIL_LIMIT ? [...prev.trail.slice(1), point] : [...prev.trail, point];
  return cars.map((c, j) => (j === i ? { ...next, trail } : c));
}

function pushEntry(state: FiaFeedState, message: HazardMessage | CrashMessage): FiaFeedState {
  const entry: FeedEntry = { id: state.nextId, plain: message.plain, message };
  return { ...state, feed: [entry, ...state.feed].slice(0, FEED_LIMIT), director: message.plain, nextId: state.nextId + 1 };
}

/** Fold one /ws/alerts message into the page state. Unknown message types are ignored. */
export function feedReducer(state: FiaFeedState, msg: FeedMessage): FiaFeedState {
  switch (msg.type) {
    case "car_position":
      return { ...state, cars: withCar(state.cars, msg) };
    case "hazard": {
      const cells = { ...state.cells };
      if (msg.severity_level === "NONE") delete cells[msg.sector_id];
      else cells[msg.sector_id] = msg.severity_level;
      return pushEntry({ ...state, cells }, msg);
    }
    case "crash":
      return pushEntry({ ...state, crashes: msg.coordinates ? [...state.crashes, msg.coordinates] : state.crashes }, msg);
    case "vision_detections":
      return { ...state, vision: msg.detections };
    case "demo_narration":
      return { ...state, narration: msg.text };
    case "demo_reset":
      return { ...initialFeedState, nextId: state.nextId };
    default:
      return state;
  }
}

/** "grid_22_0" → the 25 m cell it covers, in track metres. Lap-distance ids ("seg_0042") have no x/y cell. */
export function cellRect(sectorId: string, segmentLength: number): { x: number; y: number; size: number } | null {
  const m = /^grid_(-?\d+)_(-?\d+)$/.exec(sectorId);
  if (!m) return null;
  return { x: Number(m[1]) * segmentLength, y: Number(m[2]) * segmentLength, size: segmentLength };
}

export type ResidualTone = "normal" | "reduced" | "cliff";

/** Braking residual → colour band: ≥0.9 normal, ≥threshold reduced, below threshold = grip cliff. */
export function residualTone(residual: number | null, threshold: number): ResidualTone | null {
  if (residual === null) return null;
  if (residual >= 0.9) return "normal";
  return residual >= threshold ? "reduced" : "cliff";
}

export function carPhase(car: Pick<CarState, "brake" | "throttle">): "BRAKING" | "FULL THROTTLE" | "CORNER" {
  if (car.brake > 0) return "BRAKING";
  return car.throttle > 50 ? "FULL THROTTLE" : "CORNER";
}
