import { create } from "zustand";
import type { Series } from "@/types/api";
import type { UpgradeSet, ZoneChanges } from "@/types/risk";
import { withoutZone } from "@/lib/upgrades";

export type MapView = "3d" | "2d";

interface UiState {
  circuitId: string | null;
  series: Series;
  view: MapView;
  selectedZoneId: string | null;
  /** What-if upgrades per circuit, keyed by zone_id. Physical changes, so they persist across series. */
  upgradesByCircuit: Record<string, UpgradeSet>;
  reportOpen: boolean;

  setCircuit: (id: string) => void;
  setSeries: (series: Series) => void;
  setView: (view: MapView) => void;
  selectZone: (zoneId: string | null) => void;
  setUpgrade: (circuitId: string, zoneId: string, changes: ZoneChanges) => void;
  clearUpgrade: (circuitId: string, zoneId: string) => void;
  clearAllUpgrades: (circuitId: string) => void;
  setReportOpen: (open: boolean) => void;
}

export const useUiStore = create<UiState>()((set) => ({
  circuitId: null,
  series: "f1",
  view: "3d",
  selectedZoneId: null,
  upgradesByCircuit: {},
  reportOpen: false,

  setCircuit: (id) => set((s) => (s.circuitId === id ? s : { circuitId: id, selectedZoneId: null })),
  setSeries: (series) => set({ series }),
  setView: (view) => set({ view }),
  selectZone: (selectedZoneId) => set({ selectedZoneId }),
  setUpgrade: (circuitId, zoneId, changes) =>
    set((s) => ({
      upgradesByCircuit: {
        ...s.upgradesByCircuit,
        [circuitId]: { ...(s.upgradesByCircuit[circuitId] ?? {}), [zoneId]: changes },
      },
    })),
  clearUpgrade: (circuitId, zoneId) =>
    set((s) => ({
      upgradesByCircuit: { ...s.upgradesByCircuit, [circuitId]: withoutZone(s.upgradesByCircuit[circuitId] ?? {}, zoneId) },
    })),
  clearAllUpgrades: (circuitId) => set((s) => ({ upgradesByCircuit: { ...s.upgradesByCircuit, [circuitId]: {} } })),
  setReportOpen: (reportOpen) => set({ reportOpen }),
}));

const EMPTY_UPGRADES: UpgradeSet = {};

/** Upgrades for the active circuit (stable reference when empty). */
export function useActiveUpgrades(): UpgradeSet {
  return useUiStore((s) => (s.circuitId ? s.upgradesByCircuit[s.circuitId] ?? EMPTY_UPGRADES : EMPTY_UPGRADES));
}
