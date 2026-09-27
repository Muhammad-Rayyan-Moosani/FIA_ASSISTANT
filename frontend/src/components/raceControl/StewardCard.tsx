import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/Panel";
import { cn } from "@/lib/cn";
import type { ActiveIncident, DeployAction, Deployment } from "@/types/raceControl";
import { DEPLOYMENT_LABEL, FlagChip } from "./FlagChip";

interface StewardCardProps {
  incident: ActiveIncident;
  deployment: Deployment;
  onDeploy: (action: DeployAction) => void;
  busy: boolean;
}

const ACTIONS: { action: DeployAction; label: string; style: string }[] = [
  { action: "sc", label: "Deploy Safety Car", style: "border-[#ffb000] bg-[#ffb000] text-black hover:brightness-105" },
  { action: "vsc", label: "Deploy VSC", style: "border-[#ffb000] bg-transparent text-[#ffb000] hover:bg-[#ffb000]/10" },
  { action: "red", label: "Red flag", style: "border-risk-crit bg-transparent text-risk-crit hover:bg-risk-crit/10" },
  { action: "clear", label: "Track clear", style: "border-risk-low bg-transparent text-risk-low hover:bg-risk-low/10" },
];

/** Race control's incident advisory: what happened (real telemetry), the suggested flag, one-click actions. */
export function StewardCard({ incident, deployment, onDeploy, busy }: StewardCardProps) {
  const a = incident.advice;
  const c = incident.collision;
  const crash = a.level === "crash";
  return (
    <Panel title="Steward advisory">
      <div className={cn("rounded-xl border border-l-4 px-3.5 py-3 animate-fade-in",
        crash ? "border-line border-l-risk-crit bg-[linear-gradient(90deg,color-mix(in_srgb,var(--color-risk-crit)_14%,transparent),transparent_70%)]"
          : "border-line border-l-risk-med bg-[linear-gradient(90deg,color-mix(in_srgb,var(--color-risk-med)_12%,transparent),transparent_70%)]")}
        aria-live="assertive">
        <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
          {incident.marshal_sector ? `Sector ${incident.marshal_sector}` : "Incident"} · suggested <FlagChip flag={a.flag} />
        </div>
        <div className="display mt-1.5 text-[22px] font-bold uppercase leading-tight tracking-[0.02em]">{a.headline}</div>
        <p className="mt-1 text-[13px]">{a.why}</p>
        <p className="mt-2 text-[13.5px] font-semibold">→ {a.action}</p>
        {c && (
          <dl className="num mt-3 grid grid-cols-4 gap-2 text-center text-[11px]">
            {[["impact", `${Math.round(c.impact_speed_kph)} km/h`], ["load", `${c.peak_long_g.toFixed(1)} g`], ["energy", `${c.energy_mj.toFixed(1)} MJ`], ["car", c.stopped ? "stopped" : "moving"]].map(([k, v]) => (
              <div key={k} className="rounded-md bg-bg px-1 py-1.5">
                <dt className="font-sans text-[10px] uppercase tracking-wide text-faint">{k}</dt>
                <dd className="mt-0.5 font-semibold text-ink">{v}</dd>
              </div>
            ))}
          </dl>
        )}
        <p className="mt-2 text-[11px] text-faint">
          Race control message: “{incident.raw_message}” · {incident.session_type} {incident.season}. Impact values are lower bounds (OpenF1 samples at 3.7 Hz). Suggestion only: race control decides.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {ACTIONS.map((x) => (
          <Button key={x.action} disabled={busy || (x.action !== "clear" && deployment === x.action)} onClick={() => onDeploy(x.action)}
            className={cn("justify-center border font-semibold", x.style, a.flag.toLowerCase() === x.action && "ring-2 ring-offset-2 ring-offset-panel ring-[#ffb000]")}>
            {x.label}
          </Button>
        ))}
      </div>
      <p className="text-[12px] text-muted">
        Now: <b className="text-ink">{DEPLOYMENT_LABEL[deployment]}</b>. Masts, the driver display and the cars on the map follow the call.
      </p>
    </Panel>
  );
}
