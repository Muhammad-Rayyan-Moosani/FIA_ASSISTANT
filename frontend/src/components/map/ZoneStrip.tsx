"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";
import { formatEur } from "@/lib/format";
import { ZONE_TYPE_LABEL } from "@/lib/labels";
import { riskHex } from "@/lib/riskColor";
import type { ZoneView } from "@/lib/zoneView";
import { NEUTRAL_ZONE } from "./scene/sceneTypes";

interface ZoneStripProps {
  zones: ZoneView[];
  selectedZoneId: string | null;
  onSelect: (zoneId: string) => void;
}

/** Every zone in lap order with its risk colour and premium; doubles as the legend and a keyboard-friendly selector. */
export function ZoneStrip({ zones, selectedZoneId, onSelect }: ZoneStripProps) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-zone="${CSS.escape(selectedZoneId ?? "")}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedZoneId]);

  return (
    <nav aria-label="Zones in lap order" className="border-t border-line bg-panel">
      <div ref={listRef} className="flex gap-2 overflow-x-auto px-4 py-2.5 scrollbar-thin">
        {zones.map(({ zone, risk }) => {
          const selected = zone.zone_id === selectedZoneId;
          return (
            <button
              key={zone.zone_id}
              type="button"
              data-zone={zone.zone_id}
              aria-pressed={selected}
              onClick={() => onSelect(zone.zone_id)}
              className={cn(
                "grid flex-[0_0_136px] gap-0.5 overflow-hidden rounded-lg border px-2.5 pb-2 text-left transition-colors",
                selected ? "border-accent bg-panel-2" : "border-line bg-bg hover:border-faint",
              )}
            >
              <i className="-mx-2.5 mb-1.5 block h-1" style={{ background: risk ? riskHex(risk.risk_score) : NEUTRAL_ZONE }} />
              <b className="display truncate text-[15px] font-semibold leading-tight tracking-[0.03em]">{zone.short_name}</b>
              <span className="flex justify-between gap-1.5 text-[11px] text-muted">
                <span className="truncate">{zone.turn_number ? `T${zone.turn_number}` : ZONE_TYPE_LABEL[zone.zone_type]}</span>
                <span className="num">{risk ? formatEur(risk.premium_eur) : "…"}</span>
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
