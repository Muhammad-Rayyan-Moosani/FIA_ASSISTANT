"use client";

import { useFrame } from "@react-three/fiber";
import type { RefObject } from "react";
import { Vector3 } from "three";
import { cn } from "@/lib/cn";
import { replayPositions } from "@/store/replayBus";
import type { SceneScale } from "./sceneTypes";
import { carPoint } from "./storyAnchors";

export type CalloutTone = "car" | "crash" | "rc" | "warn" | "mast";

export interface CalloutSpec {
  id: string;
  tone: CalloutTone;
  title: string;
  lines: string[];
  /** A replay car (follows it) with a fixed fallback point, or a fixed point. */
  anchor: { car: string | null; point: Vector3 | null };
  /** Card position relative to the arrow tip, in pixels. */
  offset: [number, number];
  /** Show this car's live speed in the card. */
  liveSpeed?: string;
}

export type CalloutNodes = RefObject<Map<string, HTMLDivElement>>;

const TONE: Record<CalloutTone, { border: string; stroke: string; title: string }> = {
  car: { border: "border-white/40", stroke: "#ffffff", title: "text-white" },
  crash: { border: "border-[#ff3b3b]", stroke: "#ff3b3b", title: "text-[#ff6b6b]" },
  rc: { border: "border-[#ffb000]", stroke: "#ffb000", title: "text-[#ffc233]" },
  warn: { border: "border-[#ffd21f]", stroke: "#ffd21f", title: "text-[#ffe066]" },
  mast: { border: "border-[#ffd21f]", stroke: "#ffd21f", title: "text-[#ffe066]" },
};

const projected = new Vector3();
const world = new Vector3();

/** Inside the Canvas: pins every callout's arrow tip to its object, every frame (cars move). */
export function StoryCalloutProjector({ specs, nodes, scale }: { specs: CalloutSpec[]; nodes: CalloutNodes; scale: SceneScale }) {
  useFrame(({ camera, size }) => {
    for (const s of specs) {
      const el = nodes.current.get(s.id);
      if (!el) continue;
      const p = carPoint(s.anchor.car, s.anchor.point, scale, world);
      if (!p) {
        el.style.visibility = "hidden";
        continue;
      }
      projected.copy(p).project(camera);
      // hide while the object is behind the camera or off screen, rather than pointing at the edge
      const hidden = projected.z > 1 || Math.abs(projected.x) > 1.02 || Math.abs(projected.y) > 1.02;
      el.style.visibility = hidden ? "hidden" : "";
      if (!hidden) el.style.transform = `translate(${((projected.x + 1) / 2) * size.width}px, ${((1 - projected.y) / 2) * size.height}px)`;
      if (s.liveSpeed) {
        const span = el.querySelector<HTMLElement>("[data-live]");
        const pose = replayPositions.get(s.liveSpeed);
        if (span && pose) span.textContent = `${Math.round(pose.speed)} km/h`;
      }
    }
  });
  return null;
}

/** Outside the Canvas: arrow + text box for each callout; the arrow tip sits on the object. */
export function StoryCalloutLayer({ specs, nodes }: { specs: CalloutSpec[]; nodes: CalloutNodes }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden" aria-live="polite">
      {specs.map((s) => {
        const tone = TONE[s.tone];
        const [dx, dy] = s.offset;
        const w = Math.abs(dx) + 12;
        const h = Math.abs(dy) + 12;
        // the line runs from the tip (0, 0) to the card's nearest corner
        const x1 = dx < 0 ? w - 6 : 6;
        const y1 = dy < 0 ? h - 6 : 6;
        const x2 = dx < 0 ? 6 : w - 6;
        const y2 = dy < 0 ? 6 : h - 6;
        return (
          <div
            key={s.id}
            ref={(el) => {
              if (el) nodes.current.set(s.id, el);
              else nodes.current.delete(s.id);
            }}
            style={{ transform: "translate(-9999px, -9999px)" }}
            className="absolute left-0 top-0 animate-fade-in"
          >
            <svg width={w} height={h} className="absolute overflow-visible" style={{ left: dx < 0 ? -w + 6 : -6, top: dy < 0 ? -h + 6 : -6 }} aria-hidden="true">
              <defs>
                <marker id={`tip-${s.id}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z" fill={tone.stroke} />
                </marker>
              </defs>
              <line x1={x2} y1={y2} x2={x1} y2={y1} stroke={tone.stroke} strokeWidth={2} markerEnd={`url(#tip-${s.id})`} />
              <circle cx={x1} cy={y1} r={4} fill="none" stroke={tone.stroke} strokeWidth={2}>
                <animate attributeName="r" values="4;11;4" dur="1.4s" repeatCount="indefinite" />
                <animate attributeName="opacity" values="1;0;1" dur="1.4s" repeatCount="indefinite" />
              </circle>
            </svg>
            <div
              className={cn("absolute w-[210px] rounded-lg border-l-4 border bg-[#07090d]/90 px-2.5 py-2 text-white shadow-lg backdrop-blur", tone.border)}
              style={{ left: dx < 0 ? dx - 210 + 6 : dx - 6, top: dy < 0 ? dy - 6 : dy - 6, transform: dy < 0 ? "translateY(-100%)" : undefined }}
            >
              <div className={cn("display text-[14px] font-bold uppercase leading-tight tracking-[0.04em]", tone.title)}>{s.title}</div>
              {s.lines.map((l) => (
                <div key={l} className="mt-0.5 text-[11.5px] leading-snug text-white/85">{l}</div>
              ))}
              {s.liveSpeed && <div className="num mt-0.5 text-[12px] font-semibold text-white" data-live />}
            </div>
          </div>
        );
      })}
    </div>
  );
}
