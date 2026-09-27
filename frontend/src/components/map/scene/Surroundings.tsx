"use client";

import { useEffect, useMemo, useRef } from "react";
import { AdditiveBlending, BufferAttribute, BufferGeometry, CanvasTexture, Color, CylinderGeometry, DoubleSide, ExtrudeGeometry, type InstancedMesh, Matrix4, Quaternion, RepeatWrapping, Shape, SRGBColorSpace, Vector2, Vector3 } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { hash01, polylineFractions, polylineRibbon, toWorld, WORLD_SCALE, type MeshData, type Vec2 } from "@/lib/trackGeometry";
import type { AssetContext, ContextRoad } from "@/types/assets";
import { VERTICAL_EXAGGERATION, type SceneData } from "./sceneTypes";

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
const LAMP_SPACING_M = 38;
const LAMP_HEIGHT_M = 9;
const WINDOW_CELL_M = 12;            // one texture tile: 4 windows across, 4 floors up
const FLOOR_M = 3.2;

/** 4 × 4 windows, some lit (warm), on a black frame; the corner texel stays black for roofs. */
function windowTexture(): CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  g.fillStyle = "#000";
  g.fillRect(0, 0, 64, 64);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      const r = hash01(i * 7 + 1, j * 13 + 5);
      g.fillStyle = r < 0.42 ? `hsl(${34 + r * 30}, 90%, ${58 + r * 30}%)` : "#0b0d12";
      g.fillRect(i * 16 + 4, j * 16 + 4, 9, 8);
    }
  }
  const tex = new CanvasTexture(c);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

/** Soft round glow for lamp sprites. */
function glowTexture(): CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.25, "rgba(255,255,255,0.55)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new CanvasTexture(c);
}

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

const LAMP_COLOR = new Color().setRGB(2.6, 1.7, 0.8);

const deckHeight = (f: number, top: number) => top * Math.min(1, Math.min(f, 1 - f) / BRIDGE_RAMP);

/** Public roads, paths and rail around the circuit, with road and rail bridges raised on piers (OpenStreetMap). */
function Roads({ roads, scene, night }: { roads: ContextRoad[]; scene: SceneData; night: boolean }) {
  const { u, h } = scene.scale;
  const { ground, decks, piers, lamps } = useMemo(() => {
    const flat = { pos: [] as number[], col: [] as number[], idx: [] as number[] };
    const lampAt: number[] = [];
    const lampH = h(LAMP_HEIGHT_M);
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
      const f = polylineFractions(pts);
      const lengthM = pts.reduce((s, p, i) => (i ? s + Math.hypot(p.x - pts[i - 1]!.x, p.z - pts[i - 1]!.z) : 0), 0) / u;
      if (r.kind !== "path" && r.kind !== "rail") {
        for (let d = LAMP_SPACING_M / 2; d < lengthM; d += LAMP_SPACING_M) {
          const t = d / lengthM;
          const i = Math.max(1, f.findIndex((v) => v >= t));
          const s = (t - f[i - 1]!) / Math.max(1e-6, f[i]! - f[i - 1]!);
          const x = pts[i - 1]!.x + (pts[i]!.x - pts[i - 1]!.x) * s;
          const z = pts[i - 1]!.z + (pts[i]!.z - pts[i - 1]!.z) * s;
          lampAt.push(x, (r.bridge ? deckHeight(t, top) : 0) + lampH, z);
        }
      }
      if (!r.bridge) {
        appendMesh(flat, polylineRibbon(pts, width, ROAD_Y), c);
        continue;
      }
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
    const lampGeo = new BufferGeometry();
    lampGeo.setAttribute("position", new BufferAttribute(new Float32Array(lampAt), 3));
    return { ground: toGeometry(flat), decks: toGeometry(deck), piers: pierAt, lamps: lampGeo };
  }, [roads, u, h]);
  useEffect(() => () => {
    ground.dispose();
    decks.dispose();
    lamps.dispose();
  }, [ground, decks, lamps]);
  const glow = useMemo(() => glowTexture(), []);
  useEffect(() => () => glow.dispose(), [glow]);

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
      {night && (
        <points geometry={lamps} raycast={() => null}>
          <pointsMaterial map={glow} size={16 * u} color={LAMP_COLOR} transparent depthWrite={false} blending={AdditiveBlending} toneMapped={false} />
        </points>
      )}
      {piers.length > 0 && (
        <instancedMesh ref={pierRef} args={[pierGeo, undefined, piers.length]} castShadow raycast={() => null}>
          <meshStandardMaterial color="#b3aea4" roughness={0.9} />
        </instancedMesh>
      )}
    </group>
  );
}

/** City and park buildings around the site (context, not insured), merged into one mesh. */
function CityBuildings({ buildings, scene, night }: { buildings: AssetContext["buildings"]; scene: SceneData; night: boolean }) {
  const { h, u } = scene.scale;
  const windows = useMemo(() => {
    const tex = windowTexture();
    tex.repeat.set(1 / (WINDOW_CELL_M * u), 1 / (4 * FLOOR_M * VERTICAL_EXAGGERATION * u));
    return tex;
  }, [u]);
  useEffect(() => () => windows.dispose(), [windows]);
  const geometry = useMemo(() => {
    const parts: BufferGeometry[] = [];
    const c = new Color();
    buildings.forEach((b, i) => {
      if (b.points.length < 4) return;
      const shape = new Shape(b.points.map(([x, y]) => new Vector2(x * WORLD_SCALE, y * WORLD_SCALE)));
      const g = new ExtrudeGeometry(shape, { depth: h(b.height_m), bevelEnabled: false, curveSegments: 1 });
      g.rotateX(-Math.PI / 2);
      // roofs and floors sample the black corner texel, so only the walls carry windows
      const uv = g.getAttribute("uv");
      const caps = g.groups[0];
      if (caps) for (let k = caps.start; k < caps.start + caps.count; k++) uv.setXY(k, 0.02 * WINDOW_CELL_M * u, 0.02 * WINDOW_CELL_M * u);
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
  }, [buildings, h, u]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh geometry={geometry} castShadow receiveShadow raycast={() => null}>
      <meshStandardMaterial vertexColors roughness={0.88} emissiveMap={windows} emissive="#ffffff" emissiveIntensity={night ? 1.3 : 0} />
    </mesh>
  );
}

/** Everything around the circuit that is not insured but makes the site read true: roads, bridges, city. */
export function Surroundings({ context, scene, night }: { context: AssetContext; scene: SceneData; night: boolean }) {
  return (
    <group>
      <Roads roads={context.roads} scene={scene} night={night} />
      <CityBuildings buildings={context.buildings} scene={scene} night={night} />
    </group>
  );
}
