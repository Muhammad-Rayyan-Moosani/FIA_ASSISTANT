import { Panel } from "@/components/ui/Panel";
import type { FeedEntry } from "@/lib/fiaFeed";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/cn";
import type { CrashMessage, HazardMessage } from "@/types/fia";
import { FlagChip, LEVEL_BORDER, LevelBadge } from "./badges";

function technical(m: HazardMessage | CrashMessage): string {
  if (m.type === "crash") {
    const speed = m.impact_speed_kph === null ? "–" : `${formatNumber(m.impact_speed_kph)} km/h`;
    return `impact ${speed} · ${m.peak_decel_g ?? "–"} g · ${m.kind} · openf1_extract.detect_impacts format`;
  }
  const c = m.evidence_card_data;
  const update = m.previous_level === m.severity_level ? " · camera update" : "";
  return `${m.sector_id} · ${m.previous_level} → ${m.severity_level}${update} · x ${m.coordinates.x.toFixed(1)} m, y ${m.coordinates.y.toFixed(1)} m · min residual ${c.min_residual ?? "–"} · ${c.hazard_types.join(", ")}`;
}

/** Every message pushed on /ws/alerts, newest first: plain words on top, engineering detail below. */
export function AlertFeed({ entries }: { entries: FeedEntry[] }) {
  return (
    <Panel title={`Live alert feed · ${entries.length}`} description="Hazards and crashes as they are pushed over the /ws/alerts WebSocket.">
      {entries.length === 0 ? (
        <p className="text-[13px] text-faint">Waiting for hazard events… press Run trajectory.</p>
      ) : (
        <ol className="grid max-h-[46vh] gap-2 overflow-y-auto pr-1 scrollbar-thin max-lg:max-h-none">
          {entries.map(({ id, plain, message }) => {
            const level = message.type === "crash" ? "CRASH" : message.severity_level;
            return (
              <li key={id} className={cn("rounded-lg border border-line border-l-4 bg-panel-2 px-3 py-2.5 animate-fade-in", LEVEL_BORDER[level])}>
                <div className="flex flex-wrap items-center gap-2">
                  <LevelBadge level={level} />
                  <span className="font-semibold">{plain.headline}</span>
                  <FlagChip flag={plain.flag} />
                </div>
                <p className="mt-1 text-[13px]">{plain.why}</p>
                <p className="mt-1 text-[13px] font-medium">→ {plain.action}</p>
                <p className="num mt-1.5 text-[11px] leading-snug text-faint">{technical(message)}</p>
                <details className="mt-1">
                  <summary className="cursor-pointer text-[11.5px] text-muted hover:text-ink">WebSocket payload</summary>
                  <pre className="num mt-1.5 max-h-64 overflow-auto rounded-md bg-bg p-2 text-[10.5px] leading-snug scrollbar-thin">{JSON.stringify(message, null, 2)}</pre>
                </details>
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}
