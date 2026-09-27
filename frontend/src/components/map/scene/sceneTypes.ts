import type { TrackFrame } from "@/lib/trackGeometry";
import type { ZoneView } from "@/lib/zoneView";
import type { RunoffType } from "@/types/track";

/** Real track width; lateral distances in the scene are true to scale. */
export const TRACK_WIDTH_M = 14;
/** Heights (structures, barriers, fences, trees) are drawn ×2 so they read from the overview camera. */
export const VERTICAL_EXAGGERATION = 2;
/** Cars are drawn ×3 so they are visible at circuit scale. */
export const CAR_SCALE = 3;

export interface SceneScale {
  /** World units per metre. */
  u: number;
  trackHalf: number;
  /** Converts a real height in metres to world units (includes the vertical exaggeration). */
  h: (metres: number) => number;
}

/** A zone with its placement on the 3D track. */
export interface PlacedZone {
  view: ZoneView;
  range: [number, number];
  mid: number;
  /** Slowest point of the zone on the reference lap (kerb position). */
  apex: number;
  /** Side of the track the run-off, barrier and grandstands sit on. */
  side: 1 | -1;
  /** Lateral distance from the centreline to the barrier face, in world units. */
  barrierOffset: number;
}

export interface SceneData {
  frame: TrackFrame;
  outline: [number, number][];
  zones: PlacedZone[];
  scale: SceneScale;
  speedKph: number[];
  lengthM: number;
  maxWeight: number;
}

/** Per-zone flash level (0..1), written on a severe crash, read by the barrier visuals. */
export type FlashMap = Map<string, number>;
export type FlashRef = { readonly current: FlashMap };

export const SKY_FOG = "#cbd8e4";
export const NEUTRAL_ZONE = "#3a4a5a";

export const RUNOFF_COLOR: Record<RunoffType, string> = {
  gravel: "#cbb68c",
  asphalt: "#5b5f65",
  grass: "#6c8c4c",
};
