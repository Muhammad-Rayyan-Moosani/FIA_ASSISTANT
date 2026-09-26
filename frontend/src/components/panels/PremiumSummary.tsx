import { Panel } from "@/components/ui/Panel";
import { PanelSkeleton } from "@/components/ui/Skeleton";
import { SourceBadge } from "@/components/ui/SourceBadge";
import { Stat } from "@/components/ui/Stat";
import { formatEur, formatNumber, formatPercent } from "@/lib/format";
import { SERIES_LABEL } from "@/lib/labels";
import type { RiskMap } from "@/types/risk";

export function PremiumSummary({ riskMap, upgradeCount }: { riskMap: RiskMap | undefined; upgradeCount: number }) {
  if (!riskMap) return <PanelSkeleton rows={4} />;
  const { totals: t, sources: s, series_factors: f } = riskMap;
  const ratio = t.blanket_premium_eur > 0 ? t.segmented_premium_eur / t.blanket_premium_eur : 1;

  return (
    <Panel title="Cover for one race weekend">
      <div className="grid grid-cols-2 gap-3">
        <Stat label="Zone-based premium" value={formatEur(t.segmented_premium_eur)} size="lg" valueClassName="text-accent" source={s.premium} />
        <Stat label="Blanket premium" value={formatEur(t.blanket_premium_eur)} size="lg" valueClassName="text-muted" source={s.blanket} />
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        <span className="rounded-full bg-risk-low/14 px-2.5 py-1 text-xs font-semibold tracking-wide text-risk-low">
          {t.cost_delta_eur >= 0 ? "Save" : "Costs"} {formatEur(Math.abs(t.cost_delta_eur))} · {formatPercent(Math.abs(t.cost_delta_pct))}
        </span>
        <span className="text-[11.5px] text-faint">vs one flat policy on the whole circuit</span>
        <SourceBadge source={s.saving} />
      </div>

      <div className="grid gap-1.5" aria-hidden="true">
        {[
          ["Blanket", 1, "var(--color-faint)"],
          ["Zone-based", ratio, "var(--color-accent)"],
        ].map(([label, w, color]) => (
          <div key={label as string} className="grid grid-cols-[86px_1fr] items-center gap-2.5 text-xs text-muted">
            <span>{label}</span>
            <div className="h-2.5 overflow-hidden rounded bg-bg">
              <div className="h-full rounded transition-[width] duration-500" style={{ width: `${Math.min(100, (w as number) * 100)}%`, background: color as string }} />
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-2.5 max-sm:grid-cols-2">
        <Stat size="sm" label="Expected loss (EAL)" value={formatEur(t.eal_eur)} source={s.eal} />
        <Stat size="sm" label="1-in-100 worst case (VaR99)" value={formatEur(t.var99_eur)} source={s.var99} />
        <Stat size="sm" label="Diversification" value={formatEur(t.diversification_benefit_eur)} source={s.diversification} />
      </div>

      <p className="text-[11.5px] text-faint">
        {SERIES_LABEL[riskMap.series]} · {formatNumber(riskMap.n_seasons)} simulated weekends · frequency × {(f.grid * f.error).toFixed(2)} (grid {f.grid} × error {f.error}) · impact energy × {f.energy}
        {upgradeCount > 0 && ` · includes ${upgradeCount} safety ${upgradeCount === 1 ? "upgrade" : "upgrades"}`}
        <SourceBadge source={s.series_factors} />
      </p>
    </Panel>
  );
}
