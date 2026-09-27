import { Panel } from "@/components/ui/Panel";
import { PanelSkeleton } from "@/components/ui/Skeleton";
import { formatFraction } from "@/lib/format";
import type { ExposureMap } from "@/types/exposure";

/** The three facts a liability insurer needs: how often people are exposed, where, and that it repeats. */
export function ExposureSummary({ exposure }: { exposure: ExposureMap | undefined }) {
  if (!exposure) return <PanelSkeleton rows={4} />;
  const e = exposure;
  const b = e.backtest;
  const years = `${e.seasons[0]}–${e.seasons[e.seasons.length - 1]}`;

  return (
    <Panel title="What the insurer sees">
      <Fact
        n="1"
        value={`~${Math.round(e.marshals_out_per_weekend)}×`}
        unit="per race weekend"
        title="Marshals go onto a live track"
        detail={`A car stops on track and marshals go out to clear it (${e.marshals_out_total} times in ${e.weekends} weekends).`}
      />

      <Fact
        n="2"
        value={formatFraction(e.near_crowd_share)}
        unit="next to a grandstand"
        title="Incidents happen where the crowd is"
        detail={`${e.near_crowd_total} of ${e.serious_total} serious incidents, in zones that cover only ${formatFraction(e.crowd_lap_share)} of the lap.`}
      >
        <div className="mt-2 grid gap-1" aria-hidden="true">
          <Bar label="Incidents" share={e.near_crowd_share} color="var(--color-risk-high)" />
          <Bar label="Lap" share={e.crowd_lap_share} color="var(--color-faint)" />
        </div>
      </Fact>

      <Fact
        n="3"
        value={`${b.lift.toFixed(1)}×`}
        unit="better than chance"
        title="It happens at the same corners every year"
        detail={`The ${b.top_k} busiest corners from earlier years caught ${formatFraction(b.share)} of the next year's serious incidents (chance: ${formatFraction(b.chance_share)}).`}
      />

      <p className="text-[11.5px] text-faint">
        Counted from {e.sessions} sessions over {e.weekends} race weekends ({years}), official race-control data.
      </p>
    </Panel>
  );
}

function Fact(p: { n: string; value: string; unit: string; title: string; detail: string; children?: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[22px_1fr] gap-x-2.5 rounded-lg border border-line bg-bg/60 px-3 py-2.5">
      <span className="display mt-0.5 grid h-[22px] w-[22px] place-items-center rounded-full bg-accent/15 text-[13px] font-semibold text-accent">{p.n}</span>
      <div className="min-w-0">
        <div className="text-[12.5px] font-medium">
          {p.title}
        </div>
        <div className="mt-1 flex items-baseline gap-2">
          <span className="display text-[30px] font-semibold leading-none text-ink">{p.value}</span>
          <span className="text-xs text-muted">{p.unit}</span>
        </div>
        <p className="mt-1 text-[11.5px] leading-snug text-muted">{p.detail}</p>
        {p.children}
      </div>
    </div>
  );
}

function Bar({ label, share, color }: { label: string; share: number; color: string }) {
  return (
    <div className="grid grid-cols-[62px_1fr_34px] items-center gap-2 text-[11px] text-muted">
      <span>{label}</span>
      <div className="h-2 overflow-hidden rounded bg-bg">
        <div className="h-full rounded transition-[width] duration-500" style={{ width: `${Math.min(100, share * 100)}%`, background: color }} />
      </div>
      <span className="num text-right">{formatFraction(share)}</span>
    </div>
  );
}
