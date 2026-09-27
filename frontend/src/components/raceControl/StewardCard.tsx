import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/Panel";
import { cn } from "@/lib/cn";
import type { ActiveIncident, AdvisoryAction, DeployAction, Deployment, StewardAdvisory, SuggestedFlag } from "@/types/raceControl";
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
const FLAG_OF: Record<AdvisoryAction, SuggestedFlag> = {
  SAFETY_CAR: "SC", VSC: "VSC", RED_FLAG: "RED", DOUBLE_YELLOW: "DOUBLE_YELLOW", YELLOW: "YELLOW", MONITOR: "CLEAR",
};
const DEPLOY_OF: Partial<Record<AdvisoryAction, DeployAction>> = { SAFETY_CAR: "sc", VSC: "vsc", RED_FLAG: "red" };

function SourceLine({ a }: { a: StewardAdvisory | null }) {
  if (!a || a.pending) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] text-muted">
        <span className="size-2 animate-pulse rounded-full bg-accent" /> {a?.reason ?? "Retrieving the regulations…"}
      </span>
    );
  }
  if (a.source === "claude") {
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="rounded bg-accent/15 px-1.5 py-0.5 font-semibold text-accent">Claude steward agent</span>
        <span className="num text-muted">{a.model} · {((a.latency_ms ?? 0) / 1000).toFixed(1)} s</span>
        <span className={cn("num", a.within_budget ? "text-risk-low" : "text-risk-med")}>
          {a.within_budget ? "within" : "over"} the {(a.budget_ms ?? 2000) / 1000} s target
        </span>
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-[11px]">
      <span className="rounded bg-panel-2 px-1.5 py-0.5 font-semibold text-muted">Rule engine</span>
      <span className="text-faint">{a.reason}</span>
    </span>
  );
}

/**
 * The advisory race control acts on. Facts come from real telemetry; the card itself is written by the Claude
 * steward agent from those facts and the retrieved FIA articles (or by the rule engine without it).
 */
export function StewardCard({ incident, deployment, onDeploy, busy }: StewardCardProps) {
  const adv = incident.advisory;
  const c = incident.collision;
  const flag = adv ? FLAG_OF[adv.recommended_action] : incident.advice.flag;
  const crash = incident.advice.level === "crash";
  const recommended = adv ? DEPLOY_OF[adv.recommended_action] : incident.advice.flag === "SC" ? "sc" : incident.advice.flag === "VSC" ? "vsc" : undefined;
  const codeOf = (n: string) => incident.cars_behind.find((x) => x.driver === n);

  return (
    <Panel title="Steward advisory" actions={<SourceLine a={adv} />}>
      <div
        className={cn(
          "rounded-xl border border-l-4 px-3.5 py-3 animate-fade-in",
          crash
            ? "border-line border-l-risk-crit bg-[linear-gradient(90deg,color-mix(in_srgb,var(--color-risk-crit)_14%,transparent),transparent_70%)]"
            : "border-line border-l-risk-med bg-[linear-gradient(90deg,color-mix(in_srgb,var(--color-risk-med)_12%,transparent),transparent_70%)]",
        )}
        aria-live="assertive"
      >
        <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
          {incident.marshal_sector ? `Sector ${incident.marshal_sector}` : "Incident"} · recommends <FlagChip flag={flag} />
          {adv && !adv.pending && <span className="normal-case tracking-normal text-faint">confidence {adv.confidence}</span>}
        </div>
        <div className="display mt-1.5 text-[21px] font-bold uppercase leading-tight tracking-[0.02em]">{adv?.headline ?? incident.advice.headline}</div>
        <p className="mt-1 text-[13px] leading-snug">{adv?.reasoning ?? incident.advice.why}</p>
        {adv && adv.citations.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {adv.citations.map((a) => <span key={a} className="num rounded border border-line px-1.5 text-[11px] text-muted">FIA Art. {a}</span>)}
          </div>
        )}
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
      </div>

      {adv && adv.driver_messages.length > 0 && (
        <div className="grid gap-1.5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">Sent to the cars behind</p>
          {adv.driver_messages.map((m) => {
            const car = codeOf(m.driver);
            return (
              <div key={m.driver} className="grid grid-cols-[52px_1fr] items-start gap-2 rounded-lg border border-line-soft bg-bg px-2.5 py-2">
                <span className="num text-[12px] font-semibold">{car?.code ?? `#${m.driver}`}<br /><span className="font-normal text-faint">{car ? `${car.distance_m} m` : ""}</span></span>
                <span className="text-[12.5px] leading-snug">
                  <b className="num text-[#ffd84a]">{m.message}</b>
                  <br />
                  <span className="text-muted">{m.avoidance}</span>
                </span>
              </div>
            );
          })}
        </div>
      )}

      {adv && (
        <div className="grid gap-2 text-[12.5px]">
          <ol className="grid gap-1">
            {adv.steward_steps.map((s, i) => (
              <li key={s} className="grid grid-cols-[20px_1fr] gap-1.5"><span className="num text-faint">{i + 1}.</span>{s}</li>
            ))}
          </ol>
          {adv.marshal_instructions && <p><span className="text-faint">Marshals · </span>{adv.marshal_instructions}</p>}
          {adv.spectator_safety && <p><span className="text-faint">Spectators · </span>{adv.spectator_safety}</p>}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        {ACTIONS.map((x) => (
          <Button key={x.action} disabled={busy || (x.action !== "clear" && deployment === x.action)} onClick={() => onDeploy(x.action)}
            className={cn("justify-center border font-semibold", x.style, recommended === x.action && "ring-2 ring-offset-2 ring-offset-panel ring-[#ffb000]")}>
            {x.label}
          </Button>
        ))}
      </div>
      <p className="text-[11.5px] text-muted">
        Now: <b className="text-ink">{DEPLOYMENT_LABEL[deployment]}</b>. Masts, the driver displays and the cars on the map follow the call. Decision support: race control decides.
      </p>
    </Panel>
  );
}
