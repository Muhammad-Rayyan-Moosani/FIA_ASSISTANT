"use client";

import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { AdditiveBlending, BoxGeometry, Color, CylinderGeometry, type MeshStandardMaterial, type Sprite, type SpriteMaterial } from "three";
import { nearestIndex, sampleAlong } from "@/lib/trackGeometry";
import type { Mast, MastState } from "@/types/raceControl";
import type { SceneData } from "./sceneTypes";
import { glowTexture } from "./Surroundings";

/** Marshal light panel colours and blink rates (Hz, 0 = steady) per FIA panel state. */
const LOOK: Record<MastState, { a: string; b: string | null; hz: number; glow: number }> = {
  clear: { a: "#1a1d22", b: null, hz: 0, glow: 0 },
  green: { a: "#1ee36b", b: null, hz: 0, glow: 1 },
  yellow: { a: "#ffcc12", b: null, hz: 1.2, glow: 1 },
  double_yellow: { a: "#ffcc12", b: "#ffcc12", hz: 3, glow: 1.4 },
  slippery: { a: "#ffcc12", b: "#ff2a2a", hz: 2, glow: 1.2 },
  vsc: { a: "#ffcc12", b: "#ffffff", hz: 1, glow: 1.2 },
  sc: { a: "#ffcc12", b: "#ffffff", hz: 2.4, glow: 1.5 },
  red: { a: "#ff1f1f", b: null, hz: 0, glow: 1.6 },
};
const POLE_M = 7;
const PANEL_M = [3.2, 1.9, 0.3] as const;
const MAST_BEYOND_BARRIER_M = 5;

interface MastProps {
  mast: Mast;
  scene: SceneData;
  onSelect: (sector: number) => void;
}

function MarshalMast({ mast, scene, onSelect }: MastProps) {
  const { u, h } = scene.scale;
  const panelRef = useRef<MeshStandardMaterial>(null);
  const glowRef = useRef<Sprite>(null);
  const glowMat = useRef<SpriteMaterial>(null);
  const colors = useRef({ a: new Color(), b: new Color() });

  // Stand the mast just beyond the barrier on the outside of its zone, facing the track.
  const place = useMemo(() => {
    const i = nearestIndex(scene.outline, mast.x, mast.y);
    const zone = scene.zones.find((z) => z.view.zone.zone_id === mast.zone_id);
    const side = zone?.side ?? 1;
    const offset = (zone?.barrierOffset ?? scene.scale.trackHalf + 10 * u) + MAST_BEYOND_BARRIER_M * u;
    const p = sampleAlong(scene.frame, i, side * offset);
    return { x: p.x, z: p.z, heading: p.heading + (side > 0 ? -Math.PI / 2 : Math.PI / 2) };
  }, [mast, scene, u]);

  const geos = useMemo(() => ({
    pole: new CylinderGeometry(0.18 * u, 0.24 * u, h(POLE_M), 8).translate(0, h(POLE_M) / 2, 0),
    panel: new BoxGeometry(PANEL_M[0] * u * 2, PANEL_M[1] * u * 2, PANEL_M[2] * u * 2),
  }), [u, h]);
  useEffect(() => () => {
    geos.pole.dispose();
    geos.panel.dispose();
  }, [geos]);

  useFrame(({ clock }) => {
    const look = LOOK[mast.state];
    const on = look.hz === 0 || Math.sin(clock.elapsedTime * Math.PI * 2 * look.hz) > 0;
    const { a, b } = colors.current;
    a.set(look.a);
    const c = look.b && !on ? b.set(look.b) : a;
    const lit = mast.state !== "clear" && (look.b !== null || on || look.hz === 0);
    if (panelRef.current) {
      panelRef.current.emissive.copy(c);
      panelRef.current.emissiveIntensity = lit ? 2.2 : mast.state === "clear" ? 0.05 : 0.25;
    }
    if (glowMat.current && glowRef.current) {
      glowMat.current.color.copy(c);
      glowMat.current.opacity = lit ? 0.9 : 0;
      glowRef.current.scale.setScalar(u * 22 * look.glow);
    }
  });

  const click = (e: ThreeEvent<MouseEvent>) => {
    if (e.delta > 5) return;
    e.stopPropagation();
    onSelect(mast.sector);
  };

  return (
    <group position={[place.x, 0, place.z]} rotation={[0, place.heading, 0]}>
      <mesh geometry={geos.pole} castShadow onClick={click}>
        <meshStandardMaterial color="#9aa1a8" metalness={0.6} roughness={0.4} />
      </mesh>
      <mesh geometry={geos.panel} position={[0, h(POLE_M) + PANEL_M[1] * u, 0]} castShadow onClick={click}>
        <meshStandardMaterial ref={panelRef} color="#0c0d10" emissive="#000000" roughness={0.35} toneMapped={false} />
      </mesh>
      <sprite ref={glowRef} position={[0, h(POLE_M) + PANEL_M[1] * u, 0]} raycast={() => null}>
        <spriteMaterial ref={glowMat} map={GLOW} transparent depthWrite={false} blending={AdditiveBlending} toneMapped={false} opacity={0} />
      </sprite>
    </group>
  );
}

let GLOW_TEX: ReturnType<typeof glowTexture> | null = null;
const GLOW = (() => {
  if (typeof document === "undefined") return null;
  GLOW_TEX ??= glowTexture();
  return GLOW_TEX;
})();

/** FIA marshal light panels at the real marshal sectors, lit by race control (yellow, double yellow, SC, ...). */
export function MarshalMasts({ masts, scene, onSelect }: { masts: Mast[]; scene: SceneData; onSelect: (sector: number) => void }) {
  return (
    <group>
      {masts.map((m) => (
        <MarshalMast key={m.sector} mast={m} scene={scene} onSelect={onSelect} />
      ))}
    </group>
  );
}

