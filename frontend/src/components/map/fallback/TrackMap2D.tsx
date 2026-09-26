"use client";

import { useEffect, useMemo, useRef } from "react";
import { riskHex } from "@/lib/riskColor";
import { zoneIndexRange } from "@/lib/trackGeometry";
import type { ZoneView } from "@/lib/zoneView";
import { mapEffects } from "@/store/crashBus";
import { NEUTRAL_ZONE } from "../scene/sceneTypes";

interface TrackMap2DProps {
  outline: [number, number][];
  zones: ZoneView[];
  selectedZoneId: string | null;
  onSelectZone: (zoneId: string) => void;
  reducedMotion: boolean;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const toPath = (pts: [number, number][]) => pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(4)} ${(-y).toFixed(4)}`).join("");

/** Flat SVG map with the same props as the 3D scene. Used without WebGL or on request. */
export function TrackMap2D({ outline, zones, selectedZoneId, onSelectZone, reducedMotion }: TrackMap2DProps) {
  const effectsRef = useRef<SVGGElement>(null);
  const trackPath = useMemo(() => `${toPath(outline)}Z`, [outline]);
  const maxPremium = Math.max(0, ...zones.map((z) => z.risk?.premium_eur ?? 0));

  useEffect(
    () =>
      mapEffects.subscribe((effect) => {
        const g = effectsRef.current;
        if (!g) return;
        const x = effect.kind === "crash" ? effect.crash.x : effect.incident.x;
        const y = effect.kind === "crash" ? effect.crash.y : effect.incident.y;
        const severe = effect.kind === "crash" && effect.crash.severe;
        const dot = document.createElementNS(SVG_NS, "circle");
        dot.setAttribute("cx", String(x));
        dot.setAttribute("cy", String(-y));
        dot.setAttribute("r", "0.006");
        dot.setAttribute("fill", effect.kind === "incident" ? "#4fd1c5" : severe ? "#e5484d" : "#ffffff");
        g.appendChild(dot);
        const anim = dot.animate([{ r: "0.006", opacity: 1 }, { r: severe ? "0.05" : "0.03", opacity: 0 }], {
          duration: reducedMotion ? 1 : effect.kind === "incident" ? 2400 : 1200,
        });
        anim.onfinish = () => dot.remove();
      }),
    [reducedMotion],
  );

  return (
    <svg viewBox="-0.56 -0.56 1.12 1.12" preserveAspectRatio="xMidYMid meet" className="absolute inset-0 h-full w-full" role="img" aria-label="Map of the circuit coloured by insurance risk">
      <path d={trackPath} fill="none" stroke="#1d2731" strokeWidth={0.034} strokeLinejoin="round" />
      <path d={trackPath} fill="none" stroke="#3a4a5a" strokeWidth={0.002} />
      {zones.map(({ zone, risk }) => {
        const [a, b] = zoneIndexRange(zone.start_frac, zone.end_frac, outline.length);
        const seg = outline.slice(a, b + 1);
        const mid = outline[Math.floor((a + b) / 2)]!;
        const color = risk ? riskHex(risk.risk_score) : NEUTRAL_ZONE;
        const selected = zone.zone_id === selectedZoneId;
        const r = risk && maxPremium > 0 ? 0.008 + 0.028 * Math.sqrt(risk.premium_eur / maxPremium) : 0.006;
        return (
          <g
            key={zone.zone_id}
            role="button"
            tabIndex={0}
            aria-label={`${zone.name}${risk ? `, risk ${risk.risk_score}` : ""}`}
            aria-pressed={selected}
            className="cursor-pointer outline-none"
            onClick={() => onSelectZone(zone.zone_id)}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelectZone(zone.zone_id)}
          >
            <path d={toPath(seg)} fill="none" stroke={color} strokeOpacity={selected ? 1 : 0.8} strokeWidth={selected ? 0.03 : 0.022} strokeLinecap="round" />
            <path d={toPath(seg)} fill="none" stroke="transparent" strokeWidth={0.06} />
            <circle cx={mid[0]} cy={-mid[1]} r={r} fill={color} fillOpacity={0.22} stroke={color} strokeWidth={0.002} />
            <text x={mid[0]} y={-mid[1] - 0.04} fontSize={0.024} textAnchor="middle" fill={selected ? "#e3e9ef" : "#8b9bab"} fontFamily="var(--font-display)" fontWeight={600}>
              {zone.short_name}
            </text>
          </g>
        );
      })}
      <g ref={effectsRef} />
    </svg>
  );
}
