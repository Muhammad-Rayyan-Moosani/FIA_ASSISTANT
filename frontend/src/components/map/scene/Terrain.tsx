"use client";

import { useEffect, useMemo, useRef } from "react";
import { BufferAttribute, BufferGeometry, Color, ConeGeometry, CylinderGeometry, DoubleSide, InstancedMesh, Matrix4, Quaternion, ShapeUtils, Vector2, Vector3 } from "three";
import { hash01, insidePolygon, toWorld, type Vec2 } from "@/lib/trackGeometry";
import type { AssetContext, GroundKind } from "@/types/assets";
import type { SceneData } from "./sceneTypes";

const TREE_SPACING_M = 22;
const MAX_TREES = 6000;
const CLEAR_OF_TRACK_M = 45;          // keep trees off the track, run-off and barriers
const REGION = 170;                   // world units from the centre (beyond this the camera rarely looks)
const GROUND_Y = -0.035;

/** Daylight ground colours, matched to aerial photos of the sites. */
export const GROUND_COLOR: Record<GroundKind, string> = {
  water: "#2e5a73",
  land: "#6c8a4b",
  wood: "#3e5c31",
  grass: "#7b9853",
  beach: "#d8c79c",
  parking: "#8b8e91",
  pitch: "#6e9f4c",
};

/**
 * Every ground polygon in one mesh, triangles in the backend's painter's order (largest first), drawn without
 * depth writes so later (smaller, nested) areas paint over earlier ones: river → islands → lakes → woods → ...
 */
function groundGeometry(ground: AssetContext["ground"]): BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const c = new Color();
  for (const area of ground) {
    const pts = area.points.map(([x, y]) => toWorld(x, y));
    if (pts.length > 1 && pts[0]!.x === pts[pts.length - 1]!.x && pts[0]!.z === pts[pts.length - 1]!.z) pts.pop();
    if (pts.length < 3) continue;
    // (x, −z) so the triangles wind counter-clockwise seen from above (front faces up)
    const faces = ShapeUtils.triangulateShape(pts.map((p) => new Vector2(p.x, -p.z)), []);
    c.set(GROUND_COLOR[area.kind]);
    for (const f of faces) {
      for (const k of f) {
        const p = pts[k]!;
        pos.push(p.x, GROUND_Y, p.z);
        col.push(c.r, c.g, c.b);
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute("color", new BufferAttribute(new Float32Array(col), 3));
  g.setAttribute("normal", new BufferAttribute(new Float32Array(pos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  return g;
}

/** Ground from OpenStreetMap (river, islands, lakes, woods, grass, beaches, parking) and trees in the woods. */
export function Terrain({ context, scene, night }: { context: AssetContext; scene: SceneData; night: boolean }) {
  const { u, h } = scene.scale;
  const woods = useMemo(() => context.woods.map((p) => p.map(([x, y]) => toWorld(x, y))), [context.woods]);
  const ground = useMemo(() => groundGeometry(context.ground), [context.ground]);
  useEffect(() => () => ground.dispose(), [ground]);

  const trees = useMemo(() => {
    const step = TREE_SPACING_M * u;
    const clear = CLEAR_OF_TRACK_M * u;
    const pts = scene.frame.points;
    const out: { x: number; z: number; s: number }[] = [];
    for (const poly of woods as Vec2[][]) {
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
    const tint = new Color();
    trees.forEach((t, i) => {
      m.compose(new Vector3(t.x, 0, t.z), q, new Vector3(t.s, t.s, t.s));
      crownRef.current?.setMatrixAt(i, m);
      trunkRef.current?.setMatrixAt(i, m);
      crownRef.current?.setColorAt(i, tint.setHSL(0.26 + (t.s - 1) * 0.08, 0.42, 0.24 + (t.s - 0.75) * 0.12));
    });
    if (crownRef.current) {
      crownRef.current.instanceMatrix.needsUpdate = true;
      if (crownRef.current.instanceColor) crownRef.current.instanceColor.needsUpdate = true;
    }
    if (trunkRef.current) trunkRef.current.instanceMatrix.needsUpdate = true;
  }, [trees]);

  return (
    <group>
      <mesh geometry={ground} renderOrder={-1} receiveShadow raycast={() => null}>
        <meshStandardMaterial vertexColors roughness={0.95} depthWrite={false} side={DoubleSide} emissive="#0c1a33" emissiveIntensity={night ? 0.9 : 0} />
      </mesh>
      {trees.length > 0 && (
        <>
          <instancedMesh ref={crownRef} args={[geos.crown, undefined, trees.length]} castShadow raycast={() => null}>
            <meshStandardMaterial color="#ffffff" roughness={0.95} flatShading />
          </instancedMesh>
          <instancedMesh ref={trunkRef} args={[geos.trunk, undefined, trees.length]} raycast={() => null}>
            <meshStandardMaterial color="#5a4632" roughness={1} />
          </instancedMesh>
        </>
      )}
    </group>
  );
}
