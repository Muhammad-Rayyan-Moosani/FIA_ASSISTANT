"use client";

import { useEffect, useMemo, useRef } from "react";
import { BufferAttribute, BufferGeometry, Color, CylinderGeometry, DoubleSide, ExtrudeGeometry, type InstancedMesh, Matrix4, Quaternion, Shape, Vector2, Vector3 } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { hash01, polylineFractions, polylineRibbon, toWorld, WORLD_SCALE, type MeshData, type Vec2 } from "@/lib/trackGeometry";
import type { AssetContext, ContextRoad } from "@/types/assets";
import type { SceneData } from "./sceneTypes";

const ROAD_Y = -0.03;
const ROAD_ORDER: ContextRoad["kind"][] = ["path", "service", "minor", "rail", "major"];
const ROAD_COLOR: Record<ContextRoad["kind"], string> = {
  path: "#c8bea6",
  service: "#8f9296",
  minor: "#7e8185",
  rail: "#5d554c",
  major: "#6a6d71",
};
/** Assumed bridge deck height above water / ground (OSM rarely maps it). */
const BRIDGE_DECK_M = 10;
const BRIDGE_RAMP = 0.12;               // fraction of the bridge at each end that ramps down to the banks
const PIER_SPACING_M = 45;

function appendMesh(into: { pos: number[]; col: number[]; idx: number[] }, data: MeshData, color: Color) {
  const base = into.pos.length / 3;
  into.pos.push(...data.positions);
  for (let i = 0; i < data.positions.length / 3; i++) into.col.push(color.r, color.g, color.b);
  data.indices.forEach((i) => into.idx.push(base + i));
}

function toGeometry({ pos, col, idx }: { pos: number[]; col: number[]; idx: number[] }): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute("color", new BufferAttribute(new Float32Array(col), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const deckHeight = (f: number, top: number) => top * Math.min(1, Math.min(f, 1 - f) / BRIDGE_RAMP);

/** Public roads, paths and rail around the circuit, with road and rail bridges raised on piers (OpenStreetMap). */
function Roads({ roads, scene }: { roads: ContextRoad[]; scene: SceneData }) {
  const { u, h } = scene.scale;
  const { ground, decks, piers } = useMemo(() => {
    const flat = { pos: [] as number[], col: [] as number[], idx: [] as number[] };
    const deck = { pos: [] as number[], col: [] as number[], idx: [] as number[] };
    const pierAt: Vec2[] = [];
    const top = h(BRIDGE_DECK_M);
    const c = new Color();
    const sorted = [...roads].sort((a, b) => ROAD_ORDER.indexOf(a.kind) - ROAD_ORDER.indexOf(b.kind));
    for (const r of sorted) {
      const pts = r.points.map(([x, y]) => toWorld(x, y));
      if (pts.length < 2) continue;
      const width = r.width_m * u;
      c.set(ROAD_COLOR[r.kind]);
      if (!r.bridge) {
        appendMesh(flat, polylineRibbon(pts, width, ROAD_Y), c);
        continue;
      }
      const f = polylineFractions(pts);
      appendMesh(deck, polylineRibbon(pts, width * 1.15, (i) => deckHeight(f[i]!, top) + 0.01), c.clone().offsetHSL(0, -0.05, 0.08));
      const lengthUnits = pts.reduce((s, p, i) => (i ? s + Math.hypot(p.x - pts[i - 1]!.x, p.z - pts[i - 1]!.z) : 0), 0);
      const count = Math.floor(lengthUnits / (PIER_SPACING_M * u));
      for (let k = 1; k < count; k++) {
        const t = k / count;
        if (t < BRIDGE_RAMP || t > 1 - BRIDGE_RAMP) continue;
        const i = f.findIndex((v) => v >= t);
        const a = pts[Math.max(0, i - 1)]!;
        const b = pts[Math.max(0, i)]!;
        const s = (t - f[Math.max(0, i - 1)]!) / Math.max(1e-6, f[i]! - f[Math.max(0, i - 1)]!);
        pierAt.push({ x: a.x + (b.x - a.x) * s, z: a.z + (b.z - a.z) * s });
      }
    }
    return { ground: toGeometry(flat), decks: toGeometry(deck), piers: pierAt };
  }, [roads, u, h]);
  useEffect(() => () => {
    ground.dispose();
    decks.dispose();
  }, [ground, decks]);

  const pierTop = h(BRIDGE_DECK_M);
  const pierGeo = useMemo(() => new CylinderGeometry(1.4 * u, 1.8 * u, pierTop, 8).translate(0, pierTop / 2 - 0.05, 0), [u, pierTop]);
  useEffect(() => () => pierGeo.dispose(), [pierGeo]);
  const pierRef = useRef<InstancedMesh>(null);
  useEffect(() => {
    const m = new Matrix4();
    piers.forEach((p, i) => pierRef.current?.setMatrixAt(i, m.compose(new Vector3(p.x, 0, p.z), new Quaternion(), new Vector3(1, 1, 1))));
    if (pierRef.current) pierRef.current.instanceMatrix.needsUpdate = true;
  }, [piers]);

  return (
    <group>
      <mesh geometry={ground} renderOrder={-0.5} receiveShadow raycast={() => null}>
        <meshStandardMaterial vertexColors roughness={0.92} depthWrite={false} side={DoubleSide} />
      </mesh>
      <mesh geometry={decks} castShadow receiveShadow raycast={() => null}>
        <meshStandardMaterial vertexColors roughness={0.8} side={DoubleSide} />
      </mesh>
      {piers.length > 0 && (
        <instancedMesh ref={pierRef} args={[pierGeo, undefined, piers.length]} castShadow raycast={() => null}>
          <meshStandardMaterial color="#b3aea4" roughness={0.9} />
        </instancedMesh>
      )}
    </group>
  );
}

/** City and park buildings around the site (context, not insured), merged into one mesh. */
function CityBuildings({ buildings, scene }: { buildings: AssetContext["buildings"]; scene: SceneData }) {
  const { h } = scene.scale;
  const geometry = useMemo(() => {
    const parts: BufferGeometry[] = [];
    const c = new Color();
    buildings.forEach((b, i) => {
      if (b.points.length < 4) return;
      const shape = new Shape(b.points.map(([x, y]) => new Vector2(x * WORLD_SCALE, y * WORLD_SCALE)));
      const g = new ExtrudeGeometry(shape, { depth: h(b.height_m), bevelEnabled: false, curveSegments: 1 });
      g.rotateX(-Math.PI / 2);
      g.deleteAttribute("uv");
      const n = g.getAttribute("position").count;
      c.setHSL(0.09 + hash01(i, 3) * 0.05, 0.08 + hash01(i, 5) * 0.1, 0.66 + hash01(i, 7) * 0.16);
      const col = new Float32Array(n * 3);
      for (let k = 0; k < n; k++) col.set([c.r, c.g, c.b], k * 3);
      g.setAttribute("color", new BufferAttribute(col, 3));
      parts.push(g);
    });
    const merged = parts.length ? mergeGeometries(parts, false) : new BufferGeometry();
    parts.forEach((g) => g.dispose());
    return merged ?? new BufferGeometry();
  }, [buildings, h]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh geometry={geometry} castShadow receiveShadow raycast={() => null}>
      <meshStandardMaterial vertexColors roughness={0.88} />
    </mesh>
  );
}

/** Everything around the circuit that is not insured but makes the site read true: roads, bridges, city. */
export function Surroundings({ context, scene }: { context: AssetContext; scene: SceneData }) {
  return (
    <group>
      <Roads roads={context.roads} scene={scene} />
      <CityBuildings buildings={context.buildings} scene={scene} />
    </group>
  );
}
