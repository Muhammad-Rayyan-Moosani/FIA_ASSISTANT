"use client";

import { useEffect, useMemo } from "react";
import { AppHeader } from "@/components/layout/AppHeader";
import { InsuranceMap } from "@/components/map/InsuranceMap";
import { AssumptionsPanel } from "@/components/panels/AssumptionsPanel";
import { DataIngestionPanel } from "@/components/panels/DataIngestionPanel";
import { PremiumSummary } from "@/components/panels/PremiumSummary";
import { SimulatePanel } from "@/components/panels/SimulatePanel";
import { WhatIfPanel } from "@/components/panels/WhatIfPanel";
import { ZonePanel } from "@/components/panels/ZonePanel";
import { ReportDrawer } from "@/components/report/ReportDrawer";
import { Button } from "@/components/ui/Button";
import { StateMessage } from "@/components/ui/StateMessage";
import { useCircuits } from "@/hooks/ingestion/useCircuits";
import { useIngestionStream } from "@/hooks/ingestion/useIngestionStream";
import { useTrack } from "@/hooks/ingestion/useTrack";
import { useRiskMap } from "@/hooks/insurance/useRiskMap";
import { useSimulationStream } from "@/hooks/insurance/useSimulationStream";
import { usePrefersReducedMotion } from "@/hooks/ui/useMediaQuery";
import { useWebGLSupport } from "@/hooks/ui/useWebGLSupport";
import { isEmptyChanges } from "@/lib/upgrades";
import { joinZones, topZoneId } from "@/lib/zoneView";
import { describeError } from "@/services/http/errors";
import { useActiveUpgrades, useUiStore } from "@/store/uiStore";

/** Page-level orchestration: owns data fetching and passes plain props to presentational components. */
export function InsuranceWorkspace() {
  const circuitId = useUiStore((s) => s.circuitId);
  const series = useUiStore((s) => s.series);
  const view = useUiStore((s) => s.view);
  const selectedZoneId = useUiStore((s) => s.selectedZoneId);
  const reportOpen = useUiStore((s) => s.reportOpen);
  const { setCircuit, setSeries, setView, selectZone, setReportOpen } = useUiStore.getState();
  const upgrades = useActiveUpgrades();

  const webgl = useWebGLSupport();
  const reducedMotion = usePrefersReducedMotion();

  const circuits = useCircuits();
  const track = useTrack(circuitId);
  const riskMap = useRiskMap(circuitId, series, upgrades);
  const ingestion = useIngestionStream(circuitId);
  const simulation = useSimulationStream(circuitId, series, upgrades);

  // Default to the first circuit, and to the most expensive zone once risk is known.
  useEffect(() => {
    const first = circuits.data?.[0];
    if (!circuitId && first) setCircuit(first.id);
  }, [circuitId, circuits.data, setCircuit]);

  useEffect(() => {
    const ids = riskMap.data?.zones.map((z) => z.zone_id) ?? [];
    if (riskMap.data && (!selectedZoneId || !ids.includes(selectedZoneId))) selectZone(topZoneId(riskMap.data));
  }, [riskMap.data, selectedZoneId, selectZone]);

  useEffect(() => {
    if (webgl === false && view === "3d") setView("2d");
  }, [webgl, view, setView]);

  const zones = useMemo(() => joinZones(track.data, riskMap.data), [track.data, riskMap.data]);
  const selected = zones.find((z) => z.zone.zone_id === selectedZoneId);
  const activeCircuit = circuits.data?.find((c) => c.id === circuitId);
  const upgradeCount = Object.values(upgrades).filter((u) => !isEmptyChanges(u)).length;

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
        series={series}
        onSeries={setSeries}
        view={view}
        onView={setView}
        webgl={webgl}
        onOpenReport={() => setReportOpen(true)}
        reportDisabled={!riskMap.data}
      />

      <main className="grid min-h-0 grid-cols-[minmax(0,1fr)_400px] max-lg:grid-cols-1">
        <InsuranceMap
          track={track.data}
          trackError={track.error ? describeError(track.error) : null}
          onRetryTrack={() => track.refetch()}
          zones={zones}
          riskError={riskMap.error && !riskMap.data ? describeError(riskMap.error) : null}
          isRepricing={riskMap.isUpdating}
          selectedZoneId={selectedZoneId}
          onSelectZone={selectZone}
          view={view}
          reducedMotion={reducedMotion}
          sim={simulation.state}
        />

        <aside className="min-h-0 overflow-y-auto border-l border-line bg-panel scrollbar-thin max-lg:overflow-visible max-lg:border-l-0 max-lg:border-t" aria-label="Pricing and controls">
          <PremiumSummary riskMap={riskMap.data} upgradeCount={upgradeCount} />
          {circuitId && <ZonePanel circuitId={circuitId} view={selected} track={track.data} riskMap={riskMap.data} upgrade={selectedZoneId ? upgrades[selectedZoneId] : undefined} />}
          {circuitId && selected && (
            <WhatIfPanel key={`${circuitId}:${selected.zone.zone_id}`} circuitId={circuitId} series={series} zone={selected.zone} upgrades={upgrades} riskMap={riskMap.data} />
          )}
          <SimulatePanel
            sim={simulation.state}
            isRunning={simulation.isRunning}
            onStart={simulation.start}
            onStop={simulation.cancel}
            modelEal={riskMap.data?.totals.eal_eur ?? null}
            nSeasons={riskMap.data?.n_seasons ?? null}
            source={riskMap.data?.sources.simulation}
            disabled={!riskMap.data}
          />
          <DataIngestionPanel circuit={activeCircuit} state={ingestion.state} isActive={ingestion.isActive} onStart={ingestion.start} onCancel={ingestion.cancel} />
          <AssumptionsPanel assumptions={riskMap.data?.assumptions} modelVersion={riskMap.data?.model_version} />
        </aside>
      </main>

      <ReportDrawer
        open={reportOpen}
        onClose={() => setReportOpen(false)}
        circuitId={circuitId}
        series={series}
        upgrades={upgrades}
        track={track.data}
        source={riskMap.data?.sources.report}
      />
    </div>
  );
}
