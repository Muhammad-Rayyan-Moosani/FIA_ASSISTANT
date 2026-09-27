"use client";

import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { PanelSkeleton } from "@/components/ui/Skeleton";
import { StateMessage } from "@/components/ui/StateMessage";
import { cn } from "@/lib/cn";
import type { CostRange, SafetyCorner, SafetyOption, SafetyPlan } from "@/types/safetyPlan";

interface SafetyPlanDrawerProps {
  open: boolean;
  onClose: () => void;
  circuitName: string | undefined;
  plan: SafetyPlan | undefined;
  error: string | null;
  onShowZone: (zoneId: string) => void;
}

/** CAD 224k · CAD 1.04M */
function cad(v: number): string {
  if (v >= 1e6) return `CAD ${(v / 1e6).toFixed(2)}M`;
  if (v < 1e3) return `CAD ${Math.round(v)}`;
  return `CAD ${Math.round(v / 1e3)}k`;
}

function price(c: CostRange): string {
  return c.low === c.high ? cad(c.low) : `${cad(c.low)}–${cad(c.high).replace("CAD ", "")}`;
}

/** What should change at the corners where incidents happen next to the crowd, with estimated prices. */
export function SafetyPlanDrawer({ open, onClose, circuitName, plan, error, onShowZone }: SafetyPlanDrawerProps) {
  return (
    <Drawer open={open} onClose={onClose} label="Safety plan">
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="eyebrow">Safety plan{circuitName ? ` · ${circuitName}` : ""}</p>
          <h2 className="display mt-1 text-[30px] font-semibold leading-none">Protect the crowd first</h2>
          <p className="mt-2 text-[13px] text-muted">
            The corners where incidents happen right next to a grandstand, what is there today, and the options to make them safer.
            Prices are estimates in Canadian dollars.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close the safety plan">
          Close
        </Button>
      </header>

      {error && <StateMessage tone="error" title="Couldn't load the safety plan">{error}</StateMessage>}
      {!plan && !error && <PanelSkeleton rows={8} />}

      {plan?.corners.map((c) => (
        <Corner
          key={c.zone_id}
          corner={c}
          onShow={() => {
            onShowZone(c.zone_id);
            onClose();
          }}
        />
      ))}

      {plan && (
        <footer className="grid gap-1.5 border-t border-line pt-4 text-[11.5px] text-faint">
          <p className="text-muted">{plan.disclaimer}</p>
          {plan.assumptions.map((a) => (
            <p key={a.label}>
              {a.label}: {a.value}
              {a.source && <SourceLink href={a.source} />}
            </p>
          ))}
        </footer>
      )}
    </Drawer>
  );
}

function Corner({ corner: c, onShow }: { corner: SafetyCorner; onShow: () => void }) {
  return (
    <section className="grid gap-3 rounded-xl border border-line bg-bg/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="display text-[22px] font-semibold leading-tight">
            <span className="text-faint">#{c.rank}</span> {c.name}
          </h3>
          <p className="text-[11.5px] text-faint">{c.full_name}</p>
        </div>
        <Button size="sm" onClick={onShow}>
          Show on map
        </Button>
      </div>

      <div>
        <p className="eyebrow mb-1.5">Today</p>
        <div className="flex flex-wrap gap-1.5 text-[11.5px]">
          <Chip>{c.serious_per_weekend.toFixed(1)} serious incidents / weekend</Chip>
          <Chip>{c.marshals_out_per_weekend.toFixed(1)} marshal call-outs / weekend</Chip>
          <Chip>
            {Math.round(c.entry_speed_kph)} → {Math.round(c.apex_speed_kph)} km/h
          </Chip>
          <Chip tone="crowd">
            {c.grandstands.length} grandstand{c.grandstands.length > 1 ? "s" : ""} alongside
          </Chip>
        </div>
        <p className="mt-1.5 text-[11.5px] text-faint">{c.grandstands.join(" · ")}</p>
      </div>

      <p className="rounded-lg border-l-2 border-accent bg-accent/8 px-3 py-2 text-[12.5px] leading-snug text-muted">{c.why}</p>

      <div>
        <p className="eyebrow mb-1.5">Options</p>
        <div className="grid gap-2">
          {c.options.map((o) => (
            <Option key={o.key} option={o} />
          ))}
        </div>
      </div>
    </section>
  );
}

function Option({ option: o }: { option: SafetyOption }) {
  const estimate = o.provenance.includes("estimate") || o.provenance.includes("estimated");
  return (
    <div className={cn("grid gap-1.5 rounded-lg border px-3 py-2.5", o.recommended ? "border-risk-low/60 bg-risk-low/8" : "border-line bg-panel")}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="flex items-center gap-2">
          <b className="text-[14px]">{o.title}</b>
          {o.recommended && (
            <span className="rounded-full bg-risk-low/20 px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-risk-low">Recommended</span>
          )}
        </span>
        <span className="text-right">
          <span className="display text-[20px] font-semibold">{o.cost ? (o.cost.high === 0 ? "Free" : price(o.cost)) : "—"}</span>{" "}
          <span className="text-[11px] text-muted">{o.recurring ? "per race weekend" : "one-off"}</span>
        </span>
      </div>
      <p className="text-[12.5px] leading-snug">{o.action}</p>
      <p className="text-[11.5px] leading-snug text-muted">Protects against: {o.protects_against}</p>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-faint">
        <span
          className={cn(
            "rounded px-1.5 py-0.5 font-semibold uppercase tracking-wide",
            estimate ? "bg-risk-med/15 text-risk-med" : "bg-src-measured/15 text-src-measured",
          )}
        >
          {estimate ? "Estimate" : "Sourced"}
        </span>
        <span>{o.cost_basis}</span>
        {o.source && <SourceLink href={o.source} />}
      </p>
      {o.note && <p className="text-[11px] italic text-faint">{o.note}</p>}
    </div>
  );
}

function Chip({ children, tone }: { children: React.ReactNode; tone?: "crowd" }) {
  return (
    <span className={cn("rounded-full border px-2 py-0.5", tone === "crowd" ? "border-risk-high/50 text-risk-high" : "border-line text-muted")}>
      {children}
    </span>
  );
}

function SourceLink({ href }: { href: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="ml-1 text-accent underline-offset-2 hover:underline">
      source
    </a>
  );
}
