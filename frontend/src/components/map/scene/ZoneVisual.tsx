"use client";

import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import { AdditiveBlending, Color, CylinderGeometry, DoubleSide, type Mesh, type MeshBasicMaterial, type MeshStandardMaterial } from "three";
import { riskHex } from "@/lib/riskColor";
import { stripMesh, TRACK_WIDTH, WALL_OFFSET, wallMesh, type TrackFrame } from "@/lib/trackGeometry";
import { NEUTRAL_ZONE, type FlashRef, type PlacedZone } from "./sceneTypes";
import { useMeshGeometry } from "./useMeshGeometry";

interface ZoneVisualProps {
  frame: TrackFrame;
  placed: PlacedZone;
  maxPremium: number;
  selected: boolean;
  flash: FlashRef;
  reducedMotion: boolean;
  onSelect: (zoneId: string) => void;
  onHover: (zoneId: string | null) => void;
}

const COLUMN_INSET = TRACK_WIDTH / 2 + 3.2;
const CLICK_TOLERANCE_PX = 5;

// Shared by every zone; unit height, base at y = 0, scaled on Y by the premium.
const COLUMN_GEOMETRY = new CylinderGeometry(0.9, 0.9, 1, 28, 1, true).translate(0, 0.5, 0);
const HALO_GEOMETRY = new CylinderGeometry(1.9, 1.9, 1, 28, 1, true).translate(0, 0.5, 0);

/** One zone: tinted track overlay, glowing barrier, loss column and grandstand (flashes on a severe crash). Colours and heights tween. */
export function ZoneVisual({ frame, placed, maxPremium, selected, flash, reducedMotion, onSelect, onHover }: ZoneVisualProps) {
  const { view, range, mid, side } = placed;
  const { zone, risk } = view;
  const [a, b] = range;

  const overlayGeo = useMeshGeometry(useMemo(() => stripMesh(frame, a, b, (TRACK_WIDTH / 2) * 1.02, (-TRACK_WIDTH / 2) * 1.02, 0.05), [frame, a, b]));
  const wallGeo = useMeshGeometry(useMemo(() => wallMesh(frame, a, b, side, WALL_OFFSET, 1.1), [frame, a, b, side]));
  const glowGeo = useMeshGeometry(useMemo(() => wallMesh(frame, a, b, side, WALL_OFFSET + 0.15, 2.4), [frame, a, b, side]));

  const p = frame.points[mid]!;
  const q = frame.normals[mid]!;
  const t = frame.tangents[mid]!;
  const column: [number, number, number] = [p.x - q.x * side * COLUMN_INSET, 0, p.z - q.z * side * COLUMN_INSET];
  const yaw = -Math.atan2(t.z, t.x);

  const target = useMemo(() => new Color(risk ? riskHex(risk.risk_score) : NEUTRAL_ZONE), [risk]);
  const targetHeight = risk && maxPremium > 0 ? 1.5 + 18 * Math.sqrt(risk.premium_eur / maxPremium) : 0.6;
  const current = useRef({ color: target.clone(), height: targetHeight });

  const overlayMat = useRef<MeshBasicMaterial>(null);
  const wallMat = useRef<MeshStandardMaterial>(null);
  const glowMat = useRef<MeshBasicMaterial>(null);
  const columnMat = useRef<MeshStandardMaterial>(null);
  const haloMat = useRef<MeshBasicMaterial>(null);
  const capMat = useRef<MeshBasicMaterial>(null);
  const standMats = useRef<(MeshStandardMaterial | null)[]>([]);
  const columnMesh = useRef<Mesh>(null);
  const haloMesh = useRef<Mesh>(null);
  const capMesh = useRef<Mesh>(null);

  useFrame((_, dt) => {
    const k = reducedMotion ? 1 : 1 - Math.exp(-dt * 7);
    const c = current.current;
    c.color.lerp(target, k);
    c.height += (targetHeight - c.height) * k;
    const s = selected ? 1 : 0;
    overlayMat.current?.color.copy(c.color);
    if (overlayMat.current) overlayMat.current.opacity = 0.3 + 0.45 * s;
    if (wallMat.current) {
      wallMat.current.emissive.copy(c.color);
      wallMat.current.emissiveIntensity = 1 + 0.6 * s;
    }
    if (glowMat.current) {
      glowMat.current.color.copy(c.color);
      glowMat.current.opacity = 0.2 + 0.25 * s;
    }
    if (columnMat.current) {
      columnMat.current.emissive.copy(c.color);
      columnMat.current.emissiveIntensity = 0.85 + 0.45 * s;
    }
    if (haloMat.current) {
      haloMat.current.color.copy(c.color);
      haloMat.current.opacity = 0.09 + 0.13 * s;
    }
    capMat.current?.color.copy(c.color);
    columnMesh.current?.scale.set(1, c.height, 1);
    haloMesh.current?.scale.set(1, c.height, 1);
    capMesh.current?.position.setY(c.height);
    const f = flash.current.get(zone.zone_id) ?? 0;
    const glowLevel = f * 1.5;
    for (const m of standMats.current) if (m) m.emissiveIntensity = glowLevel;
    if (f > 0) flash.current.set(zone.zone_id, Math.max(0, f - dt * 1.5));
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

  const standOffset = WALL_OFFSET + 1.8 + (zone.distance_to_stand_m ?? 0) * 0.05;
  const standLength = Math.min(16, 4 + zone.grandstand_capacity / 900);

  return (
    <group>
      <mesh geometry={overlayGeo} {...handlers}>
        <meshBasicMaterial ref={overlayMat} transparent opacity={0.3} depthWrite={false} side={DoubleSide} />
      </mesh>
      <mesh geometry={wallGeo} {...handlers}>
        <meshStandardMaterial ref={wallMat} color="#0c1116" roughness={0.6} side={DoubleSide} />
      </mesh>
      <mesh geometry={glowGeo} raycast={() => null}>
        <meshBasicMaterial ref={glowMat} transparent opacity={0.2} blending={AdditiveBlending} depthWrite={false} side={DoubleSide} />
      </mesh>

      <group position={column}>
        <mesh ref={columnMesh} geometry={COLUMN_GEOMETRY} {...handlers}>
          <meshStandardMaterial ref={columnMat} color="#0c1116" transparent opacity={0.92} />
        </mesh>
        <mesh ref={haloMesh} geometry={HALO_GEOMETRY} raycast={() => null}>
          <meshBasicMaterial ref={haloMat} transparent opacity={0.09} blending={AdditiveBlending} depthWrite={false} side={DoubleSide} />
        </mesh>
        <mesh ref={capMesh} rotation={[-Math.PI / 2, 0, 0]} raycast={() => null}>
          <circleGeometry args={[0.9, 28]} />
          <meshBasicMaterial ref={capMat} />
        </mesh>
      </group>

      {zone.grandstand_capacity > 0 &&
        [0, 1, 2].map((tier) => {
          const off = standOffset + tier * 1.3;
          const h = 0.9 + tier * 0.9;
          return (
            <mesh key={tier} position={[p.x + q.x * side * off, h / 2, p.z + q.z * side * off]} rotation={[0, yaw, 0]} raycast={() => null}>
              <boxGeometry args={[standLength, h, 1.3]} />
              <meshStandardMaterial
                ref={(m) => {
                  standMats.current[tier] = m;
                }}
                color="#2c3a48"
                emissive="#e5484d"
                emissiveIntensity={0}
                roughness={0.8}
              />
            </mesh>
          );
        })}
    </group>
  );
}
