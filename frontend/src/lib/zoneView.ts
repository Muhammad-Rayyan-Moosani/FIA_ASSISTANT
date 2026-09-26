import type { RiskMap, ZoneRisk } from "@/types/risk";
import type { TrackGeometry, TrackZone } from "@/types/track";

/** A track zone (Step 1) joined with its risk (Step 3). Risk is null until the risk map loads. */
export interface ZoneView {
  zone: TrackZone;
  risk: ZoneRisk | null;
}

export function joinZones(track: TrackGeometry | undefined, riskMap: RiskMap | undefined): ZoneView[] {
  if (!track) return [];
  const byId = new Map(riskMap?.zones.map((z) => [z.zone_id, z]) ?? []);
  return [...track.zones]
    .sort((a, b) => a.start_frac - b.start_frac)
    .map((zone) => ({ zone, risk: byId.get(zone.zone_id) ?? null }));
}

/** Highest-premium zone, used as the default selection. */
export function topZoneId(riskMap: RiskMap | undefined): string | null {
  if (!riskMap || riskMap.zones.length === 0) return null;
  return riskMap.zones.reduce((best, z) => (z.premium_eur > best.premium_eur ? z : best)).zone_id;
}
