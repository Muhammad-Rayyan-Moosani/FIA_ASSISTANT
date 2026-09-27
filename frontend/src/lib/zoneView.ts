import type { ExposureMap } from "@/types/exposure";
import type { RiskTier } from "@/types/risk";
import type { TrackGeometry, TrackZone } from "@/types/track";

/** What the map needs to colour, size and label a zone. Kept neutral so the map doesn't depend on one metric. */
export interface ZoneHeat {
  zone_id: string;
  /** 0–100, drives the colour. */
  risk_score: number;
  risk_tier: RiskTier;
  /** Relative size of the zone marker (bigger = more incidents). */
  weight: number;
  /** Short value shown on labels, e.g. "4.8 / weekend". */
  label: string;
}

/** A track zone joined with its heat. Heat is null until the exposure data loads. */
export interface ZoneView {
  zone: TrackZone;
  risk: ZoneHeat | null;
}

export function heatFromExposure(exposure: ExposureMap | undefined): ZoneHeat[] {
  return (exposure?.zones ?? []).map((z) => ({
    zone_id: z.zone_id,
    risk_score: z.score,
    risk_tier: z.tier,
    weight: z.serious_per_weekend,
    label: `${z.serious_per_weekend.toFixed(1)} / weekend`,
  }));
}

export function joinZones(track: TrackGeometry | undefined, heat: ZoneHeat[]): ZoneView[] {
  if (!track) return [];
  const byId = new Map(heat.map((h) => [h.zone_id, h]));
  return [...track.zones]
    .sort((a, b) => a.start_frac - b.start_frac)
    .map((zone) => ({ zone, risk: byId.get(zone.zone_id) ?? null }));
}

/** The zone with the most serious incidents, used as the default selection. */
export function topZoneId(exposure: ExposureMap | undefined): string | null {
  return exposure?.top_zones[0] ?? null;
}
