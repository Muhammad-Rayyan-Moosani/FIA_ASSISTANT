import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/Panel";
import { PanelSkeleton } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import type { IncidentList } from "@/types/raceControl";

export const REPLAY_SPEEDS = [1, 2, 4] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

interface IncidentPickerProps {
  incidents: IncidentList | undefined;
  zoneId: string | null;
  zoneName: string | undefined;
  activeId: string | null;
  speed: ReplaySpeed;
  onSpeed: (s: ReplaySpeed) => void;
  onReplay: (incidentId: string) => void;
  onEvaluateZone: () => void;
  busy: boolean;
}

/** Real incidents to replay: counted crashes with released OpenF1 telemetry, the selected zone's first. */
export function IncidentPicker({ incidents, zoneId, zoneName, activeId, speed, onSpeed, onReplay, onEvaluateZone, busy }: IncidentPickerProps) {
  if (!incidents) return <PanelSkeleton rows={4} />;
  const list = [...incidents.incidents].sort((a, b) => Number(b.zone_id === zoneId) - Number(a.zone_id === zoneId) || b.occurred_at.localeCompare(a.occurred_at));
  const inZone = list.filter((i) => i.zone_id === zoneId).length;
  return (
    <Panel
      title="Replay a real incident"
      description={`${incidents.built_from}. Every car moves on its real OpenF1 position; nothing is simulated.`}
      actions={
        <div className="flex rounded-md border border-line p-0.5" role="radiogroup" aria-label="Replay speed">
          {REPLAY_SPEEDS.map((s) => (
            <button key={s} type="button" role="radio" aria-checked={speed === s} onClick={() => onSpeed(s)}
              className={cn("num h-6 rounded px-1.5 text-[11px]", speed === s ? "bg-panel-2 text-ink" : "text-muted hover:text-ink")}>
              {s}×
            </button>
          ))}
        </div>
      }
    >
      <Button variant="primary" onClick={onEvaluateZone} disabled={busy || !zoneId}>
        {inZone ? `Evaluate ${zoneName ?? "this zone"} (${inZone} real incident${inZone > 1 ? "s" : ""})` : "Evaluate the selected zone"}
      </Button>
      <ul className="grid max-h-[340px] gap-1.5 overflow-y-auto pr-1 scrollbar-thin">
        {list.map((i) => (
          <li key={i.incident_id}>
            <button type="button" onClick={() => onReplay(i.incident_id)} disabled={busy}
              className={cn("grid w-full grid-cols-[1fr_auto] gap-x-2 rounded-lg border px-2.5 py-2 text-left transition-colors hover:bg-panel-2 disabled:opacity-60",
                i.incident_id === activeId ? "border-accent bg-panel-2" : i.zone_id === zoneId ? "border-line" : "border-line-soft")}>
              <span className="truncate text-[12.5px] font-medium">{i.raw_message}</span>
              <span className="num text-[11px] text-faint">{i.session_type.replace("Practice ", "FP")} {i.season}</span>
              <span className="col-span-2 mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                {i.involved.map((d) => (
                  <span key={d.number} className="inline-flex items-center gap-1">
                    <span className="size-2 rounded-full" style={{ background: d.colour ? `#${d.colour}` : "var(--color-faint)" }} />
                    {d.code ?? `#${d.number}`}
                  </span>
                ))}
                <span className="text-faint">· {i.zone_name.split(" (")[0]}{i.marshal_sector ? ` · S${i.marshal_sector}` : ""}</span>
                {i.impact && (
                  <span className={cn("rounded px-1 font-semibold", i.impact.level === "crash" ? "bg-risk-crit/15 text-risk-crit" : "bg-risk-med/15 text-risk-med")}>
                    {Math.round(i.impact.impact_speed_kph)} km/h {i.impact.stopped ? "· stopped" : ""}
                  </span>
                )}
                {i.radio_clips > 0 && <span className="rounded bg-accent/15 px-1 font-semibold text-accent">radio</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
