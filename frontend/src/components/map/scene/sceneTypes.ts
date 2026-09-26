import type { TrackFrame } from "@/lib/trackGeometry";
import type { ZoneView } from "@/lib/zoneView";

/** A zone with its precomputed placement on the 3D track. */
export interface PlacedZone {
  view: ZoneView;
  range: [number, number];
  mid: number;
  /** Side of the track the barrier and grandstand sit on. */
  side: 1 | -1;
}

export interface SceneData {
  frame: TrackFrame;
  outline: [number, number][];
  zones: PlacedZone[];
  maxPremium: number;
}

/** Per-zone flash level (0..1), written by effects on a fence breach, read by the zone visuals. */
export type FlashMap = Map<string, number>;
export type FlashRef = { readonly current: FlashMap };

export const SCENE_BG = "#0b1117";
export const NEUTRAL_ZONE = "#3a4a5a";
