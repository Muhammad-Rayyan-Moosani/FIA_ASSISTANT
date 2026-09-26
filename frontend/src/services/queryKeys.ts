import { serializeUpgrades } from "@/lib/upgrades";
import type { Series } from "@/types/api";
import type { UpgradeSet } from "@/types/risk";
import type { IncidentQuery } from "@/types/track";

/** Central TanStack Query keys so invalidation after ingestion or what-if stays consistent. */
export const queryKeys = {
  circuits: () => ["circuits"] as const,
  track: (circuit: string) => ["track", circuit] as const,
  incidents: (q: IncidentQuery) => ["incidents", q.circuit, q.zone_id ?? null, q.season ?? null] as const,
  incidentsForCircuit: (circuit: string) => ["incidents", circuit] as const,
  riskMap: (circuit: string, series: Series, upgrades?: UpgradeSet) =>
    ["risk-map", circuit, series, serializeUpgrades(upgrades) ?? ""] as const,
  riskMapsForCircuit: (circuit: string) => ["risk-map", circuit] as const,
  assets: (circuit: string, series: Series, upgrades?: UpgradeSet) =>
    ["assets", circuit, series, serializeUpgrades(upgrades) ?? ""] as const,
  report: (circuit: string, series: Series, upgrades?: UpgradeSet) =>
    ["report", circuit, series, serializeUpgrades(upgrades) ?? ""] as const,
};
