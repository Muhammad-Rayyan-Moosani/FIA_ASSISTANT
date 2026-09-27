import { Panel } from "@/components/ui/Panel";
import { cn } from "@/lib/cn";
import { riskHex } from "@/lib/riskColor";
import type { ExposureMap } from "@/types/exposure";
import type { TrackGeometry } from "@/types/track";

interface TopCornersProps {
  exposure: ExposureMap | undefined;
  track: TrackGeometry | undefined;
  selectedZoneId: string | null;
  onSelect: (zoneId: string) => void;
}

/** The few corners that matter: where the owner should act first. */
export function TopCorners({ exposure, track, selectedZoneId, onSelect }: TopCornersProps) {
  if (!exposure || !track) return null;
  const names = new Map(track.zones.map((z) => [z.zone_id, z]));
  const top = exposure.zones.slice(0, exposure.backtest.top_k);

  return (
    <Panel title="Where to act first" description="The corners with the most serious incidents. Click one to see it on the map.">
      <ol className="grid gap-1.5">
        {top.map((z) => {
          const zone = names.get(z.zone_id);
          return (
            <li key={z.zone_id}>
              <button
                type="button"
                onClick={() => onSelect(z.zone_id)}
                aria-pressed={z.zone_id === selectedZoneId}
                className={cn(
                  "grid w-full grid-cols-[4px_1fr_auto] items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors",
                  z.zone_id === selectedZoneId ? "border-accent bg-panel-2" : "border-line bg-bg hover:border-faint",
                )}
              >
                <i className="h-8 rounded" style={{ background: riskHex(z.score) }} />
                <span className="min-w-0">
                  <b className="display block truncate text-[15px] font-semibold tracking-[0.03em]">
                    {z.rank}. {zone?.short_name ?? z.zone_id}
                  </b>
                  <span className="text-[11.5px] text-muted">
                    {z.marshals_out_per_weekend.toFixed(1)} marshal call-outs / weekend
                    {z.near_crowd && " · next to a grandstand"}
                  </span>
                </span>
                <span className="text-right">
                  <span className="num block text-[15px]">{z.serious_per_weekend.toFixed(1)}</span>
                  <span className="text-[10.5px] text-faint">per weekend</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}
