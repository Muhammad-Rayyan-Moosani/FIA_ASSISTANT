"use client";

import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { BufferAttribute, BufferGeometry, Color, DoubleSide, type MeshBasicMaterial, type MeshStandardMaterial } from "three";
import { vividRiskHex } from "@/lib/riskColor";
import { crossLine, gradientStrip, stripMesh, wallMesh } from "@/lib/trackGeometry";
import type { BarrierType } from "@/types/track";
import { NEUTRAL_ZONE, RUNOFF_COLOR, type FlashRef, type PlacedZone, type SceneData } from "./sceneTypes";
import { useMeshGeometry } from "./useMeshGeometry";

/** How each barrier type looks: real height (m), colour and finish. */
const BARRIER_LOOK: Record<BarrierType, { height: number; color: string; metalness: number; roughness: number }> = {
  tyre_wall: { height: 1.0, color: "#1b1c1f", metalness: 0, roughness: 0.95 },
  guardrail: { height: 0.9, color: "#aab1b9", metalness: 0.7, roughness: 0.35 },
  concrete: { height: 1.1, color: "#c9c4b9", metalness: 0, roughness: 0.9 },
  tecpro: { height: 1.0, color: "#2459b8", metalness: 0.1, roughness: 0.6 },
  safer: { height: 1.2, color: "#e8e8e8", metalness: 0.2, roughness: 0.5 },
};
const CLICK_TOLERANCE_PX = 5;
/** Glow band rows (metres from the track edge, negative = onto the asphalt) and their alpha. */
const BAND_ONTO_TRACK_M = 3.5;
const BAND_ALPHA = [0, 0.95, 0.55, 0.08] as const;
const EDGE_LINE_M = 1.1;
const GATE_WIDTH_M = 0.9;
const WHITE = new Color("#ffffff");

interface ZoneSafetyProps {
  scene: SceneData;
  placed: PlacedZone;
  selected: boolean;
  hovered: boolean;
  riskOverlay: boolean;
  flash: FlashRef;
  onSelect: (zoneId: string) => void;
  onHover: (zoneId: string | null) => void;
}

function useRgbaGeometry(data: { positions: Float32Array; indices: number[]; colors: Float32Array }): BufferGeometry {
  const geometry = useMemo(() => {
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(data.positions, 3));
    g.setAttribute("color", new BufferAttribute(data.colors, 4));
    g.setIndex(data.indices);
    g.computeVertexNormals();
    return g;
  }, [data]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return geometry;
}

/**
 * One zone as built (run-off surface, barrier type, catch fence by grandstands) and, in risk view, its highlight:
 * a glow band that is brightest at the track edge and fades across the run-off to the barrier, a solid risk-coloured
 * edge line, a light tint on the asphalt, a glowing barrier cap and a white gate where the zone begins.
 */
export function ZoneSafety({ scene, placed, selected, hovered, riskOverlay, flash, onSelect, onHover }: ZoneSafetyProps) {
  const { frame, scale } = scene;
  const { zone, risk } = placed.view;
  const [a, b] = placed.range;
  const side = placed.side;
  const half = scale.trackHalf;
  const u = scale.u;
  const look = BARRIER_LOOK[zone.barrier_type];
  const barrierH = scale.h(look.height);
  const fenceH = scale.h(zone.fence_height_m);
  const hasFence = zone.grandstand_capacity > 0;
  const outer = placed.barrierOffset;

  // Strips are offsets along the left normal; multiply by `side` for the outside of this zone.
  const runoff = useMeshGeometry(useMemo(() => stripMesh(frame, a, b, side * half, side * outer, 0.012), [frame, a, b, side, half, outer]));
  const barrier = useMeshGeometry(useMemo(() => wallMesh(frame, a, b, side, outer, barrierH), [frame, a, b, side, outer, barrierH]));
  const fence = useMeshGeometry(useMemo(() => wallMesh(frame, a, b, side, outer + 0.3 * u, barrierH + fenceH), [frame, a, b, side, outer, barrierH, fenceH, u]));
  const cap = useMeshGeometry(useMemo(() => wallMesh(frame, a, b, side, outer - 0.05 * u, barrierH + scale.h(0.3)), [frame, a, b, side, outer, barrierH, scale, u]));
  const band = useRgbaGeometry(useMemo(() => {
    const mid = half + (outer - half) * 0.35;
    return gradientStrip(frame, a, b, [side * (half - BAND_ONTO_TRACK_M * u), side * half, side * mid, side * outer], BAND_ALPHA, 0.03);
  }, [frame, a, b, side, half, outer, u]));
  const edge = useMeshGeometry(useMemo(() => stripMesh(frame, a, b, side * (half - EDGE_LINE_M * u), side * half, 0.034), [frame, a, b, side, half, u]));
  const tint = useMeshGeometry(useMemo(() => stripMesh(frame, a, b, half, -half, 0.026), [frame, a, b, half]));
  const gate = useMeshGeometry(useMemo(() => crossLine(frame, a, -side * half, side * outer, GATE_WIDTH_M * u, 0.036), [frame, a, side, half, outer, u]));
  const pick = useMeshGeometry(useMemo(() => stripMesh(frame, a, b, side * outer, -side * half, 0.05), [frame, a, b, side, outer, half]));

  const target = useMemo(() => new Color(risk ? vividRiskHex(risk.risk_score) : NEUTRAL_ZONE), [risk]);
  const current = useRef(target.clone());
  const bandMat = useRef<MeshBasicMaterial>(null);
  const edgeMat = useRef<MeshBasicMaterial>(null);
  const tintMat = useRef<MeshBasicMaterial>(null);
  const gateMat = useRef<MeshBasicMaterial>(null);
  const capMat = useRef<MeshBasicMaterial>(null);
  const barrierMat = useRef<MeshStandardMaterial>(null);

  useFrame(({ clock }, dt) => {
    current.current.lerp(target, 1 - Math.exp(-dt * 6));
    const f = flash.current.get(zone.zone_id) ?? 0;
    const pulse = selected ? 0.82 + 0.18 * Math.sin(clock.elapsedTime * 3.2) : 1;
    const on = riskOverlay ? 1 : selected ? 0.6 : 0;
    const emphasis = selected ? 1 : hovered ? 0.9 : 0.7;
    for (const m of [bandMat.current, edgeMat.current, tintMat.current, capMat.current]) m?.color.copy(current.current);
    if (bandMat.current) bandMat.current.opacity = on * emphasis * pulse + f * 0.4;
    if (edgeMat.current) edgeMat.current.opacity = on * (selected || hovered ? 1 : 0.85);
    if (tintMat.current) tintMat.current.opacity = on * (selected ? 0.22 : hovered ? 0.14 : 0.07);
    if (gateMat.current) gateMat.current.opacity = on * 0.75;
    if (capMat.current) {
      capMat.current.opacity = Math.min(1, on * (selected ? 1 : 0.8) + f);
      if (f > 0) capMat.current.color.lerp(WHITE, f * 0.6);
    }
    if (barrierMat.current) barrierMat.current.emissiveIntensity = f * 2.5;
    if (f > 0) flash.current.set(zone.zone_id, Math.max(0, f - dt * 1.2));
  });

  const handlers = {
    onClick: (e: ThreeEvent<MouseEvent>) => {
      if (e.delta > CLICK_TOLERANCE_PX) return;
      e.stopPropagation();
      onSelect(zone.zone_id);
    },
    onPointerOver: (e: ThreeEvent<PointerEvent>) => {
      e.stopPropagation();
      onHover(zone.zone_id);
    },
    onPointerOut: () => onHover(null),
  };
  const glow = { transparent: true, depthWrite: false, toneMapped: false, side: DoubleSide } as const;

  return (
    <group>
      <mesh geometry={runoff} receiveShadow raycast={() => null}>
        <meshStandardMaterial color={RUNOFF_COLOR[zone.runoff_type]} roughness={1} side={DoubleSide} />
      </mesh>
      <mesh geometry={barrier} castShadow receiveShadow raycast={() => null}>
        <meshStandardMaterial ref={barrierMat} color={look.color} metalness={look.metalness} roughness={look.roughness} emissive="#ff3b30" emissiveIntensity={0} side={DoubleSide} />
      </mesh>
      {hasFence && (
        <mesh geometry={fence} raycast={() => null}>
          <meshStandardMaterial color="#9ea7b0" transparent opacity={0.28} depthWrite={false} side={DoubleSide} />
        </mesh>
      )}
      <mesh geometry={tint} renderOrder={1} raycast={() => null}>
        <meshBasicMaterial ref={tintMat} opacity={0} {...glow} />
      </mesh>
      <mesh geometry={band} renderOrder={2} raycast={() => null}>
        <meshBasicMaterial ref={bandMat} vertexColors opacity={0} {...glow} />
      </mesh>
      <mesh geometry={edge} renderOrder={3} raycast={() => null}>
        <meshBasicMaterial ref={edgeMat} opacity={0} {...glow} />
      </mesh>
      <mesh geometry={gate} renderOrder={3} raycast={() => null}>
        <meshBasicMaterial ref={gateMat} color="#ffffff" opacity={0} {...glow} />
      </mesh>
      <mesh geometry={cap} renderOrder={3} raycast={() => null}>
        <meshBasicMaterial ref={capMat} opacity={0} {...glow} />
      </mesh>
      <mesh geometry={pick} {...handlers}>
        <meshBasicMaterial transparent opacity={0} depthWrite={false} side={DoubleSide} />
      </mesh>
    </group>
  );
}
