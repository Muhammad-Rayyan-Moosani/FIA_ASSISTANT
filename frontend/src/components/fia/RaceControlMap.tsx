"use client";

import { useMemo } from "react";
import { type FiaFeedState, type ResidualTone, cellRect, residualTone } from "@/lib/fiaFeed";
import type { FiaScenario, HazardType } from "@/types/fia";

/** Window onto the demo scenario: Monza T1 braking zone and chicane, in track metres. */
const VIEW_FROM_X = 480;
const VIEW_TO_X = 730;
const PAD = 12;

const TONE_FILL: Record<ResidualTone, string> = {
  normal: "var(--color-risk-low)",
  reduced: "var(--color-risk-med)",
  cliff: "var(--color-risk-crit)",
};

const HAZARD_STROKE: Partial<Record<HazardType, string>> = {
  water_sheen: "var(--color-src-measured)",
  oil_streak: "var(--color-src-assumed)",
  debris: "var(--color-risk-high)",
};

interface RaceControlMapProps {
  scenario: FiaScenario;
  feed: FiaFeedState;
}

/** SVG y grows downward; track y grows "north", so every y is negated. */
export function RaceControlMap({ scenario, feed }: RaceControlMapProps) {
  const geo = useMemo(() => {
    const pts = scenario.centerline.filter(([x]) => x >= VIEW_FROM_X && x <= VIEW_TO_X);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => -p[1]);
    const minX = Math.min(...xs) - PAD;
    const w = Math.max(...xs) - minX + PAD;
    const midY = (Math.min(...ys) + Math.max(...ys)) / 2;
    const h = Math.max(Math.max(...ys) - Math.min(...ys) + 2 * PAD, w * 0.36);
    return {
      viewBox: `${minX} ${midY - h / 2} ${w} ${h}`,
      path: pts.map((p, i) => `${i ? "L" : "M"}${p[0]},${-p[1]}`).join(" "),
      camera: scenario.camera_quad_m.map(([x, y]) => `${x},${-y}`).join(" "),
    };
  }, [scenario]);

  const thr = scenario.residual_threshold;
  const width = scenario.track_half_width_m * 2;
  const [bx, by] = scenario.brake_point;
  const cam = scenario.camera_quad_m;

  return (
    <svg viewBox={geo.viewBox} className="block h-auto w-full rounded-lg bg-bg" role="img" aria-label="Turn 1 track map with live car positions and hazard cells">
      <path d={geo.path} stroke="var(--color-line)" strokeWidth={width + 1.2} fill="none" strokeLinejoin="round" />
      <path d={geo.path} stroke="var(--color-panel-2)" strokeWidth={width} fill="none" strokeLinejoin="round" />
      <path d={geo.path} stroke="var(--color-faint)" strokeWidth={0.3} strokeDasharray="3 3" fill="none" />

      {cam.length > 0 && (
        <g>
          <polygon points={geo.camera} fill="none" stroke="var(--color-muted)" strokeWidth={0.4} strokeDasharray="1.5 1.5" />
          <text x={cam[2]![0]} y={-cam[2]![1] + 9} fill="var(--color-muted)" fontSize={4.5} textAnchor="end">camera field of view</text>
        </g>
      )}
      <line x1={bx} x2={bx} y1={-by - 7} y2={-by + 7} stroke="var(--color-ink)" strokeWidth={0.6} />
      <text x={bx} y={-by - 8.5} fill="var(--color-ink)" fontSize={5} textAnchor="middle">brake</text>
      <text x={668} y={-by - 14} fill="var(--color-ink)" fontSize={6} fontWeight={700} textAnchor="middle">T1 Rettifilo</text>

      {Object.entries(feed.cells).map(([sector, level]) => {
        const r = cellRect(sector, scenario.segment_length_m);
        if (!r) return null;
        const colour = level === "ALERT" ? "var(--color-risk-crit)" : "var(--color-risk-med)";
        return (
          <g key={sector}>
            <rect x={r.x} y={-(r.y + r.size)} width={r.size} height={r.size} fill={colour} fillOpacity={0.2} stroke={colour} strokeWidth={0.5} />
            <text x={r.x + 1} y={-(r.y + r.size) + 5} fill={colour} fontSize={4.5} fontWeight={700}>{level}</text>
          </g>
        );
      })}

      {feed.cars.map((car) =>
        car.trail.map((p, i) => {
          const tone = residualTone(p.residual, thr);
          return <circle key={`${car.id}-${i}`} cx={p.x} cy={-p.y} r={tone === "cliff" ? 1.1 : 0.7} fill={tone ? TONE_FILL[tone] : "var(--color-faint)"} />;
        }),
      )}

      {feed.vision.map((d, i) => {
        const stroke = HAZARD_STROKE[d.hazard_type] ?? "var(--color-ink)";
        const p = d.map_coordinates;
        return (
          <g key={`v${i}`}>
            <circle cx={p.x} cy={-p.y} r={Math.max(1.5, Math.sqrt(d.area_m2 / Math.PI))} fill="none" stroke={stroke} strokeWidth={0.6} strokeDasharray="1 0.8" />
            <text x={p.x} y={-p.y + 8} fill={stroke} fontSize={4.2} textAnchor="middle">{d.hazard_type.replace("_", " ")}</text>
          </g>
        );
      })}

      {feed.crashes.map((c, i) => (
        <g key={`c${i}`} transform={`translate(${c.x},${-c.y})`}>
          <path d="M-3,-3L3,3M-3,3L3,-3" stroke="var(--color-risk-crit)" strokeWidth={1.4} />
          <text y={7.5} fill="var(--color-risk-crit)" fontSize={4.5} fontWeight={700} textAnchor="middle">CRASH</text>
        </g>
      ))}

      {feed.cars.map((car) => (
        <g key={car.id} transform={`translate(${car.x},${-car.y})`}>
          <circle r={2.6} fill="var(--color-ink)" stroke="var(--color-bg)" strokeWidth={0.4} />
          <text y={-4} fill="var(--color-ink)" fontSize={5} fontWeight={700} textAnchor="middle">{car.id}</text>
        </g>
      ))}
    </svg>
  );
}

export function MapLegend() {
  const item = (swatch: string, label: string) => (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-block size-2.5 rounded-sm" style={{ background: swatch }} aria-hidden="true" />
      {label}
    </span>
  );
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      {item(TONE_FILL.normal, "residual ≥ 0.9")}
      {item(TONE_FILL.reduced, "0.75–0.9")}
      {item(TONE_FILL.cliff, "< 0.75 grip cliff")}
      {item("color-mix(in srgb, var(--color-risk-med) 35%, transparent)", "WATCH cell (25 m)")}
      {item("color-mix(in srgb, var(--color-risk-crit) 35%, transparent)", "ALERT cell")}
      {item("var(--color-src-assumed)", "camera: oil")}
      {item("var(--color-src-measured)", "camera: water")}
    </div>
  );
}
