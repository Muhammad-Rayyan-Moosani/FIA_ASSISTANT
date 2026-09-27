"use client";

import { Brand } from "@/components/layout/Brand";
import { CircuitSelect } from "@/components/controls/CircuitSelect";
import { ViewToggle } from "@/components/controls/ViewToggle";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { Button } from "@/components/ui/Button";
import type { MapView } from "@/store/uiStore";
import type { CircuitSummary } from "@/types/track";

interface AppHeaderProps {
  circuits: CircuitSummary[] | undefined;
  circuitId: string | null;
  onCircuit: (id: string) => void;
  view: MapView;
  onView: (v: MapView) => void;
  webgl: boolean | null;
  onOpenPlan: () => void;
  planDisabled: boolean;
  /** Only on the Insurance tab. */
  showPlan: boolean;
}

export function AppHeader(p: AppHeaderProps) {
  return (
    <header className="speed-stripe carbon flex flex-wrap items-center gap-x-5 gap-y-3 border-b border-line bg-panel px-4 py-3 lg:px-5">
      <ThemeToggle />
      <div className="mr-auto flex min-w-0 items-center max-lg:w-full">
        <Brand />
      </div>
      <nav className="flex flex-wrap items-center gap-2.5" aria-label="View">
        <CircuitSelect circuits={p.circuits} value={p.circuitId} onChange={p.onCircuit} />
        <ViewToggle value={p.view} onChange={p.onView} webgl={p.webgl} />
        {p.showPlan && (
          <Button variant="primary" onClick={p.onOpenPlan} disabled={p.planDisabled}>
            Safety plan
          </Button>
        )}
      </nav>
    </header>
  );
}
