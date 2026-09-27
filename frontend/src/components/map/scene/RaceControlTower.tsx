"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { AdditiveBlending, CylinderGeometry, DoubleSide, type Mesh, type MeshBasicMaterial, RingGeometry, SphereGeometry, type Vector3 } from "three";
import type { SceneScale } from "./sceneTypes";

const MAST_M = 16;
const RINGS = 3;

/**
 * Race control on the map: an antenna mast on the real race-control / pit building with a beacon, and radio
 * rings that pulse while race control is receiving or sending (incident, warnings, SC / VSC).
 */
export function RaceControlTower({ position, scale, active }: { position: Vector3; scale: SceneScale; active: boolean }) {
  const { u, h } = scale;
  const beaconMat = useRef<MeshBasicMaterial>(null);
  const rings = useRef<(Mesh | null)[]>([]);
  const geos = useMemo(() => ({
    mast: new CylinderGeometry(0.25 * u, 0.5 * u, h(MAST_M), 6).translate(0, h(MAST_M) / 2, 0),
    beacon: new SphereGeometry(1.8 * u, 16, 12),
    ring: new RingGeometry(0.85, 1, 48).rotateX(-Math.PI / 2),
  }), [u, h]);
  useEffect(() => () => {
    geos.mast.dispose();
    geos.beacon.dispose();
    geos.ring.dispose();
  }, [geos]);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    if (beaconMat.current) {
      const on = active ? Math.sin(t * 9) > 0 : Math.sin(t * 2) > 0.6;
      beaconMat.current.color.setRGB(on ? 3 : 0.5, on ? 0.35 : 0.1, on ? 0.2 : 0.05);
    }
    rings.current.forEach((m, i) => {
      if (!m) return;
      const phase = (t * 0.6 + i / RINGS) % 1;
      m.visible = active;
      m.scale.setScalar(u * (20 + phase * 260));
      (m.material as MeshBasicMaterial).opacity = (1 - phase) * 0.55;
    });
  });

  const top = h(MAST_M);
  return (
    <group position={position}>
      <mesh geometry={geos.mast} castShadow raycast={() => null}>
        <meshStandardMaterial color="#d7dbe0" metalness={0.5} roughness={0.35} />
      </mesh>
      <mesh geometry={geos.beacon} position={[0, top, 0]} raycast={() => null}>
        <meshBasicMaterial ref={beaconMat} toneMapped={false} />
      </mesh>
      {Array.from({ length: RINGS }, (_, i) => (
        <mesh key={i} ref={(m) => { rings.current[i] = m; }} geometry={geos.ring} position={[0, top * 0.6, 0]} raycast={() => null}>
          <meshBasicMaterial color="#ffb347" transparent opacity={0} depthWrite={false} blending={AdditiveBlending} side={DoubleSide} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}
