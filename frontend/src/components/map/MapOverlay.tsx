import type { TrackGeometry } from "@/types/track";

/** Circuit title over the map. */
export function MapOverlay({ track }: { track: TrackGeometry }) {
  return (
    <>
    <div className="pointer-events-none absolute inset-x-0 top-0 h-44 bg-gradient-to-b from-bg/85 via-bg/45 to-transparent" aria-hidden="true" />
    <div className="pointer-events-none absolute left-4 top-3 max-w-[min(560px,80%)] lg:left-5 lg:top-4">
      <h1 className="race-title text-[clamp(28px,3.6vw,46px)]">{track.name}</h1>
      <p className="mt-1.5 text-[12.5px] text-muted">
        {track.country} · {track.zones.length} zones · coloured by serious incidents per race weekend
      </p>
    </div>
    </>
  );
}
