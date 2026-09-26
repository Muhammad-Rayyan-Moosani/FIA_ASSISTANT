"use client";

import { PROVENANCE_LABEL } from "@/lib/labels";
import { cn } from "@/lib/cn";
import type { Provenance, SourceInfo } from "@/types/api";
import { Popover } from "./Popover";

const TONE: Record<Provenance, { text: string; color: string }> = {
  measured: { text: "text-src-measured border-src-measured/45 bg-src-measured/10", color: "var(--color-src-measured)" },
  assumed: { text: "text-src-assumed border-src-assumed/45 bg-src-assumed/10", color: "var(--color-src-assumed)" },
  modelled: { text: "text-src-modelled border-src-modelled/40 bg-src-modelled/10", color: "var(--color-src-modelled)" },
};

export function ProvenancePill({ provenance, className }: { provenance: Provenance; className?: string }) {
  return (
    <span className={cn("inline-block rounded border px-1.5 py-[3px] text-[9.5px] font-semibold uppercase leading-none tracking-[0.08em]", TONE[provenance].text, className)}>
      {PROVENANCE_LABEL[provenance]}
    </span>
  );
}

interface SourceBadgeProps {
  source: SourceInfo | undefined;
  /** Show as a labelled chip (e.g. "Track shape · Real") instead of a small tag. */
  label?: string;
  className?: string;
}

/** Tag that says where a value comes from; opens the backend's explanation. Renders nothing without a source. */
export function SourceBadge({ source, label, className }: SourceBadgeProps) {
  if (!source) return null;
  const tone = TONE[source.provenance];
  return (
    <Popover
      accent={tone.color}
      title={
        <div className="flex items-center gap-2">
          <ProvenancePill provenance={source.provenance} />
          <span className="display text-lg font-semibold leading-tight">{source.title}</span>
        </div>
      }
      trigger={(props) => (
        <button
          type="button"
          {...props}
          aria-label={`Where this comes from: ${source.title} (${PROVENANCE_LABEL[source.provenance]})`}
          className={cn(
            "cursor-pointer border font-semibold leading-none transition-[filter] hover:brightness-125",
            label
              ? "rounded-full bg-bg/70 px-2.5 py-1 text-[11px] backdrop-blur"
              : "ml-1.5 rounded px-1.5 py-[3px] align-[1px] text-[9.5px] uppercase tracking-[0.08em]",
            tone.text,
            className,
          )}
        >
          {label ? `${label} · ${PROVENANCE_LABEL[source.provenance]}` : PROVENANCE_LABEL[source.provenance]}
        </button>
      )}
    >
      <div className="space-y-2 text-[13px] leading-relaxed text-ink">
        {source.detail.split(/\n\s*\n/).map((para, i) => (
          <p key={i}>{para}</p>
        ))}
      </div>
    </Popover>
  );
}
