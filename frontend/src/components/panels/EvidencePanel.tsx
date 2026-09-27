import { Panel } from "@/components/ui/Panel";
import { formatFraction } from "@/lib/format";
import type { ExposureMap } from "@/types/exposure";

/** The backtest, year by year: predicted from earlier years only, then checked. */
export function EvidencePanel({ exposure }: { exposure: ExposureMap | undefined }) {
  if (!exposure) return null;
  const b = exposure.backtest;

  return (
    <Panel
      title="Proof it predicts"
      description={`Each year, we took the ${b.top_k} busiest corners from the years before only, then checked where that year's serious incidents actually happened.`}
    >
      <div className="grid gap-2">
        {b.years.map((y) => {
          const share = y.total ? y.hits / y.total : 0;
          return (
            <div key={y.season} className="grid grid-cols-[40px_1fr_62px] items-center gap-2.5 text-[11.5px]">
              <span className="num text-muted">{y.season}</span>
              <div className="relative h-3 overflow-hidden rounded bg-bg" title={`Predicted: ${y.predicted.join(", ")}`}>
                <div className="h-full rounded bg-accent transition-[width] duration-500" style={{ width: `${share * 100}%` }} />
                <div className="absolute inset-y-0 w-px bg-ink/70" style={{ left: `${b.chance_share * 100}%` }} aria-hidden="true" />
              </div>
              <span className="num text-right">
                {y.hits}/{y.total} · {formatFraction(share)}
              </span>
            </div>
          );
        })}
      </div>
      <p className="text-[11.5px] text-faint">
        White line = chance ({formatFraction(b.chance_share)}: incidents spread evenly over {exposure.zones.length} zones). Overall{" "}
        <b className="text-ink">{formatFraction(b.share)}</b>, {b.lift.toFixed(1)}× better than chance.
      </p>
    </Panel>
  );
}
