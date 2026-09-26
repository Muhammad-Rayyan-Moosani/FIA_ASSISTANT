import type { TrackZone } from "@/types/track";
import type { UpgradeSet, ZoneChanges } from "@/types/risk";

/**
 * Stable, compact encoding of an upgrade set for query strings and cache keys.
 * Returns undefined when there is nothing to send, so the parameter is omitted.
 */
export function serializeUpgrades(upgrades: UpgradeSet | undefined): string | undefined {
  if (!upgrades) return undefined;
  const zoneIds = Object.keys(upgrades).filter((id) => Object.keys(upgrades[id] ?? {}).length > 0).sort();
  if (zoneIds.length === 0) return undefined;
  const ordered: UpgradeSet = {};
  for (const id of zoneIds) {
    const c = upgrades[id]!;
    ordered[id] = {
      ...(c.barrier_type !== undefined && { barrier_type: c.barrier_type }),
      ...(c.runoff_depth_m !== undefined && { runoff_depth_m: c.runoff_depth_m }),
      ...(c.fence_height_m !== undefined && { fence_height_m: c.fence_height_m }),
    };
  }
  return JSON.stringify(ordered);
}

/** Keep only the fields that differ from the zone's current equipment. */
export function diffChanges(zone: TrackZone, changes: ZoneChanges): ZoneChanges {
  return {
    ...(changes.barrier_type !== undefined && changes.barrier_type !== zone.barrier_type && { barrier_type: changes.barrier_type }),
    ...(changes.runoff_depth_m !== undefined && changes.runoff_depth_m !== zone.runoff_depth_m && { runoff_depth_m: changes.runoff_depth_m }),
    ...(changes.fence_height_m !== undefined && changes.fence_height_m !== zone.fence_height_m && { fence_height_m: changes.fence_height_m }),
  };
}

export const isEmptyChanges = (c: ZoneChanges | undefined): boolean => !c || Object.keys(c).length === 0;

export function withoutZone(upgrades: UpgradeSet, zoneId: string): UpgradeSet {
  const rest = { ...upgrades };
  delete rest[zoneId];
  return rest;
}
