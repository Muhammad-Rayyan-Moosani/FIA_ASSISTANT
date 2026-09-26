import { cn } from "@/lib/cn";
import { formatEur } from "@/lib/format";

/** Horizontal bar showing a credible interval with a mean tick, on a 0..max scale. */
export function RangeBar({ lo, hi, mean, max, color }: { lo: number; hi: number; mean: number; max: number; color: string }) {
  const pct = (v: number) => `${Math.min(100, Math.max(0, (v / (max || 1)) * 100))}%`;
  return (
    <div className="relative mt-1.5 h-2 rounded bg-bg" role="img" aria-label={`Range ${lo.toFixed(2)} to ${hi.toFixed(2)}, best estimate ${mean.toFixed(2)}`}>
      <div className="absolute inset-y-0 rounded opacity-60" style={{ left: pct(lo), width: `calc(${pct(hi)} - ${pct(lo)})`, background: color }} />
      <div className="absolute -top-[3px] h-3.5 w-0.5 rounded-sm bg-ink" style={{ left: pct(mean) }} />
    </div>
  );
}

export function ProgressBar({ value, max, className, color = "var(--color-accent)" }: { value: number; max: number; className?: string; color?: string }) {
  const p = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className={cn("h-1.5 overflow-hidden rounded-full bg-bg", className)} role="progressbar" aria-valuenow={Math.round(p)} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${p}%`, background: color }} />
    </div>
  );
}

/** Running-EAL convergence line with the model's final EAL as a dashed reference. */
export function ConvergenceChart({ points, reference, capacity }: { points: number[]; reference: number | null; capacity: number }) {
  const W = 320;
  const H = 72;
  const values = reference !== null ? [...points, reference] : points;
  if (values.length === 0) {
    return <div className="grid h-[72px] place-items-center rounded-lg border border-dashed border-line text-xs text-faint">Run a simulation to see the running expected loss settle.</div>;
  }
  const lo = Math.min(...values) * 0.9;
  const hi = Math.max(...values) * 1.1 || 1;
  const x = (i: number) => 4 + (i / Math.max(1, capacity - 1)) * (W - 8);
  const y = (v: number) => H - 6 - ((v - lo) / (hi - lo || 1)) * (H - 16);
  const line = points.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const last = points.length - 1;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-[72px] w-full" role="img" aria-label="Running expected loss over simulated seasons">
      <defs>
        <linearGradient id="conv-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="var(--color-accent)" stopOpacity="0.28" />
          <stop offset="1" stopColor="var(--color-accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {reference !== null && (
        <>
          <line x1="0" x2={W} y1={y(reference)} y2={y(reference)} stroke="var(--color-line)" strokeDasharray="3 3" />
          <text x="4" y={Math.max(10, y(reference) - 4)} fill="var(--color-faint)" fontSize="10" fontFamily="var(--font-mono)">
            model EAL {formatEur(reference)}
          </text>
        </>
      )}
      {points.length > 0 && (
        <>
          <path d={`${line}L${x(last)},${H}L${x(0)},${H}Z`} fill="url(#conv-fill)" />
          <path d={line} fill="none" stroke="var(--color-accent)" strokeWidth="1.6" />
          <circle cx={x(last)} cy={y(points[last]!)} r="3" fill="var(--color-accent)" />
        </>
      )}
    </svg>
  );
}

export function DeltaChip({ delta, format, lowerIsBetter = true }: { delta: number; format: (v: number) => string; lowerIsBetter?: boolean }) {
  const flat = Math.abs(delta) < 1e-6;
  const good = !flat && (delta < 0) === lowerIsBetter;
  return (
    <span
      className={cn(
        "num rounded-md px-1.5 py-[3px] text-xs leading-none",
        flat && "bg-panel-2 text-muted",
        !flat && good && "bg-risk-low/12 text-risk-low",
        !flat && !good && "bg-risk-crit/12 text-risk-crit",
      )}
    >
      {flat ? "no change" : `${delta > 0 ? "+" : "−"}${format(Math.abs(delta))}`}
    </span>
  );
}
