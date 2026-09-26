import { IconPlay, IconStop } from "@/assets/icons";
import { Button } from "@/components/ui/Button";
import { ConvergenceChart } from "@/components/ui/charts";
import { Panel } from "@/components/ui/Panel";
import { Stat } from "@/components/ui/Stat";
import { SAMPLE_SEASONS, type SimulationState } from "@/hooks/insurance/useSimulationStream";
import { formatEur, formatNumber } from "@/lib/format";
import type { SourceInfo } from "@/types/api";

interface SimulatePanelProps {
  sim: SimulationState;
  isRunning: boolean;
  onStart: () => void;
  onStop: () => void;
  modelEal: number | null;
  nSeasons: number | null;
  source: SourceInfo | undefined;
  disabled: boolean;
}

export function SimulatePanel({ sim, isRunning, onStart, onStop, modelEal, nSeasons, source, disabled }: SimulatePanelProps) {
  return (
    <Panel
      title="Simulate a season"
      source={source}
      description={`Replays ${SAMPLE_SEASONS} of the ${nSeasons ? formatNumber(nSeasons) : "…"} simulated weekends on the track while the running expected loss settles.`}
    >
      <div>
        {isRunning ? (
          <Button variant="secondary" onClick={onStop}>
            <IconStop size={14} /> Stop
          </Button>
        ) : (
          <Button variant="primary" onClick={onStart} disabled={disabled}>
            <IconPlay size={14} /> {sim.status === "done" ? "Run again" : "Simulate season"}
          </Button>
        )}
      </div>
      <div className="grid grid-cols-3 gap-2.5" aria-live="polite">
        <Stat size="sm" label="Crashes shown" value={formatNumber(sim.crashes)} />
        <Stat size="sm" label="Fence breaches" value={formatNumber(sim.breaches)} valueClassName={sim.breaches > 0 ? "text-risk-crit" : undefined} />
        <Stat size="sm" label="Running EAL" value={sim.runningEalEur !== null ? formatEur(sim.runningEalEur) : "–"} />
      </div>
      <ConvergenceChart points={sim.convergence} reference={modelEal} capacity={SAMPLE_SEASONS} />
      {sim.error && <p className="text-[12.5px] text-risk-crit">{sim.error}</p>}
    </Panel>
  );
}
