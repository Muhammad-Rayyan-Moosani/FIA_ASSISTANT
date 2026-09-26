import type { SimulationState } from "@/hooks/insurance/useSimulationStream";
import { formatEur, formatNumber } from "@/lib/format";

/** Live readout over the map while a simulation streams. */
export function SimulationHud({ sim, sampleSeasons }: { sim: SimulationState; sampleSeasons: number }) {
  if (sim.status === "idle" || sim.status === "failed") return null;
  const done = sim.status === "done";
  return (
    <div className="pointer-events-none absolute right-4 top-4 min-w-[220px] rounded-xl border border-line bg-panel/90 px-3.5 py-2.5 backdrop-blur max-sm:bottom-16 max-sm:top-auto" role="status" aria-live="polite">
      <div className="eyebrow">{done ? "Simulation complete" : "Simulated season"}</div>
      <div className="display text-[26px] font-semibold leading-tight">{done ? formatEur(sim.final?.ealEur ?? 0) : `${sim.seasonsShown} / ${sampleSeasons}`}</div>
      <div className="text-xs text-muted">
        {done
          ? `Expected loss over ${formatNumber(sim.final?.nSeasons ?? 0)} seasons`
          : `${sim.seasonCrashes} ${sim.seasonCrashes === 1 ? "crash" : "crashes"} · ${formatEur(sim.seasonLossEur)} this weekend`}
      </div>
    </div>
  );
}
