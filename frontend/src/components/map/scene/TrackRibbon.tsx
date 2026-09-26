"use client";

import { useMemo } from "react";
import { BufferGeometry, DoubleSide, Float32BufferAttribute } from "three";
import { stripMesh, TRACK_WIDTH, type TrackFrame } from "@/lib/trackGeometry";
import { useMeshGeometry } from "./useMeshGeometry";

/** Asphalt ribbon, edge lines and the start/finish line. */
export function TrackRibbon({ frame }: { frame: TrackFrame }) {
  const n = frame.points.length;
  const asphalt = useMeshGeometry(useMemo(() => stripMesh(frame, 0, n - 1, TRACK_WIDTH / 2, -TRACK_WIDTH / 2, 0.02, true), [frame, n]));

  const edges = useMemo(
    () =>
      ([1, -1] as const).map((sign) => {
        const pts: number[] = [];
        frame.points.forEach((p, i) => {
          const q = frame.normals[i]!;
          pts.push(p.x + q.x * sign * (TRACK_WIDTH / 2), 0.04, p.z + q.z * sign * (TRACK_WIDTH / 2));
        });
        const g = new BufferGeometry();
        g.setAttribute("position", new Float32BufferAttribute(pts, 3));
        return g;
      }),
    [frame],
  );

  const start = frame.points[0]!;
  const t0 = frame.tangents[0]!;

  return (
    <group>
      <mesh geometry={asphalt}>
        <meshStandardMaterial color="#222c36" roughness={0.85} side={DoubleSide} />
      </mesh>
      {edges.map((g, i) => (
        <lineLoop key={i} geometry={g}>
          <lineBasicMaterial color="#9fb0c2" transparent opacity={0.35} />
        </lineLoop>
      ))}
      <mesh position={[start.x, 0.05, start.z]} rotation={[0, -Math.atan2(t0.z, t0.x), 0]}>
        <boxGeometry args={[0.35, 0.05, TRACK_WIDTH]} />
        <meshBasicMaterial color="#ffffff" />
      </mesh>
    </group>
  );
}
