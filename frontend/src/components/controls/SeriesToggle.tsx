"use client";

import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { SERIES_OPTIONS } from "@/lib/labels";
import type { Series } from "@/types/api";

export function SeriesToggle({ value, onChange }: { value: Series; onChange: (s: Series) => void }) {
  return <SegmentedControl label="Series" tone="accent" value={value} onChange={onChange} options={SERIES_OPTIONS} className="display [&_button]:text-[15px] [&_button]:font-semibold [&_button]:tracking-[0.08em]" />;
}
