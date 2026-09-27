import { type CarState, carPhase, residualTone } from "@/lib/fiaFeed";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/cn";

const TONE_TEXT = { normal: "text-risk-low", reduced: "text-risk-med", cliff: "text-risk-crit" } as const;

/** Live telemetry readout per car: phase, speed, brake pressure and braking residual. */
export function CarStrip({ cars, threshold }: { cars: CarState[]; threshold: number }) {
  if (cars.length === 0) {
    return <p className="text-xs text-faint">Cars appear here once telemetry is streaming.</p>;
  }
  return (
    <div className="grid grid-cols-3 gap-2.5 max-sm:grid-cols-1" aria-live="off">
      {cars.map((car) => {
        const tone = residualTone(car.residual, threshold);
        return (
          <div key={car.id} className="rounded-lg border border-line bg-panel-2 px-3 py-2">
            <div className="flex items-baseline justify-between gap-2">
              <span className="num text-[15px] font-medium">#{car.id}</span>
              <span className="eyebrow">{carPhase(car)}</span>
            </div>
            <div className="num mt-1 text-[13px]">{formatNumber(car.speedKph)} km/h</div>
            <div className="mt-1.5 h-1 overflow-hidden rounded bg-bg" title={`Brake ${formatNumber(car.brake)}%`}>
              <div className="h-full bg-risk-crit transition-[width] duration-100" style={{ width: `${car.brake}%` }} />
            </div>
            <div className="num mt-1.5 text-[12px] text-muted">
              residual <span className={cn("font-medium", tone && TONE_TEXT[tone])}>{car.residual === null ? "–" : car.residual.toFixed(2)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
