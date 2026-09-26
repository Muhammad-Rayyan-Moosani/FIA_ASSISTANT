"use client";

import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Skeleton } from "@/components/ui/Skeleton";
import type { CircuitSummary } from "@/types/track";

interface CircuitSelectProps {
  circuits: CircuitSummary[] | undefined;
  value: string | null;
  onChange: (id: string) => void;
}

export function CircuitSelect({ circuits, value, onChange }: CircuitSelectProps) {
  if (!circuits) return <Skeleton className="h-9 w-64" />;
  return (
    <SegmentedControl
      label="Circuit"
      value={value}
      onChange={onChange}
      options={circuits.map((c) => ({ value: c.id, label: c.short_name, title: `${c.name}, ${c.country}` }))}
    />
  );
}
