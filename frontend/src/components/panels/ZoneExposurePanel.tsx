import { Panel } from "@/components/ui/Panel";
import { PanelSkeleton } from "@/components/ui/Skeleton";
import { Stat } from "@/components/ui/Stat";
import { ZONE_TYPE_LABEL } from "@/lib/labels";
import { riskHex } from "@/lib/riskColor";
import type { ExposureMap } from "@/types/exposure";
import type { TrackZone } from "@/types/track";

interface ZoneExposurePanelProps {
  zone: TrackZone | undefined;
  exposure: ExposureMap | undefined;
}

/** The selected zone: how often, who is exposed, how fast, and whether it repeats year to year. */
export function ZoneExposurePanel({ zone, exposure }: ZoneExposurePanelProps) {
  if (!zone || !exposure) return <PanelSkeleton rows={4} />;
  const z = exposure.zones.find((x) => x.zone_id === zone.zone_id);
  if (!z) return null;
  const maxYear = Math.max(1, ...z.by_season.map((y) => y.count));
  const color = riskHex(z.score);

  return (
    <Panel title="Selected zone">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="display text-[24px] font-semibold leading-[1.05]">{zone.name}</h3>
          <p className="mt-1 text-xs text-muted">
            {ZONE_TYPE_LABEL[zone.zone_type]}
            {zone.turn_number !== null && ` · Turn ${zone.turn_number}`}
          </p>
        </div>
        <span className="shrink-0 rounded-md border border-line px-2 py-1 text-center">
          <span className="display block text-[18px] font-semibold leading-none" style={{ color }}>#{z.rank}</span>
          <span className="text-[10px] text-faint">of {exposure.zones.length}</span>
        </span>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
        <Stat label="Serious incidents" value={z.serious_per_weekend.toFixed(1)} hint="per race weekend" />
        <Stat label="Marshal call-outs" value={z.marshals_out_per_weekend.toFixed(1)} hint="per race weekend" />
        <Stat label="Cars arrive at" value={<>{Math.round(z.entry_speed_kph)} <small className="text-[11.5px] text-muted">km/h</small></>} />
        <Stat label="Next to a grandstand" value={z.near_crowd ? "Yes" : "No"} valueClassName={z.near_crowd ? "text-risk-high" : "text-muted"} />
      </div>

      {z.grandstands.length > 0 && <p className="-mt-1 text-[11.5px] text-muted">{z.grandstands.join(" · ")}</p>}

      <div>
        <div className="mb-1.5 text-[11.5px] text-muted">
          Serious incidents by year
        </div>
        <div className="grid grid-cols-4 items-end gap-2" style={{ height: 64 }}>
          {z.by_season.map((y) => (
            <div key={y.season} className="grid h-full grid-rows-[1fr_auto] items-end gap-1 text-center">
              <div className="rounded-t" style={{ height: `${Math.max(4, (y.count / maxYear) * 100)}%`, background: color, opacity: 0.85 }} title={`${y.count} in ${y.season}`} />
              <span className="num text-[10.5px] text-muted">
                {y.season} · {y.count}
              </span>
            </div>
          ))}
        </div>
      </div>
    </Panel>
  );
}
