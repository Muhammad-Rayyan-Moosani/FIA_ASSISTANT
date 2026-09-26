"use client";

import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import { Color, DoubleSide, type MeshBasicMaterial, type MeshStandardMaterial } from "three";
import { riskHex } from "@/lib/riskColor";
import { stripMesh, wallMesh } from "@/lib/trackGeometry";
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

interface ZoneSafetyProps {
  scene: SceneData;
  placed: PlacedZone;
  selected: boolean;
  riskOverlay: boolean;
  flash: FlashRef;
  onSelect: (zoneId: string) => void;
  onHover: (zoneId: string | null) => void;
}

/** One zone as built: run-off surface, its barrier type, catch fence by grandstands; plus the risk tint when enabled. */
export function ZoneSafety({ scene, placed, selected, riskOverlay, flash, onSelect, onHover }: ZoneSafetyProps) {
  const { frame, scale } = scene;
  const { zone, risk } = placed.view;
  const [a, b] = placed.range;
  const side = placed.side;
  const half = scale.trackHalf;
  const look = BARRIER_LOOK[zone.barrier_type];
  const barrierH = scale.h(look.height);
  const fenceH = scale.h(zone.fence_height_m);
  const hasFence = zone.grandstand_capacity > 0;

  // Strips are offsets along the left normal; multiply by `side` for the outside of this zone.
  const runoff = useMeshGeometry(useMemo(() => stripMesh(frame, a, b, side * half, side * placed.barrierOffset, 0.012), [frame, a, b, side, half, placed.barrierOffset]));
  const barrier = useMeshGeometry(useMemo(() => wallMesh(frame, a, b, side, placed.barrierOffset, barrierH), [frame, a, b, side, placed.barrierOffset, barrierH]));
  const fence = useMeshGeometry(useMemo(() => wallMesh(frame, a, b, side, placed.barrierOffset + 0.3 * scale.u, barrierH + fenceH), [frame, a, b, side, placed.barrierOffset, barrierH, fenceH, scale.u]));
  const tint = useMeshGeometry(useMemo(() => stripMesh(frame, a, b, half, -half, 0.03), [frame, a, b, half]));
  const cap = useMeshGeometry(useMemo(() => wallMesh(frame, a, b, side, placed.barrierOffset - 0.05 * scale.u, barrierH + scale.h(0.25)), [frame, a, b, side, placed.barrierOffset, barrierH, scale]));
  const pick = useMeshGeometry(useMemo(() => stripMesh(frame, a, b, side * placed.barrierOffset, -side * half, 0.05), [frame, a, b, side, placed.barrierOffset, half]));

  const target = useMemo(() => new Color(risk ? riskHex(risk.risk_score) : NEUTRAL_ZONE), [risk]);
  const current = useRef(target.clone());
  const tintMat = useRef<MeshBasicMaterial>(null);
  const capMat = useRef<MeshStandardMaterial>(null);
  const barrierMat = useRef<MeshStandardMaterial>(null);

  useFrame((_, dt) => {
    current.current.lerp(target, 1 - Math.exp(-dt * 6));
    const f = flash.current.get(zone.zone_id) ?? 0;
    if (tintMat.current) {
      tintMat.current.color.copy(current.current);
      tintMat.current.opacity = riskOverlay ? (selected ? 0.5 : 0.24) : selected ? 0.28 : 0;
    }
    if (capMat.current) {
      capMat.current.emissive.copy(current.current);
      capMat.current.color.copy(current.current);
      capMat.current.emissiveIntensity = (selected ? 1.4 : 0.9) + f * 3;
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
      <mesh geometry={tint} raycast={() => null}>
        <meshBasicMaterial ref={tintMat} transparent opacity={0} depthWrite={false} side={DoubleSide} />
      </mesh>
      <mesh geometry={cap} visible={riskOverlay} raycast={() => null}>
        <meshStandardMaterial ref={capMat} emissiveIntensity={0.9} side={DoubleSide} />
      </mesh>
      <mesh geometry={pick} {...handlers}>
        <meshBasicMaterial transparent opacity={0} depthWrite={false} side={DoubleSide} />
      </mesh>
    </group>
  );
}
