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
      ...(c.speed_factor !== undefined && { speed_factor: c.speed_factor }),
      ...(c.frequency_multiplier !== undefined && { frequency_multiplier: c.frequency_multiplier }),
    };
  }
  return JSON.stringify(ordered);
}

/** Keep only the fields that change something: a different barrier, or a factor other than 1. */
export function diffChanges(zone: TrackZone, changes: ZoneChanges): ZoneChanges {
  return {
    ...(changes.barrier_type !== undefined && changes.barrier_type !== zone.barrier_type && { barrier_type: changes.barrier_type }),
    ...(changes.speed_factor !== undefined && changes.speed_factor !== 1 && { speed_factor: changes.speed_factor }),
    ...(changes.frequency_multiplier !== undefined && changes.frequency_multiplier !== 1 && { frequency_multiplier: changes.frequency_multiplier }),
  };
}

export const isEmptyChanges = (c: ZoneChanges | undefined): boolean => !c || Object.keys(c).length === 0;

export function withoutZone(upgrades: UpgradeSet, zoneId: string): UpgradeSet {
  const rest = { ...upgrades };
  delete rest[zoneId];
  return rest;
}
