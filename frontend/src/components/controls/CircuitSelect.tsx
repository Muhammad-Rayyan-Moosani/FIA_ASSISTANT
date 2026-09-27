"use client";

import Link from "next/link";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Skeleton } from "@/components/ui/Skeleton";
import type { CircuitSummary } from "@/types/track";

interface CircuitSelectProps {
  circuits: CircuitSummary[] | undefined;
  value: string | null;
  onChange: (id: string) => void;
}

export function CircuitSelect({ circuits, value, onChange }: CircuitSelectProps) {
  return (
    <div className="flex items-center gap-1.5">
      {circuits ? (
        <SegmentedControl
          label="Circuit"
          value={value}
          onChange={onChange}
          options={circuits.map((c) => ({ value: c.id, label: c.short_name, title: `${c.name}, ${c.country}` }))}
        />
      ) : (
        <Skeleton className="h-9 w-64" />
      )}
      {/* add a track: back to the upload page */}
      <Link
        href="/"
        aria-label="Add a circuit"
        title="Add a circuit: upload its track and incident log"
        className="grid size-9 place-items-center rounded-lg border border-line bg-bg text-muted transition-colors hover:border-accent hover:bg-accent hover:text-accent-ink"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </Link>
    </div>
  );
}
