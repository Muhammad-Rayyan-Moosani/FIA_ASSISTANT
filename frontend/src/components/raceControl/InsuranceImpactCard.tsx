import { Panel } from "@/components/ui/Panel";
import { COVERAGE_SHORT, ASSET_CATEGORY_LABEL } from "@/lib/assetLabels";
import { formatEur } from "@/lib/format";
import type { InsuranceImpact } from "@/types/raceControl";
import type { AssetCategory, CoverageLine } from "@/types/assets";

/** The same crash seen by the insurer: modelled cost, lines engaged, real structures in reach. */
export function InsuranceImpactCard({ impact, onSelectAsset }: { impact: InsuranceImpact; onSelectAsset: (id: string) => void }) {
  const ratio = impact.zone_mean_cost_eur ? impact.estimated_cost_eur / impact.zone_mean_cost_eur : null;
  return (
    <Panel title="Insurance impact" source={{ provenance: "modelled", title: "Insurance impact", detail: `${impact.sources.cost}\n\n${impact.sources.structures}` }}>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-faint">Estimated claim</div>
          <div className="num text-[24px] font-semibold leading-tight">{formatEur(impact.estimated_cost_eur)}</div>
          <div className="text-[11px] text-muted">
            {impact.energy_mj.toFixed(1)} MJ at {impact.impact_speed_kph} km/h ({impact.impact_speed_source}) · {impact.barrier_type?.replace("_", " ") ?? "barrier"}
          </div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-faint">vs this zone</div>
          <div className="num text-[24px] font-semibold leading-tight">{ratio ? `${ratio.toFixed(1)}×` : "–"}</div>
          <div className="text-[11px] text-muted">{impact.zone_mean_cost_eur ? `zone average ${formatEur(impact.zone_mean_cost_eur)} per crash` : ""}</div>
        </div>
      </div>
      <div className="flex flex-wrap gap-1">
        {impact.lines_engaged.map((l) => (
          <span key={l} className="rounded-full border border-line px-2 py-0.5 text-[11px] text-muted">{COVERAGE_SHORT[l as CoverageLine] ?? l}</span>
        ))}
      </div>
      {impact.structures_at_risk.length > 0 ? (
        <ul className="grid gap-1">
          {impact.structures_at_risk.map((s) => (
            <li key={s.asset_id}>
              <button type="button" onClick={() => onSelectAsset(s.asset_id)} className="grid w-full grid-cols-[1fr_auto] gap-2 rounded-md px-2 py-1 text-left text-[12.5px] hover:bg-panel-2">
                <span className="truncate">{s.name ?? ASSET_CATEGORY_LABEL[s.category as AssetCategory] ?? s.category}
                  <span className="text-faint"> · {(ASSET_CATEGORY_LABEL[s.category as AssetCategory] ?? s.category).toLowerCase()}{s.position_source === "official_list" ? " (placed)" : ""}</span>
                </span>
                <span className="num text-[11.5px] text-muted">{s.distance_m} m</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12px] text-faint">No mapped structures within 200 m of the crash point.</p>
      )}
    </Panel>
  );
}
