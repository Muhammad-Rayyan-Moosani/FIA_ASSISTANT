"use client";

import { useEffect, useMemo, useState } from "react";
import { AppHeader } from "@/components/layout/AppHeader";
import { InsuranceMap } from "@/components/map/InsuranceMap";
import { CoverageSavings } from "@/components/panels/CoverageSavings";
import { EvidencePanel } from "@/components/panels/EvidencePanel";
import { ExposureSummary } from "@/components/panels/ExposureSummary";
import { TopCorners } from "@/components/panels/TopCorners";
import { WhyItMatters } from "@/components/panels/WhyItMatters";
import { ZoneExposurePanel } from "@/components/panels/ZoneExposurePanel";
import { SafetyPlanDrawer } from "@/components/plan/SafetyPlanDrawer";
import { DriverHud } from "@/components/raceControl/DriverHud";
import { IncidentPicker, type ReplaySpeed } from "@/components/raceControl/IncidentPicker";
import { InsuranceImpactCard } from "@/components/raceControl/InsuranceImpactCard";
import { RaceControlLog } from "@/components/raceControl/RaceControlLog";
import { ReplayBar } from "@/components/raceControl/ReplayBar";
import { RulesCard } from "@/components/raceControl/RulesCard";
import { SeverityBreakdown } from "@/components/raceControl/SeverityBreakdown";
import { StewardCard } from "@/components/raceControl/StewardCard";
import { Button } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { StateMessage } from "@/components/ui/StateMessage";
import { useCircuits } from "@/hooks/ingestion/useCircuits";
import { useTrack } from "@/hooks/ingestion/useTrack";
import { useAssets } from "@/hooks/insurance/useAssets";
import { useExposure } from "@/hooks/insurance/useExposure";
import { useRiskMap } from "@/hooks/insurance/useRiskMap";
import { useSafetyPlan } from "@/hooks/insurance/useSafetyPlan";
import { useRaceControlActions, useReplayableIncidents, useRuleSearch } from "@/hooks/raceControl/useRaceControlData";
import { useRaceControlStream } from "@/hooks/raceControl/useRaceControlStream";
import { usePrefersReducedMotion } from "@/hooks/ui/useMediaQuery";
import { useWebGLSupport } from "@/hooks/ui/useWebGLSupport";
import { cn } from "@/lib/cn";
import { heatFromExposure, joinZones, topZoneId } from "@/lib/zoneView";
import { describeError } from "@/services/http/errors";
import { useUiStore } from "@/store/uiStore";
import type { AssetMap } from "@/types/assets";
import type { StoryInput } from "@/types/raceControl";
import type { RiskTier } from "@/types/risk";

type SideTab = "race" | "insurance";
const NO_UPGRADES = {};
/** Beyond this distance from the track a crash can't reach a structure (same reach as the Step 2 asset map). */
const EXPOSURE_REACH_M = 200;

function tier(score: number): RiskTier {
  return score >= 85 ? "CRITICAL" : score >= 60 ? "HIGH" : score >= 25 ? "MEDIUM" : "LOW";
}

/**
 * One map for everything. Replaying a real incident (or clicking a marshal mast / zone) runs the FIA safety loop
 * and the insurance view together: masts light up, the car behind gets a cockpit warning, the steward card
 * offers SC / VSC, the severity model reads telemetry and radio, and the insurer sees the claim and the
 * structures in reach, while the zone's exposure evidence stays one tab away.
 */
export function UnifiedTrackView() {
  const circuitId = useUiStore((s) => s.circuitId);
  const view = useUiStore((s) => s.view);
  const selectedZoneId = useUiStore((s) => s.selectedZoneId);
  const riskOverlay = useUiStore((s) => s.riskOverlay);
  const showTraffic = useUiStore((s) => s.showTraffic);
  const selectedAssetId = useUiStore((s) => s.selectedAssetId);
  const cinematic = useUiStore((s) => s.cinematic);
  const { setCircuit, setView, selectZone, setRiskOverlay, setShowTraffic, selectAsset, setCinematic } = useUiStore.getState();

  const webgl = useWebGLSupport();
  const reducedMotion = usePrefersReducedMotion();

  const circuits = useCircuits();
  const track = useTrack(circuitId);
  const exposure = useExposure(circuitId);
  const rawAssets = useAssets(circuitId, "f1", NO_UPGRADES);
  const [planOpen, setPlanOpen] = useState(false);
  const riskMap = useRiskMap(circuitId, "f1", NO_UPGRADES);

  const { state: rc, connection } = useRaceControlStream(circuitId);
  const incidents = useReplayableIncidents(circuitId);
  const actions = useRaceControlActions(circuitId);
  const rules = useRuleSearch();
  // The user's tab choice, remembered with the incident count at that moment: a newer incident brings race control forward.
  const [tabChoice, setTabChoice] = useState<{ tab: SideTab; seq: number }>({ tab: "race", seq: 0 });
  const tab: SideTab = rc.incidentSeq > tabChoice.seq ? "race" : tabChoice.tab;
  const setTab = (t: SideTab) => setTabChoice({ tab: t, seq: rc.incidentSeq });
  const plan = useSafetyPlan(circuitId, planOpen || tab === "insurance");
  const [speed, setSpeed] = useState<ReplaySpeed>(2);

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

  // A new incident selects its zone, so the insurance side (exposure, structures) follows it.
  const incidentZone = rc.incident?.zone_id;
  useEffect(() => {
    if (rc.incidentSeq > 0 && incidentZone) selectZone(incidentZone);
  }, [rc.incidentSeq, incidentZone, selectZone]);

  // a manual rule search gives way to the articles of each new incident
  const resetRules = rules.reset;
  useEffect(() => {
    if (rc.incidentSeq > 0) resetRules();
  }, [rc.incidentSeq, resetRules]);

  const heat = useMemo(() => heatFromExposure(exposure.data), [exposure.data]);
  const zones = useMemo(() => joinZones(track.data, heat), [track.data, heat]);
  const selected = zones.find((z) => z.zone.zone_id === selectedZoneId);

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

  const incX = rc.incident?.x;
  const incY = rc.incident?.y;
  // with the cinematic replay on, the director flies the camera; otherwise just fly to the crash
  const focusPoint = useMemo(() => (!cinematic && incX !== undefined && incY !== undefined ? { x: incX, y: incY } : null), [cinematic, incX, incY]);
  const story = useMemo<StoryInput>(
    () => ({
      cinematic, replaySeq: rc.replaySeq, incidentSeq: rc.incidentSeq, replayIncident: rc.replayIncident, incident: rc.incident,
      warning: rc.warning, deployment: rc.deployment, masts: rc.masts,
    }),
    [cinematic, rc.replaySeq, rc.incidentSeq, rc.replayIncident, rc.incident, rc.warning, rc.deployment, rc.masts],
  );
  const busy = actions.replay.isPending || actions.evaluate.isPending;
  const actionError = actions.error ? describeError(actions.error) : null;
  const replayingSummary = incidents.data?.incidents.find((i) => i.incident_id === rc.replay?.incident_id) ?? null;

  if (circuits.error) {
    return (
      <main className="grid min-h-full place-items-center p-6">
        <StateMessage tone="error" title="Can't connect to the API" action={<Button onClick={() => circuits.refetch()}>Try again</Button>}>
          {describeError(circuits.error)}
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

      <main className="grid min-h-0 grid-cols-[minmax(0,1fr)_420px] max-lg:grid-cols-1">
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
          raceControl={{
            masts: rc.masts,
            deployment: rc.deployment,
            replayActive: Boolean(rc.replay),
            focusPoint,
            onSelectMast: (sector) => actions.evaluate.mutate({ target: { marshal_sector: sector }, speed }),
            story,
            onCinematic: setCinematic,
          }}
          overlay={
            <>
              <DriverHud warning={rc.warning} />
              <ReplayBar replay={rc.replay} incident={replayingSummary} />
            </>
          }
        />

        <aside className="min-h-0 overflow-y-auto border-l border-line bg-panel scrollbar-thin max-lg:overflow-visible max-lg:border-l-0 max-lg:border-t" aria-label="Race control and insurance">
          <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-line bg-panel/95 px-5 py-3 backdrop-blur">
            <SegmentedControl<SideTab>
              label="Side panel"
              value={tab}
              onChange={setTab}
              options={[{ value: "race", label: "Race control" }, { value: "insurance", label: "Insurance" }]}
            />
            <span className="flex items-center gap-2 text-[11px] text-muted" title="Race-control event stream">
              <span className={cn("size-2 rounded-full", connection === "live" ? "bg-risk-low" : connection === "connecting" ? "animate-pulse bg-risk-med" : "bg-risk-crit")} />
              {connection === "live" ? "Live" : connection === "connecting" ? "Connecting" : "Offline"}
              {(rc.replay || rc.incident) && (
                <Button size="sm" variant="ghost" onClick={() => actions.reset.mutate()}>Reset</Button>
              )}
            </span>
          </div>

          {tab === "race" ? (
            <>
              {(actionError || rc.streamError) && (
                <p className="border-b border-line bg-risk-crit/10 px-5 py-2.5 text-[12.5px] text-risk-crit" role="alert">{actionError ?? rc.streamError}</p>
              )}
              {rc.incident && (
                <>
                  <StewardCard incident={rc.incident} deployment={rc.deployment} onDeploy={(a) => actions.deploy.mutate(a)} busy={actions.deploy.isPending} />
                  <SeverityBreakdown severity={rc.severity} />
                  <InsuranceImpactCard impact={rc.incident.insurance} onSelectAsset={selectAsset} />
                </>
              )}
              <IncidentPicker
                incidents={incidents.data}
                zoneId={selectedZoneId}
                zoneName={selected?.zone.name}
                activeId={rc.replay?.incident_id ?? null}
                speed={speed}
                onSpeed={setSpeed}
                onReplay={(id) => actions.replay.mutate({ incidentId: id, speed })}
                onEvaluateZone={() => selectedZoneId && actions.evaluate.mutate({ target: { zone_id: selectedZoneId }, speed })}
                busy={busy}
              />
              <RulesCard
                citations={rules.data?.citations ?? rc.incident?.rules ?? []}
                pending={rules.isPending}
                error={rules.error ? describeError(rules.error) : null}
                onSearch={(q) => rules.mutate(q)}
              />
              <RaceControlLog entries={rc.log} />
            </>
          ) : (
            <>
              <CoverageSavings riskMap={riskMap.data} plan={plan.data} onOpenPlan={() => setPlanOpen(true)} />
              <ExposureSummary exposure={exposure.data} />
              <TopCorners exposure={exposure.data} track={track.data} selectedZoneId={selectedZoneId} onSelect={selectZone} />
              <ZoneExposurePanel zone={selected?.zone} exposure={exposure.data} />
              <EvidencePanel exposure={exposure.data} />
              <WhyItMatters exposure={exposure.data} />
            </>
          )}
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
