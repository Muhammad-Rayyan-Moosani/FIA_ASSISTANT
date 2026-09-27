"use client";

import { useEffect, useMemo, useState } from "react";
import { AppHeader } from "@/components/layout/AppHeader";
import { InsuranceMap } from "@/components/map/InsuranceMap";
import { EvidencePanel } from "@/components/panels/EvidencePanel";
import { ExposureSummary } from "@/components/panels/ExposureSummary";
import { TopCorners } from "@/components/panels/TopCorners";
import { WhyItMatters } from "@/components/panels/WhyItMatters";
import { ZoneExposurePanel } from "@/components/panels/ZoneExposurePanel";
import { SafetyPlanDrawer } from "@/components/plan/SafetyPlanDrawer";
import { Button } from "@/components/ui/Button";
import { StateMessage } from "@/components/ui/StateMessage";
import { useCircuits } from "@/hooks/ingestion/useCircuits";
import { useTrack } from "@/hooks/ingestion/useTrack";
import { useAssets } from "@/hooks/insurance/useAssets";
import { useExposure } from "@/hooks/insurance/useExposure";
import { useSafetyPlan } from "@/hooks/insurance/useSafetyPlan";
import { usePrefersReducedMotion } from "@/hooks/ui/useMediaQuery";
import { useWebGLSupport } from "@/hooks/ui/useWebGLSupport";
import { heatFromExposure, joinZones, topZoneId } from "@/lib/zoneView";
import { describeError } from "@/services/http/errors";
import { useUiStore } from "@/store/uiStore";
import type { AssetMap } from "@/types/assets";
import type { RiskTier } from "@/types/risk";

const NO_UPGRADES = {};
/** Beyond this distance from the track a crash can't reach a structure (same reach as the Step 2 asset map). */
const EXPOSURE_REACH_M = 200;

function tier(score: number): RiskTier {
  return score >= 85 ? "CRITICAL" : score >= 60 ? "HIGH" : score >= 25 ? "MEDIUM" : "LOW";
}

/** Page-level orchestration: owns data fetching and passes plain props to presentational components. */
export function InsuranceWorkspace() {
  const circuitId = useUiStore((s) => s.circuitId);
  const view = useUiStore((s) => s.view);
  const selectedZoneId = useUiStore((s) => s.selectedZoneId);
  const riskOverlay = useUiStore((s) => s.riskOverlay);
  const showTraffic = useUiStore((s) => s.showTraffic);
  const selectedAssetId = useUiStore((s) => s.selectedAssetId);
  const { setCircuit, setView, selectZone, setRiskOverlay, setShowTraffic, selectAsset } = useUiStore.getState();

  const webgl = useWebGLSupport();
  const reducedMotion = usePrefersReducedMotion();

  const circuits = useCircuits();
  const track = useTrack(circuitId);
  const exposure = useExposure(circuitId);
  const rawAssets = useAssets(circuitId, "f1", NO_UPGRADES);
  const [planOpen, setPlanOpen] = useState(false);
  const plan = useSafetyPlan(circuitId, planOpen);

  // Default to the first circuit, and to its busiest zone once exposure is known.
  useEffect(() => {
    const first = circuits.data?.[0];
    if (!circuitId && first) setCircuit(first.id);
  }, [circuitId, circuits.data, setCircuit]);

  useEffect(() => {
    const ids = exposure.data?.zones.map((z) => z.zone_id) ?? [];
    if (exposure.data && (!selectedZoneId || !ids.includes(selectedZoneId))) selectZone(topZoneId(exposure.data));
  }, [exposure.data, selectedZoneId, selectZone]);

  useEffect(() => {
    if (webgl === false && view === "3d") setView("2d");
  }, [webgl, view, setView]);

  const heat = useMemo(() => heatFromExposure(exposure.data), [exposure.data]);
  const zones = useMemo(() => joinZones(track.data, heat), [track.data, heat]);
  const selected = zones.find((z) => z.zone.zone_id === selectedZoneId);

  // Structures are coloured by the incidents of the zone they face, fading with distance from the track.
  const assets = useMemo<AssetMap | undefined>(() => {
    if (!rawAssets.data) return undefined;
    const score = new Map(heat.map((h) => [h.zone_id, h.risk_score]));
    return {
      ...rawAssets.data,
      assets: rawAssets.data.assets.map((a) => {
        const s = Math.round((score.get(a.nearest_zone_id) ?? 0) * Math.max(0, 1 - a.distance_to_track_m / EXPOSURE_REACH_M));
        return { ...a, exposure_score: s, exposure_tier: tier(s) };
      }),
    };
  }, [rawAssets.data, heat]);

  if (circuits.error) {
    return (
      <main className="grid min-h-full place-items-center p-6">
        <StateMessage tone="error" title="Can't connect to the risk API" action={<Button onClick={() => circuits.refetch()}>Try again</Button>}>
          {describeError(circuits.error)}
        </StateMessage>
      </main>
    );
  }

  if (circuits.data?.length === 0) {
    return (
      <main className="grid min-h-full place-items-center p-6">
        <StateMessage tone="empty" title="No circuits yet">
          Run the ingestion pipeline (Step 1) to load circuits: <code className="num">python -m scripts.ingest</code>
        </StateMessage>
      </main>
    );
  }

  return (
    <div className="grid h-full grid-rows-[auto_1fr] max-lg:h-auto">
      <AppHeader
        circuits={circuits.data}
        circuitId={circuitId}
        onCircuit={setCircuit}
        view={view}
        onView={setView}
        webgl={webgl}
        onOpenPlan={() => setPlanOpen(true)}
        planDisabled={!exposure.data}
      />

      <main className="grid min-h-0 grid-cols-[minmax(0,1fr)_400px] max-lg:grid-cols-1">
        <InsuranceMap
          track={track.data}
          trackError={track.error ? describeError(track.error) : null}
          onRetryTrack={() => track.refetch()}
          zones={zones}
          riskError={exposure.error && !exposure.data ? describeError(exposure.error) : null}
          selectedZoneId={selectedZoneId}
          onSelectZone={selectZone}
          view={view}
          reducedMotion={reducedMotion}
          assets={assets}
          selectedAssetId={selectedAssetId}
          onSelectAsset={selectAsset}
          riskOverlay={riskOverlay}
          onRiskOverlay={setRiskOverlay}
          showTraffic={showTraffic}
          onShowTraffic={setShowTraffic}
        />

        <aside className="min-h-0 overflow-y-auto border-l border-line bg-panel scrollbar-thin max-lg:overflow-visible max-lg:border-l-0 max-lg:border-t" aria-label="Third-party exposure">
          <ExposureSummary exposure={exposure.data} />
          <TopCorners exposure={exposure.data} track={track.data} selectedZoneId={selectedZoneId} onSelect={selectZone} />
          <ZoneExposurePanel zone={selected?.zone} exposure={exposure.data} />
          <EvidencePanel exposure={exposure.data} />
          <WhyItMatters exposure={exposure.data} />
        </aside>
      </main>

      <SafetyPlanDrawer
        open={planOpen}
        onClose={() => setPlanOpen(false)}
        circuitName={track.data?.name}
        plan={plan.data}
        error={plan.error ? describeError(plan.error) : null}
        onShowZone={selectZone}
      />
    </div>
  );
}
