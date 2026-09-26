import type { Provenance, Series } from "@/types/api";
import type { BarrierType, IngestStage, RunoffType, ZoneType } from "@/types/track";

/** Display names for backend enums. Domain vocabulary, not data. */

export const SERIES_OPTIONS: readonly { value: Series; label: string }[] = [
  { value: "f1", label: "F1" },
  { value: "f2", label: "F2" },
  { value: "f3", label: "F3" },
];

export const SERIES_LABEL: Record<Series, string> = { f1: "F1", f2: "F2", f3: "F3" };

export const BARRIER_LABEL: Record<BarrierType, string> = {
  tyre_wall: "Tyre wall",
  guardrail: "Guardrail",
  tecpro: "TecPro",
  concrete: "Concrete",
  safer: "SAFER barrier",
};

export const RUNOFF_LABEL: Record<RunoffType, string> = { gravel: "Gravel", asphalt: "Asphalt", grass: "Grass" };

export const ZONE_TYPE_LABEL: Record<ZoneType, string> = {
  braking: "Braking zone",
  high_speed: "High-speed corner",
  straight: "Straight",
  pit_lane: "Pit lane",
};

export const PROVENANCE_LABEL: Record<Provenance, string> = {
  measured: "Real",
  assumed: "Assumed",
  modelled: "Calculated",
};

export const INGEST_STAGE_LABEL: Record<IngestStage, string> = {
  fetch: "Download from OpenF1",
  load: "Read race control",
  zones: "Build zones",
  extract: "Extract incidents",
  geolocate: "Place on track",
  write: "Save",
};

export const INGEST_STAGES: readonly IngestStage[] = ["fetch", "load", "zones", "extract", "geolocate", "write"];
