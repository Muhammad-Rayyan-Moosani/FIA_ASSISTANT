import type { IncidentSummary, ReplayState } from "@/types/raceControl";

/** Progress of the real-telemetry replay: seconds relative to the impact (0 = the moment it happened). */
export function ReplayBar({ replay, incident }: { replay: ReplayState | null; incident: IncidentSummary | null }) {
  if (!replay) return null;
  const span = replay.t_end - replay.t_start || 1;
  const pct = Math.min(100, Math.max(0, ((replay.t - replay.t_start) / span) * 100));
  const impactPct = Math.min(100, Math.max(0, (-replay.t_start / span) * 100));
  const label = incident ? `${incident.session_type} ${incident.season} · ${incident.raw_message}` : replay.incident_id;
  return (
    <div className="pointer-events-none absolute bottom-16 left-4 z-10 w-[min(440px,calc(100%-2rem))] rounded-xl border border-white/10 bg-black/70 px-3 py-2 text-white backdrop-blur">
      <div className="flex items-center justify-between gap-3 text-[11px]">
        <span className="flex items-center gap-1.5 font-semibold uppercase tracking-[0.12em]">
          <span className={replay.running ? "size-2 animate-pulse rounded-full bg-[#ff2b3e]" : "size-2 rounded-full bg-white/40"} />
          {replay.running ? `Replay ${replay.speed}×` : "Replay ended"}
        </span>
        <span className="num text-white/80">{replay.t >= 0 ? "+" : ""}{replay.t.toFixed(1)} s</span>
      </div>
      <div className="relative mt-1.5 h-1.5 rounded-full bg-white/15">
        <div className="absolute inset-y-0 left-0 rounded-full bg-white/80" style={{ width: `${pct}%` }} />
        <div className="absolute -top-1 h-3.5 w-0.5 bg-[#ff2b3e]" style={{ left: `${impactPct}%` }} title="impact" />
      </div>
      <p className="mt-1 truncate text-[11px] text-white/70">{label} · real OpenF1 telemetry</p>
    </div>
  );
}
