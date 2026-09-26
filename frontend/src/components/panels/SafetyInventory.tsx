import { SourceBadge } from "@/components/ui/SourceBadge";
import { formatEur, formatNumber } from "@/lib/format";
import { BARRIER_LABEL, RUNOFF_LABEL } from "@/lib/labels";
import type { SourceInfo } from "@/types/api";
import type { ZoneChanges } from "@/types/risk";
import type { TrackZone } from "@/types/track";

export function SafetyInventory({ zone, upgrade, source }: { zone: TrackZone; upgrade: ZoneChanges | undefined; source: SourceInfo | undefined }) {
  const rows: [string, string][] = [
    ["Barrier", BARRIER_LABEL[zone.barrier_type]],
    ["Run-off", `${RUNOFF_LABEL[zone.runoff_type]}, ${zone.runoff_depth_m} m deep`],
    ["Debris fence", `${zone.fence_height_m.toFixed(1)} m`],
    ["Grandstands", zone.grandstands.length > 0 ? zone.grandstands.join(", ") : "None next to this zone"],
    ...(zone.grandstands.length > 0
      ? [["Seats · distance", `${formatNumber(zone.grandstand_capacity)} · ${zone.distance_to_stand_m ?? "?"} m`] as [string, string]]
      : []),
    ["Marshal posts", String(zone.marshal_posts)],
    ["Length", `${formatNumber(zone.length_m)} m${zone.turns.length ? ` · turn ${zone.turns.join(", ")}` : ""}`],
    ["Insured assets", formatEur(zone.asset_value_eur)],
  ];
  return (
    <details open className="group">
      <summary className="cursor-pointer text-[12.5px] text-muted">
        Safety equipment in this zone
        <SourceBadge source={source} />
      </summary>
      <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-3.5 gap-y-1 text-[13px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {upgrade && Object.keys(upgrade).length > 0 && (
        <p className="mt-2 text-[11.5px] text-accent">A what-if upgrade is applied to this zone. The prices above include it.</p>
      )}
      {zone.inventory_source && <p className="mt-1 text-[11px] text-faint">Source: {zone.inventory_source}</p>}
    </details>
  );
}
