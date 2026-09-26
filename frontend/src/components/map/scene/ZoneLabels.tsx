"use client";

import { useFrame } from "@react-three/fiber";
import { useMemo, type RefObject } from "react";
import { Vector3 } from "three";
import { formatEur } from "@/lib/format";
import type { SceneData } from "./sceneTypes";

const TOP_N = 3;

export type LabelNodes = RefObject<Map<string, HTMLDivElement>>;

interface LabelAnchor {
  zoneId: string;
  position: Vector3;
}

/** World-space anchor above each zone's barrier. */
export function useLabelAnchors(scene: SceneData): LabelAnchor[] {
  return useMemo(
    () =>
      scene.zones
        .filter((z) => z.view.risk)
        .map(({ view, mid, side, barrierOffset }) => {
          const p = scene.frame.points[mid]!;
          const q = scene.frame.normals[mid]!;
          const height = scene.scale.h(view.zone.fence_height_m + 6);
          return { zoneId: view.zone.zone_id, position: new Vector3(p.x + q.x * side * barrierOffset, height, p.z + q.z * side * barrierOffset) };
        }),
    [scene],
  );
}

const projected = new Vector3();

/** Inside the Canvas: projects each anchor to screen space and moves its DOM label, every frame. */
export function ZoneLabelProjector({ anchors, nodes }: { anchors: LabelAnchor[]; nodes: LabelNodes }) {
  useFrame(({ camera, size }) => {
    for (const a of anchors) {
      const el = nodes.current.get(a.zoneId);
      if (!el) continue;
      projected.copy(a.position).project(camera);
      const behind = projected.z > 1;
      el.style.visibility = behind ? "hidden" : "";
      if (!behind) el.style.transform = `translate(${((projected.x + 1) / 2) * size.width}px, ${((1 - projected.y) / 2) * size.height}px) translate(-50%, -100%)`;
    }
  });
  return null;
}

/** Outside the Canvas: the label elements. The most expensive zones, plus selected and hovered, are shown. */
export function ZoneLabelLayer({ scene, nodes, selectedZoneId, hoveredZoneId }: { scene: SceneData; nodes: LabelNodes; selectedZoneId: string | null; hoveredZoneId: string | null }) {
  const top = new Set(
    scene.zones
      .filter((z) => z.view.risk)
      .sort((a, b) => b.view.risk!.premium_eur - a.view.risk!.premium_eur)
      .slice(0, TOP_N)
      .map((z) => z.view.zone.zone_id),
  );

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      {scene.zones.map(({ view }) => {
        if (!view.risk) return null;
        const id = view.zone.zone_id;
        const visible = top.has(id) || id === selectedZoneId || id === hoveredZoneId;
        return (
          <div
            key={id}
            ref={(el) => {
              if (el) nodes.current.set(id, el);
              else nodes.current.delete(id);
            }}
            style={{ transform: "translate(-9999px, -9999px)" }}
            className={`absolute left-0 top-0 whitespace-nowrap rounded-md border bg-bg/85 px-2 py-1 text-[11.5px] leading-tight backdrop-blur transition-opacity duration-150 ${id === selectedZoneId ? "border-accent" : "border-line"} ${visible ? "opacity-100" : "opacity-0"}`}
          >
            <b className="display block text-[13px] font-semibold tracking-wide">{view.zone.short_name}</b>
            <span className="num text-[11px] text-muted">
              {formatEur(view.risk.premium_eur)} · {view.risk.risk_tier.toLowerCase()}
            </span>
          </div>
        );
      })}
    </div>
  );
}
