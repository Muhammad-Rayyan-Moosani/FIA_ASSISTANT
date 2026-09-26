"use client";

import { IconReport } from "@/assets/icons";
import { CircuitSelect } from "@/components/controls/CircuitSelect";
import { SeriesToggle } from "@/components/controls/SeriesToggle";
import { ViewToggle } from "@/components/controls/ViewToggle";
import { Button } from "@/components/ui/Button";
import type { MapView } from "@/store/uiStore";
import type { Series } from "@/types/api";
import type { CircuitSummary } from "@/types/track";

interface AppHeaderProps {
  circuits: CircuitSummary[] | undefined;
  circuitId: string | null;
  onCircuit: (id: string) => void;
  series: Series;
  onSeries: (s: Series) => void;
  view: MapView;
  onView: (v: MapView) => void;
  webgl: boolean | null;
  onOpenReport: () => void;
  reportDisabled: boolean;
}

export function AppHeader(p: AppHeaderProps) {
  return (
    <header className="flex flex-wrap items-center gap-x-5 gap-y-3 border-b border-line bg-panel px-4 py-3 lg:px-5">
      <div className="mr-auto flex min-w-0 flex-col max-lg:w-full">
        <span className="display text-[22px] font-bold uppercase leading-none tracking-[0.06em]">Circuit Risk Twin</span>
        <span className="text-xs text-muted">FIA Assistant · zone-based motorsport insurance</span>
      </div>
      <nav className="flex flex-wrap items-center gap-2.5" aria-label="Scenario">
        <CircuitSelect circuits={p.circuits} value={p.circuitId} onChange={p.onCircuit} />
        <SeriesToggle value={p.series} onChange={p.onSeries} />
        <ViewToggle value={p.view} onChange={p.onView} webgl={p.webgl} />
        <Button variant="primary" onClick={p.onOpenReport} disabled={p.reportDisabled}>
          <IconReport />
          Underwriter report
        </Button>
      </nav>
    </header>
  );
}
