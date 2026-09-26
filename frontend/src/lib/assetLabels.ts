import type { AssetCategory, CoverageLine } from "@/types/assets";

export const ASSET_CATEGORY_LABEL: Record<AssetCategory, string> = {
  grandstand: "Grandstand",
  pit_building: "Pit building",
  paddock: "Paddock",
  hospitality: "Hospitality",
  race_control: "Race control",
  media: "Media centre",
  medical: "Medical centre",
  podium: "Podium",
  building: "Circuit building",
  tower: "Tower / mast",
  bridge: "Bridge",
  barrier: "Barrier / wall",
};

export const COVERAGE_SHORT: Record<CoverageLine, string> = {
  property: "Property",
  spectator_liability: "Spectator liability",
  business_interruption: "Business interruption",
  broadcast_equipment: "Broadcast equipment",
  participant_accident: "Participant accident",
  track_infrastructure: "Track infrastructure",
};
