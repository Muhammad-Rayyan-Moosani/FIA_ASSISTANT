import { SourceBadge } from "@/components/ui/SourceBadge";
import { formatLapTime, formatNumber } from "@/lib/format";
import type { TrackGeometry } from "@/types/track";

/** Circuit title, reference-lap line and data-source chips over the map. */
export function MapOverlay({ track }: { track: TrackGeometry }) {
  const r = track.reference;
  return (
    <>
    <div className="pointer-events-none absolute inset-x-0 top-0 h-44 bg-gradient-to-b from-bg/85 via-bg/45 to-transparent" aria-hidden="true" />
    <div className="pointer-events-none absolute left-4 top-3 max-w-[min(560px,80%)] lg:left-5 lg:top-4">
      <h1 className="display text-[clamp(26px,3.4vw,42px)] font-semibold leading-none">{track.name}</h1>
      <p className="mt-1.5 text-[12.5px] text-muted">
        {track.country} · {formatNumber(track.length_m)} m · {track.zones.length} zones · reference lap: {r.season} {r.event_name}, car #{r.driver_number}
        {r.driver_name ? ` (${r.driver_name})` : ""}, lap {r.lap_number}, {formatLapTime(r.lap_duration_s)}
      </p>
      <div className="pointer-events-auto mt-2.5 flex flex-wrap gap-1.5 max-sm:hidden">
        <SourceBadge label="Track shape" source={track.sources.outline} />
        <SourceBadge label="Corner speeds" source={track.sources.speeds} />
        <SourceBadge label="Zones" source={track.sources.zones} />
        <SourceBadge label="Incidents" source={track.sources.incidents} />
        <SourceBadge label="Safety equipment" source={track.sources.safety_inventory} />
      </div>
    </div>
    </>
  );
}
