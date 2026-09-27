import { Panel } from "@/components/ui/Panel";
import { cn } from "@/lib/cn";
import type { LogEntry } from "@/types/raceControl";

const DOT: Record<LogEntry["tone"], string> = {
  info: "bg-faint", warn: "bg-risk-med", alert: "bg-risk-crit", action: "bg-accent",
};

/** Everything race control saw and did, newest first (times are replay seconds from the impact). */
export function RaceControlLog({ entries }: { entries: LogEntry[] }) {
  return (
    <Panel title="Race control log">
      {entries.length === 0 ? (
        <p className="text-[12px] text-faint">Quiet. Replay a real incident or click a marshal mast on the map.</p>
      ) : (
        <ol className="grid max-h-[260px] gap-1.5 overflow-y-auto pr-1 scrollbar-thin">
          {entries.map((e, i) => (
            <li key={`${e.at}-${i}`} className="grid grid-cols-[10px_44px_1fr] items-start gap-2 text-[12px] leading-snug">
              <span className={cn("mt-1.5 size-2 rounded-full", DOT[e.tone])} />
              <span className="num text-[11px] text-faint">{e.replay_t === null ? "" : `${e.replay_t >= 0 ? "+" : ""}${e.replay_t.toFixed(1)}s`}</span>
              <span className={e.tone === "alert" || e.tone === "action" ? "font-medium" : "text-muted"}>{e.text}</span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
