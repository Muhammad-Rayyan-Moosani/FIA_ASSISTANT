"use client";

import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, DoubleSide, type Mesh, type MeshBasicMaterial, type MeshStandardMaterial, type ShaderMaterial } from "three";
import { vividRiskHex } from "@/lib/riskColor";
import { crossLine, gradientStrip, lightCurtain, stripMesh, wallMesh } from "@/lib/trackGeometry";
import type { BarrierType } from "@/types/track";
import { NEUTRAL_ZONE, RUNOFF_COLOR, type FlashRef, type PlacedZone, type SceneData } from "./sceneTypes";
import { useMeshGeometry } from "./useMeshGeometry";
import { createZoneLightMaterial } from "./zoneLight";

/** How each barrier type looks: real height (m), colour and finish. */
const BARRIER_LOOK: Record<BarrierType, { height: number; color: string; metalness: number; roughness: number }> = {
  tyre_wall: { height: 1.0, color: "#1b1c1f", metalness: 0, roughness: 0.95 },
  guardrail: { height: 0.9, color: "#aab1b9", metalness: 0.7, roughness: 0.35 },
  concrete: { height: 1.1, color: "#c9c4b9", metalness: 0, roughness: 0.9 },
  tecpro: { height: 1.0, color: "#2459b8", metalness: 0.1, roughness: 0.6 },
  safer: { height: 1.2, color: "#e8e8e8", metalness: 0.2, roughness: 0.5 },
};
const CLICK_TOLERANCE_PX = 5;
/** Run-off glow rows (track edge → barrier) and their alpha. */
const BAND_ALPHA = [0.7, 0.3, 0.0] as const;
/** Asphalt glow rows (edge → centre → edge): light pooling on the track surface from the curtains. */
const SURFACE_ALPHA = [0.85, 0.28, 0.08, 0.28, 0.85] as const;
/** Height of the light curtains rising from the track edges (metres, before the vertical exaggeration). */
const CURTAIN_M = 14;
const GATE_WIDTH_M = 2;
const WHITE = new Color("#ffffff");

interface ZoneSafetyProps {
  scene: SceneData;
  placed: PlacedZone;
  selected: boolean;
  hovered: boolean;
  riskOverlay: boolean;
  night: boolean;
  flash: FlashRef;
  onSelect: (zoneId: string) => void;
  onHover: (zoneId: string | null) => void;
}

function useCurtainGeometry(frame: SceneData["frame"], a: number, b: number, offset: number, height: number): BufferGeometry {
  const geometry = useMemo(() => {
    const d = lightCurtain(frame, a, b, offset, height);
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(d.positions, 3));
    g.setAttribute("aH", new BufferAttribute(d.aH, 1));
    g.setAttribute("aT", new BufferAttribute(d.aT, 1));
    g.setAttribute("aS", new BufferAttribute(d.aS, 1));
    g.setIndex(d.indices);
    return g;
  }, [frame, a, b, offset, height]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return geometry;
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
 * One zone as built (run-off surface, barrier type, catch fence by grandstands) and, in risk view, its risk light:
 * curtains of light rising out of both track edges with pulses flowing in the race direction, light pooling on the
 * asphalt and spilling across the run-off, a glowing barrier cap and a white gate where the zone begins.
 */
export function ZoneSafety({ scene, placed, selected, hovered, riskOverlay, night, flash, onSelect, onHover }: ZoneSafetyProps) {
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
  const band = useRgbaGeometry(useMemo(
    () => gradientStrip(frame, a, b, [side * half, side * (half + (outer - half) * 0.4), side * outer], BAND_ALPHA, 0.03),
    [frame, a, b, side, half, outer],
  ));
  const surface = useRgbaGeometry(useMemo(
    () => gradientStrip(frame, a, b, [half, half * 0.45, 0, -half * 0.45, -half], SURFACE_ALPHA, 0.032),
    [frame, a, b, half],
  ));
  const curtainH = scale.h(CURTAIN_M);
  const curtainL = useCurtainGeometry(frame, a, b, half, curtainH);
  const curtainR = useCurtainGeometry(frame, a, b, -half, curtainH);
  const lightMat = useMemo(() => createZoneLightMaterial(), []);
  useEffect(() => () => lightMat.dispose(), [lightMat]);
  const gate = useMeshGeometry(useMemo(() => crossLine(frame, a, -side * half, side * outer, GATE_WIDTH_M * u, 0.036), [frame, a, side, half, outer, u]));
  const pick = useMeshGeometry(useMemo(() => stripMesh(frame, a, b, side * outer, -side * half, 0.05), [frame, a, b, side, outer, half]));

  const target = useMemo(() => new Color(risk ? vividRiskHex(risk.risk_score) : NEUTRAL_ZONE), [risk]);
  const current = useRef(target.clone());
  const bandMat = useRef<MeshBasicMaterial>(null);
  const surfaceMat = useRef<MeshBasicMaterial>(null);
  const gateMat = useRef<MeshBasicMaterial>(null);
  const capMat = useRef<MeshBasicMaterial>(null);
  const barrierMat = useRef<MeshStandardMaterial>(null);
  const curtainRef = useRef<Mesh>(null);

  useFrame(({ clock }, dt) => {
    current.current.lerp(target, 1 - Math.exp(-dt * 6));
    const f = flash.current.get(zone.zone_id) ?? 0;
    const pulse = selected ? 0.82 + 0.18 * Math.sin(clock.elapsedTime * 3.2) : 1;
    const on = riskOverlay ? 1 : selected ? 0.6 : 0;
    const emphasis = selected ? 1 : hovered ? 0.85 : 0.62;
    for (const m of [bandMat.current, surfaceMat.current, capMat.current]) m?.color.copy(current.current);
    if (bandMat.current) bandMat.current.opacity = on * emphasis * pulse * (night ? 0.8 : 0.75) + f * 0.4;
    if (surfaceMat.current) surfaceMat.current.opacity = on * emphasis * pulse * (night ? 0.75 : 0.7) + f * 0.3;
    const lm = curtainRef.current?.material as ShaderMaterial | undefined;
    if (lm) {
      lm.uniforms.uColor!.value.copy(current.current);
      lm.uniforms.uTime!.value = clock.elapsedTime;
      lm.uniforms.uOpacity!.value = on * emphasis * pulse * (night ? 1.1 : 1.05) + f * 0.8;
    }
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
  const light = { ...glow, blending: AdditiveBlending } as const;

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
      <mesh geometry={surface} renderOrder={1} raycast={() => null}>
        <meshBasicMaterial ref={surfaceMat} vertexColors opacity={0} {...light} />
      </mesh>
      <mesh geometry={band} renderOrder={2} raycast={() => null}>
        <meshBasicMaterial ref={bandMat} vertexColors opacity={0} {...light} />
      </mesh>
      <mesh ref={curtainRef} geometry={curtainL} material={lightMat} renderOrder={4} raycast={() => null} />
      <mesh geometry={curtainR} material={lightMat} renderOrder={4} raycast={() => null} />
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
