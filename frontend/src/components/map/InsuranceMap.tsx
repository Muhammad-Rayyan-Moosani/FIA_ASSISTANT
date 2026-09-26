"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/Skeleton";
import { StateMessage } from "@/components/ui/StateMessage";
import { Button } from "@/components/ui/Button";
import { SAMPLE_SEASONS, type SimulationState } from "@/hooks/insurance/useSimulationStream";
import type { ZoneView } from "@/lib/zoneView";
import type { MapView } from "@/store/uiStore";
import type { TrackGeometry } from "@/types/track";
import { TrackMap2D } from "./fallback/TrackMap2D";
import { MapOverlay } from "./MapOverlay";
import { RiskLegend } from "./RiskLegend";
import { SimulationHud } from "./SimulationHud";
import { ZoneStrip } from "./ZoneStrip";

const TrackScene3D = dynamic(() => import("./scene/TrackScene3D"), {
  ssr: false,
  loading: () => <div className="absolute inset-0 grid place-items-center text-sm text-muted">Loading 3D view…</div>,
});

interface InsuranceMapProps {
  track: TrackGeometry | undefined;
  trackError: string | null;
  onRetryTrack: () => void;
  zones: ZoneView[];
  riskError: string | null;
  isRepricing: boolean;
  selectedZoneId: string | null;
  onSelectZone: (zoneId: string) => void;
  view: MapView;
  reducedMotion: boolean;
  sim: SimulationState;
}

/** The map column: 3D twin or 2D fallback, overlays, and the zone strip. */
export function InsuranceMap(p: InsuranceMapProps) {
  return (
    <section className="grid min-h-0 min-w-0 grid-cols-1 grid-rows-[1fr_auto] bg-bg max-lg:h-[min(68vh,580px)] max-lg:min-h-[420px]" aria-label="Circuit risk map">
      <div className="relative min-h-0 min-w-0 overflow-hidden">
        {p.track ? (
          <>
            {p.view === "3d" ? (
              <TrackScene3D
                circuitId={p.track.circuit}
                outline={p.track.outline}
                zones={p.zones}
                selectedZoneId={p.selectedZoneId}
                onSelectZone={p.onSelectZone}
                reducedMotion={p.reducedMotion}
              />
            ) : (
              <TrackMap2D outline={p.track.outline} zones={p.zones} selectedZoneId={p.selectedZoneId} onSelectZone={p.onSelectZone} reducedMotion={p.reducedMotion} />
            )}
            <MapOverlay track={p.track} />
            <RiskLegend />
            <SimulationHud sim={p.sim} sampleSeasons={SAMPLE_SEASONS} />
            {p.isRepricing && p.sim.status !== "running" && (
              <div className="absolute right-4 top-4 rounded-full border border-line bg-panel/90 px-3 py-1 text-xs text-muted backdrop-blur" role="status">
                Repricing 10,000 seasons…
              </div>
            )}
            {p.riskError && (
              <StateMessage tone="error" title="Risk data unavailable" className="absolute bottom-16 right-4 max-w-sm">
                {p.riskError}
              </StateMessage>
            )}
            <p className="pointer-events-none absolute bottom-3.5 right-4 hidden text-right text-[11.5px] text-faint lg:block">
              {p.view === "3d" ? "Drag to orbit · scroll to zoom · click a zone" : "Click a zone"}
            </p>
          </>
        ) : p.trackError ? (
          <div className="absolute inset-0 grid place-items-center p-6">
            <StateMessage tone="error" title="Couldn't load the track" action={<Button size="sm" onClick={p.onRetryTrack}>Try again</Button>}>
              {p.trackError}
            </StateMessage>
          </div>
        ) : (
          <div className="absolute inset-0 grid place-items-center">
            <Skeleton className="h-2/3 w-2/3 rounded-3xl opacity-40" />
          </div>
        )}
      </div>
      <ZoneStrip zones={p.zones} selectedZoneId={p.selectedZoneId} onSelect={p.onSelectZone} />
    </section>
  );
}
