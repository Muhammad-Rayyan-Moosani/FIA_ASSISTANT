"use client";

import { useEffect, useMemo } from "react";
import { BufferAttribute, BufferGeometry, DoubleSide } from "three";
import { polylineRibbon, stripedStrip, stripMesh, toWorld, type MeshData } from "@/lib/trackGeometry";
import type { AssetContext } from "@/types/assets";
import { TRACK_DRAW_SCALE, type SceneData } from "./sceneTypes";
import { useMeshGeometry } from "./useMeshGeometry";

// Kerbs and lines scale with the track, which is drawn TRACK_DRAW_SCALE× its real width.
const KERB_WIDTH_M = 1.5 * TRACK_DRAW_SCALE;
const KERB_STRIPE_M = 3 * TRACK_DRAW_SCALE;
const LINE_WIDTH_M = 0.8 * TRACK_DRAW_SCALE;
const PIT_LANE_WIDTH_M = 12;
const OLD_RACEWAY_WIDTH_M = 12;
const KERB_COLORS = [[0.78, 0.1, 0.12], [0.94, 0.94, 0.94]] as const;

function Ribbon({ data, color, roughness = 0.9 }: { data: MeshData; color: string; roughness?: number }) {
  const g = useMeshGeometry(data);
  return (
    <mesh geometry={g} receiveShadow raycast={() => null}>
      <meshStandardMaterial color={color} roughness={roughness} side={DoubleSide} />
    </mesh>
  );
}

function Kerbs({ scene }: { scene: SceneData }) {
  const { frame, scale, zones } = scene;
  const geometry = useMemo(() => {
    const parts: { positions: Float32Array; indices: number[]; colors: Float32Array }[] = [];
    const n = frame.points.length;
    const off = scale.trackHalf;
    const w = KERB_WIDTH_M * scale.u;
    const stripe = KERB_STRIPE_M * scale.u;
    for (const z of zones) {
      if (z.view.zone.zone_type === "straight") continue;
      const inside = (-z.side) as 1 | -1;
      const a = Math.max(0, z.apex - 2);
      const b = Math.min(n - 1, z.apex + 2);
      parts.push(stripedStrip(frame, a, b, inside, off, off + w, 0.035, stripe, KERB_COLORS));
      const ea = Math.min(n - 2, z.apex + 1);
      const eb = Math.min(n - 1, z.apex + 5);
      parts.push(stripedStrip(frame, ea, eb, z.side, off, off + w, 0.035, stripe, KERB_COLORS));
    }
    const g = new BufferGeometry();
    const pos = new Float32Array(parts.reduce((s, p) => s + p.positions.length, 0));
    const col = new Float32Array(pos.length);
    const idx: number[] = [];
    let o = 0;
    for (const p of parts) {
      pos.set(p.positions, o);
      col.set(p.colors, o);
      const base = o / 3;
      p.indices.forEach((i) => idx.push(base + i));
      o += p.positions.length;
    }
    g.setAttribute("position", new BufferAttribute(pos, 3));
    g.setAttribute("color", new BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }, [frame, scale, zones]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh geometry={geometry} receiveShadow raycast={() => null}>
      <meshStandardMaterial vertexColors roughness={0.7} side={DoubleSide} />
    </mesh>
  );
}

/** Asphalt (drawn 3× its real width), white edge lines, start/finish line, kerbs at each real apex, pit lane and old raceways. */
export function TrackSurface({ scene, context }: { scene: SceneData; context: AssetContext | undefined }) {
  const { frame, scale } = scene;
  const n = frame.points.length;
  const half = scale.trackHalf;
  const line = LINE_WIDTH_M * scale.u;
  const asphalt = useMemo(() => stripMesh(frame, 0, n - 1, half, -half, 0.02, true), [frame, n, half]);
  const edgeL = useMemo(() => stripMesh(frame, 0, n - 1, half - line * 1.5, half - line * 0.5, 0.028, true), [frame, n, half, line]);
  const edgeR = useMemo(() => stripMesh(frame, 0, n - 1, -half + line * 0.5, -half + line * 1.5, 0.028, true), [frame, n, half, line]);
  const pit = useMemo(
    () => (context?.pit_lane ?? []).map((l) => polylineRibbon(l.map(([x, y]) => toWorld(x, y)), PIT_LANE_WIDTH_M * scale.u, 0.015)),
    [context, scale.u],
  );
  const old = useMemo(
    () => (context?.other_raceways ?? []).map((l) => polylineRibbon(l.map(([x, y]) => toWorld(x, y)), OLD_RACEWAY_WIDTH_M * scale.u, 0.01)),
    [context, scale.u],
  );
  const start = frame.points[0]!;
  const t0 = frame.tangents[0]!;

  return (
    <group>
      <Ribbon data={asphalt} color="#34373c" />
      <Ribbon data={edgeL} color="#e9e9e9" roughness={0.6} />
      <Ribbon data={edgeR} color="#e9e9e9" roughness={0.6} />
      <Kerbs scene={scene} />
      {pit.map((d, i) => (
        <Ribbon key={`p${i}`} data={d} color="#43464b" />
      ))}
      {old.map((d, i) => (
        <Ribbon key={`o${i}`} data={d} color="#7b7d80" roughness={1} />
      ))}
      <mesh position={[start.x, 0.04, start.z]} rotation={[0, -Math.atan2(t0.z, t0.x), 0]} raycast={() => null}>
        <boxGeometry args={[1.2 * TRACK_DRAW_SCALE * scale.u, 0.01, half * 2]} />
        <meshStandardMaterial color="#f5f5f5" />
      </mesh>
    </group>
  );
}
