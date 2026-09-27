import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/Panel";
import { PanelSkeleton } from "@/components/ui/Skeleton";
import { Stat } from "@/components/ui/Stat";
import { formatEur, formatPercent } from "@/lib/format";
import type { RiskMap } from "@/types/risk";
import type { SafetyPlan } from "@/types/safetyPlan";

/** Assumed exchange rate for comparing the EUR premium model with the CAD safety-plan prices. */
const CAD_PER_EUR = 1.55;
const formatCad = (v: number) => `CA$${v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : `${Math.round(v / 1e3)}k`}`;

/**
 * The insurance punchline: cover each zone for its own risk instead of one blanket policy, and put the money
 * saved into protecting the people at the busiest corners (marshals and spectators).
 */
export function CoverageSavings({ riskMap, plan, onOpenPlan }: { riskMap: RiskMap | undefined; plan: SafetyPlan | undefined; onOpenPlan: () => void }) {
  if (!riskMap) return <PanelSkeleton rows={4} />;
  const t = riskMap.totals;
  const s = riskMap.sources;
  const saved = t.cost_delta_eur;
  const fixes = (plan?.corners ?? [])
    .slice(0, 3)
    .map((c) => ({ corner: c, option: c.options.find((o) => o.recommended && o.cost) }))
    .filter((x): x is { corner: typeof x.corner; option: NonNullable<typeof x.option> } => Boolean(x.option));
  const oneOffCad = fixes.reduce((sum, f) => sum + (f.option.recurring ? 0 : (f.option.cost?.low ?? 0)), 0);
  const weeklyCad = fixes.reduce((sum, f) => sum + (f.option.recurring ? (f.option.cost?.low ?? 0) : 0), 0);
  const fixesEur = (oneOffCad + weeklyCad) / CAD_PER_EUR;

  return (
    <Panel title="Pay for risk where it is" description="Premium per zone from the crash model, vs one flat policy on the whole circuit (F1, one race weekend).">
      <div className="grid grid-cols-2 gap-3">
        <Stat label="Blanket policy" value={formatEur(t.blanket_premium_eur)} size="lg" valueClassName="text-muted" source={s.blanket} />
        <Stat label="Zone-based cover" value={formatEur(t.segmented_premium_eur)} size="lg" valueClassName="text-accent" source={s.premium} />
      </div>
      <div className="rounded-lg bg-risk-low/12 px-3 py-2 text-[13px]">
        <b className="text-risk-low">Save {formatEur(saved)} ({formatPercent(t.cost_delta_pct)})</b> per race weekend: less cover on quiet straights,
        full cover where cars actually crash.
      </div>
      {fixes.length > 0 && (
        <div className="grid gap-1.5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">Where the savings go: people first</p>
          {fixes.map(({ corner, option }) => (
            <div key={corner.zone_id} className="grid grid-cols-[1fr_auto] gap-2 rounded-md border border-line-soft bg-bg px-2.5 py-1.5 text-[12.5px]">
              <span>
                <b>{corner.name}</b> · {option.title.toLowerCase()}
                <span className="block text-[11px] text-faint">{corner.grandstands.join(", ") || "crowd nearby"} · {corner.serious_per_weekend.toFixed(1)} serious incidents / weekend</span>
              </span>
              <span className="num text-[12px] text-muted">{formatCad(option.cost?.low ?? 0)}{option.recurring ? " / wknd" : ""}</span>
            </div>
          ))}
          <p className="text-[12.5px]">
            {fixes.length === 1 ? "This fix" : `All ${fixes.length}`}:{" "}
            <b className="num">{[oneOffCad && `${formatCad(oneOffCad)} one-off`, weeklyCad && `${formatCad(weeklyCad)} per weekend`].filter(Boolean).join(" + ")}</b>{" "}
            (≈ {formatEur(fixesEur)}). One weekend&apos;s saving covers it{" "}
            <b className="text-risk-low">{saved > 0 && fixesEur > 0 ? `${(saved / fixesEur).toFixed(1)}×` : "–"}</b> over.
          </p>
          <p className="text-[10.5px] text-faint">Prices are the safety plan&apos;s estimates (sources in the plan); {CAD_PER_EUR} CAD per EUR is an assumed rate.</p>
        </div>
      )}
      <Button size="sm" onClick={onOpenPlan}>Open the safety plan</Button>
    </Panel>
  );
}
