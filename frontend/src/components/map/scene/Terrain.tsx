"use client";

import { useEffect, useMemo, useRef } from "react";
import { ConeGeometry, CylinderGeometry, InstancedMesh, Matrix4, Quaternion, Shape, ShapeGeometry, Vector2, Vector3 } from "three";
import { hash01, insidePolygon, toWorld, type Vec2 } from "@/lib/trackGeometry";
import type { AssetContext } from "@/types/assets";
import type { SceneData } from "./sceneTypes";

const TREE_SPACING_M = 22;
const MAX_TREES = 5000;
const CLEAR_OF_TRACK_M = 45;          // keep trees off the track, run-off and barriers
const REGION = 150;                   // world units from the centre (beyond this the camera rarely looks)

function shapeGeometry(poly: Vec2[]): ShapeGeometry {
  const shape = new Shape(poly.map((p) => new Vector2(p.x, -p.z)));
  const g = new ShapeGeometry(shape);
  g.rotateX(-Math.PI / 2);
  return g;
}

/** Woods (OSM natural=wood / landuse=forest) as darker ground with trees, and water (OSM water) polygons. */
export function Terrain({ context, scene }: { context: AssetContext; scene: SceneData }) {
  const { u, h } = scene.scale;
  const woods = useMemo(() => context.woods.map((p) => p.map(([x, y]) => toWorld(x, y))), [context.woods]);
  const water = useMemo(() => context.water.map((p) => p.map(([x, y]) => toWorld(x, y))), [context.water]);

  const woodGeoms = useMemo(() => woods.filter((p) => p.length > 3).map(shapeGeometry), [woods]);
  const waterGeoms = useMemo(() => water.filter((p) => p.length > 3).map(shapeGeometry), [water]);
  useEffect(() => () => [...woodGeoms, ...waterGeoms].forEach((g) => g.dispose()), [woodGeoms, waterGeoms]);

  const trees = useMemo(() => {
    const step = TREE_SPACING_M * u;
    const clear = CLEAR_OF_TRACK_M * u;
    const pts = scene.frame.points;
    const out: { x: number; z: number; s: number }[] = [];
    for (const poly of woods) {
      if (poly.length < 4) continue;
      const xs = poly.map((p) => p.x);
      const zs = poly.map((p) => p.z);
      for (let x = Math.min(...xs); x < Math.max(...xs) && out.length < MAX_TREES; x += step) {
        for (let z = Math.min(...zs); z < Math.max(...zs) && out.length < MAX_TREES; z += step) {
          const i = Math.round(x / step);
          const j = Math.round(z / step);
          const jx = x + (hash01(i, j) - 0.5) * step * 0.8;
          const jz = z + (hash01(j, i) - 0.5) * step * 0.8;
          if (Math.hypot(jx, jz) > REGION || !insidePolygon(jx, jz, poly)) continue;
          let near = false;
          for (let k = 0; k < pts.length; k += 2) {
            if (Math.abs(pts[k]!.x - jx) < clear && Math.abs(pts[k]!.z - jz) < clear) {
              near = true;
              break;
            }
          }
          if (!near) out.push({ x: jx, z: jz, s: 0.75 + hash01(i + 7, j + 3) * 0.5 });
        }
      }
    }
    return out;
  }, [woods, scene.frame.points, u]);

  const crownRef = useRef<InstancedMesh>(null);
  const trunkRef = useRef<InstancedMesh>(null);
  const treeH = h(18);
  const geos = useMemo(() => ({
    crown: new ConeGeometry(treeH * 0.28, treeH * 0.72, 7).translate(0, treeH * 0.62, 0),
    trunk: new CylinderGeometry(treeH * 0.035, treeH * 0.045, treeH * 0.3, 5).translate(0, treeH * 0.15, 0),
  }), [treeH]);
  useEffect(() => () => {
    geos.crown.dispose();
    geos.trunk.dispose();
  }, [geos]);

  useEffect(() => {
    const m = new Matrix4();
    const q = new Quaternion();
    trees.forEach((t, i) => {
      m.compose(new Vector3(t.x, 0, t.z), q, new Vector3(t.s, t.s, t.s));
      crownRef.current?.setMatrixAt(i, m);
      trunkRef.current?.setMatrixAt(i, m);
    });
    if (crownRef.current) crownRef.current.instanceMatrix.needsUpdate = true;
    if (trunkRef.current) trunkRef.current.instanceMatrix.needsUpdate = true;
  }, [trees]);

  return (
    <group>
      {woodGeoms.map((g, i) => (
        <mesh key={`w${i}`} geometry={g} position={[0, -0.03, 0]} receiveShadow raycast={() => null}>
          <meshStandardMaterial color="#4b6a36" roughness={1} />
        </mesh>
      ))}
      {waterGeoms.map((g, i) => (
        <mesh key={`h${i}`} geometry={g} position={[0, -0.02, 0]} raycast={() => null}>
          <meshStandardMaterial color="#3d6f8e" roughness={0.15} metalness={0.1} />
        </mesh>
      ))}
      {trees.length > 0 && (
        <>
          <instancedMesh ref={crownRef} args={[geos.crown, undefined, trees.length]} castShadow raycast={() => null}>
            <meshStandardMaterial color="#3f5f2e" roughness={0.95} flatShading />
          </instancedMesh>
          <instancedMesh ref={trunkRef} args={[geos.trunk, undefined, trees.length]} raycast={() => null}>
            <meshStandardMaterial color="#5a4632" roughness={1} />
          </instancedMesh>
        </>
      )}
    </group>
  );
}
