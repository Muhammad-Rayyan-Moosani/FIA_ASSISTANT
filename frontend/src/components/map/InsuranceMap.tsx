"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/Skeleton";
import { StateMessage } from "@/components/ui/StateMessage";
import { Button } from "@/components/ui/Button";
import { SAMPLE_SEASONS, type SimulationState } from "@/hooks/insurance/useSimulationStream";
import type { ZoneView } from "@/lib/zoneView";
import type { MapView } from "@/store/uiStore";
import type { AssetMap } from "@/types/assets";
import type { TrackGeometry } from "@/types/track";
import { cn } from "@/lib/cn";
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
  assets: AssetMap | undefined;
  selectedAssetId: string | null;
  onSelectAsset: (assetId: string) => void;
  riskOverlay: boolean;
  onRiskOverlay: (on: boolean) => void;
  showTraffic: boolean;
  onShowTraffic: (on: boolean) => void;
}

function Toggle({ on, onChange, children }: { on: boolean; onChange: (on: boolean) => void; children: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => onChange(!on)}
      className={cn(
        "rounded-full border px-3 py-1 text-xs font-medium backdrop-blur transition-colors",
        on ? "border-accent bg-accent/20 text-ink" : "border-line bg-bg/70 text-muted hover:text-ink",
      )}
    >
      {children}
    </button>
  );
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
                speedKph={p.track.speed_kph}
                extentM={p.track.extent_m}
                lengthM={p.track.length_m}
                zones={p.zones}
                assets={p.assets}
                selectedZoneId={p.selectedZoneId}
                onSelectZone={p.onSelectZone}
                selectedAssetId={p.selectedAssetId}
                onSelectAsset={p.onSelectAsset}
                riskOverlay={p.riskOverlay}
                showTraffic={p.showTraffic}
                reducedMotion={p.reducedMotion}
              />
            ) : (
              <TrackMap2D outline={p.track.outline} zones={p.zones} assets={p.assets} selectedZoneId={p.selectedZoneId} onSelectZone={p.onSelectZone} reducedMotion={p.reducedMotion} />
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
            <div className="absolute bottom-3.5 right-4 flex flex-col items-end gap-2">
              <div className="flex gap-1.5">
                <Toggle on={p.riskOverlay} onChange={p.onRiskOverlay}>Risk view</Toggle>
                {p.view === "3d" && <Toggle on={p.showTraffic} onChange={p.onShowTraffic}>Live cars</Toggle>}
              </div>
              <p className="pointer-events-none hidden text-right text-[11px] leading-snug text-white/80 [text-shadow:0_1px_2px_rgba(0,0,0,0.6)] lg:block">
                {p.view === "3d" ? "Drag to orbit · scroll to zoom · click a zone or building" : "Click a zone"}
                <br />
                {p.view === "3d" && "True-scale plan · track width 14 m (assumed) · heights ×2 · cars ×3 · "}
                {p.assets?.attribution ?? ""}
              </p>
            </div>
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
