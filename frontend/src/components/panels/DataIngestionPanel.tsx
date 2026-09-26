import { IconRefresh } from "@/assets/icons";
import { Button } from "@/components/ui/Button";
import { ProgressBar } from "@/components/ui/charts";
import { Panel } from "@/components/ui/Panel";
import { Stat } from "@/components/ui/Stat";
import type { IngestionState } from "@/hooks/ingestion/useIngestionStream";
import { cn } from "@/lib/cn";
import { formatDateTime, formatNumber } from "@/lib/format";
import { INGEST_STAGE_LABEL, INGEST_STAGES } from "@/lib/labels";
import type { CircuitSummary } from "@/types/track";

interface DataIngestionPanelProps {
  circuit: CircuitSummary | undefined;
  state: IngestionState;
  isActive: boolean;
  onStart: () => void;
  onCancel: () => void;
}

function seasonRange(seasons: number[]): string {
  if (seasons.length === 0) return "none";
  const sorted = [...seasons].sort();
  return sorted.length === 1 ? String(sorted[0]) : `${sorted[0]}–${sorted[sorted.length - 1]}`;
}

/** Step 1: data coverage for the circuit and a live view of an ingestion run. */
export function DataIngestionPanel({ circuit, state, isActive, onStart, onCancel }: DataIngestionPanelProps) {
  const c = circuit?.coverage;
  return (
    <Panel
      title="Incident data"
      description="Race-control incidents from OpenF1, placed on the track with GPS at the moment they happened."
      actions={
        isActive ? (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : (
          <Button size="sm" onClick={onStart} disabled={!circuit}>
            <IconRefresh size={14} /> Refresh from OpenF1
          </Button>
        )
      }
    >
      <div className="grid grid-cols-3 gap-2.5">
        <Stat size="sm" label="Seasons" value={c ? seasonRange(c.seasons) : "–"} />
        <Stat size="sm" label="Sessions" value={c ? formatNumber(c.sessions) : "–"} />
        <Stat size="sm" label="Incidents" value={c ? formatNumber(c.incidents) : "–"} />
      </div>
      <p className="text-[11.5px] text-faint">Last updated {formatDateTime(c?.last_ingested_at ?? null)}</p>

      {state.status !== "idle" && (
        <div className="grid gap-2 rounded-xl border border-line-soft bg-bg p-3" aria-live="polite">
          {INGEST_STAGES.map((stage) => {
            const p = state.stages[stage];
            const current = state.currentStage === stage;
            const complete = p !== undefined && p.total > 0 && p.done >= p.total;
            return (
              <div key={stage} className="grid gap-1">
                <div className={cn("flex justify-between text-xs", current ? "text-ink" : complete ? "text-muted" : "text-faint")}>
                  <span>{INGEST_STAGE_LABEL[stage]}</span>
                  <span className="num">{p ? `${formatNumber(p.done)} / ${formatNumber(p.total)}` : ""}</span>
                </div>
                <ProgressBar value={p?.done ?? 0} max={p?.total ?? 1} color={complete ? "var(--color-src-measured)" : "var(--color-accent)"} />
              </div>
            );
          })}
          {state.status === "starting" && <p className="text-xs text-muted">Starting the ingestion job…</p>}
          {state.status === "succeeded" && state.result && (
            <p className="text-xs text-src-measured">
              Saved {formatNumber(state.result.incidentsWritten)} incidents in {state.result.durationS.toFixed(1)} s. The map and prices now use the new data.
            </p>
          )}
          {state.error && <p className="text-xs text-risk-crit">{state.error}</p>}
        </div>
      )}

      {state.feed.length > 0 && (
        <div className="grid max-h-40 gap-1 overflow-y-auto scrollbar-thin" aria-label="Incidents placed so far">
          <p className="text-[11.5px] text-muted">{formatNumber(state.incidentCount)} placed on track</p>
          {state.feed.map((i) => (
            <div key={i.incident_id} className="grid grid-cols-[56px_1fr] gap-2 font-mono text-[11.5px] leading-snug animate-fade-in">
              <span className="text-faint">
                {i.season} {i.turn_number !== null ? `T${i.turn_number}` : ""}
              </span>
              <span className="truncate" title={i.raw_message}>
                {i.raw_message}
              </span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
