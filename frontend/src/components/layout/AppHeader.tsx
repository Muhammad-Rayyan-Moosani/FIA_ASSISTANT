"use client";

import { CircuitSelect } from "@/components/controls/CircuitSelect";
import { ViewToggle } from "@/components/controls/ViewToggle";
import { PageTabs } from "@/components/layout/PageTabs";
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
}

export function AppHeader(p: AppHeaderProps) {
  return (
    <header className="flex flex-wrap items-center gap-x-5 gap-y-3 border-b border-line bg-panel px-4 py-3 lg:px-5">
      <PageTabs active="insurance" />
      <div className="mr-auto flex min-w-0 flex-col max-lg:w-full">
        <span className="display text-[22px] font-bold uppercase leading-none tracking-[0.06em]">Circuit Risk Twin</span>
        <span className="text-xs text-muted">Third-party risk evidence for circuit owners and their insurers</span>
      </div>
      <nav className="flex flex-wrap items-center gap-2.5" aria-label="View">
        <CircuitSelect circuits={p.circuits} value={p.circuitId} onChange={p.onCircuit} />
        <ViewToggle value={p.view} onChange={p.onView} webgl={p.webgl} />
        <Button variant="primary" onClick={p.onOpenPlan} disabled={p.planDisabled}>
          Safety plan
        </Button>
      </nav>
    </header>
  );
}
