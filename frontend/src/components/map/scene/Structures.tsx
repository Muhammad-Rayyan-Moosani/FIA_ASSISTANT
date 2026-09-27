"use client";

import type { ThreeEvent } from "@react-three/fiber";
import { memo, useEffect, useMemo } from "react";
import { BoxGeometry, BufferAttribute, BufferGeometry, Color, DoubleSide, ExtrudeGeometry, Shape, ShapeUtils, Vector2 } from "three";
import { riskHex } from "@/lib/riskColor";
import { toWorld, WORLD_SCALE, type MeshData, type Vec2 } from "@/lib/trackGeometry";
import type { Asset, AssetCategory } from "@/types/assets";
import type { SceneScale } from "./sceneTypes";
import { useMeshGeometry } from "./useMeshGeometry";

/** Base colours by structure type (as-built look). */
const CATEGORY_COLOR: Record<AssetCategory, string> = {
  grandstand: "#8f979f",
  pit_building: "#e2ddd0",
  paddock: "#d3cab6",
  hospitality: "#ece7dc",
  race_control: "#dcd7cc",
  media: "#d9d4c9",
  medical: "#f2f2f2",
  podium: "#c9a64a",
  building: "#bdb4a4",
  tower: "#9aa2aa",
  bridge: "#a9a49a",
  barrier: "#c8c3b8",
};
const TOWER_SIDE_M = 3;
const BRIDGE_DECK_M = 8;
const BRIDGE_CLEARANCE_M = 5.5;

export interface StructureEvents {
  onHover: (asset: Asset | null, clientX?: number, clientY?: number) => void;
  onSelect: (asset: Asset) => void;
}

function worldPoints(asset: Asset): Vec2[] {
  return asset.points.map(([x, y]) => toWorld(x, y));
}

function extrude(asset: Asset, height: number): BufferGeometry {
  // Shape in (x, y) = (world x, world −z); rotating −90° about X lays it flat and extrudes upwards.
  const shape = new Shape(asset.points.map(([x, y]) => new Vector2(x * WORLD_SCALE, y * WORLD_SCALE)));
  const g = new ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
  g.rotateX(-Math.PI / 2);
  return g;
}

const SEAT_COLOR = new Color("#cdd1d6");
const STAND_FRAME_COLOR = new Color("#8e959c");

/**
 * A grandstand as a raked seating bowl: the roof line rises from the edge nearest the track (30% of the height)
 * to the back (full height), with vertical walls around the footprint. Works for any OSM footprint.
 */
function rakedStand(pts: Vec2[], height: number, track: readonly Vec2[]): BufferGeometry {
  const ring = pts.length > 1 && pts[0]!.x === pts[pts.length - 1]!.x && pts[0]!.z === pts[pts.length - 1]!.z ? pts.slice(0, -1) : pts;
  const dist = ring.map((p) => {
    let best = Infinity;
    for (let i = 0; i < track.length; i += 2) best = Math.min(best, Math.hypot(track[i]!.x - p.x, track[i]!.z - p.z));
    return best;
  });
  const lo = Math.min(...dist);
  const hi = Math.max(...dist);
  const top = dist.map((d) => height * (0.3 + 0.7 * (hi > lo ? (d - lo) / (hi - lo) : 1)));
  const pos: number[] = [];
  const col: number[] = [];
  const put = (x: number, y: number, z: number, c: Color) => {
    pos.push(x, y, z);
    col.push(c.r, c.g, c.b);
  };
  for (const f of ShapeUtils.triangulateShape(ring.map((p) => new Vector2(p.x, -p.z)), [])) {
    for (const k of f) put(ring[k]!.x, top[k]!, ring[k]!.z, SEAT_COLOR);
  }
  ring.forEach((a, i) => {
    const j = (i + 1) % ring.length;
    const b = ring[j]!;
    put(a.x, 0, a.z, STAND_FRAME_COLOR); put(b.x, 0, b.z, STAND_FRAME_COLOR); put(b.x, top[j]!, b.z, STAND_FRAME_COLOR);
    put(a.x, 0, a.z, STAND_FRAME_COLOR); put(b.x, top[j]!, b.z, STAND_FRAME_COLOR); put(a.x, top[i]!, a.z, STAND_FRAME_COLOR);
  });
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute("color", new BufferAttribute(new Float32Array(col), 3));
  g.computeVertexNormals();
  return g;
}

function lineWall(points: Vec2[], height: number, y0 = 0, thickness = 0): MeshData {
  const n = points.length;
  const positions = new Float32Array(n * 6);
  const indices: number[] = [];
  points.forEach((p, i) => {
    const a = points[Math.max(0, i - 1)]!;
    const b = points[Math.min(n - 1, i + 1)]!;
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const ox = (-(b.z - a.z) / len) * thickness;
    const oz = ((b.x - a.x) / len) * thickness;
    positions.set(thickness ? [p.x + ox, y0, p.z + oz, p.x - ox, y0, p.z - oz] : [p.x, y0, p.z, p.x, y0 + height, p.z], i * 6);
    if (i < n - 1) indices.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
  });
  return { positions, indices };
}

interface StructureProps {
  asset: Asset;
  track: readonly Vec2[];
  scale: SceneScale;
  riskOverlay: boolean;
  highlighted: boolean;
  events: StructureEvents;
}

const Structure = memo(function Structure({ asset, track, scale, riskOverlay, highlighted, events }: StructureProps) {
  const height = scale.h(asset.height_m);
  const pts = useMemo(() => worldPoints(asset), [asset]);
  const raked = asset.category === "grandstand" && asset.geometry === "polygon";

  const polyGeo = useMemo(() => {
    if (asset.geometry !== "polygon" || asset.category === "tower") return null;
    return raked ? rakedStand(pts, height, track) : extrude(asset, height);
  }, [asset, height, raked, pts, track]);
  const towerGeo = useMemo(() => {
    if (asset.category !== "tower") return null;
    const side = TOWER_SIDE_M * scale.u;
    return new BoxGeometry(side, height, side).translate(0, height / 2, 0);
  }, [asset.category, height, scale.u]);
  useEffect(() => () => {
    polyGeo?.dispose();
    towerGeo?.dispose();
  }, [polyGeo, towerGeo]);
  const wallData = useMemo(
    () => (asset.category === "barrier" ? lineWall(pts, height) : lineWall(pts, 0, scale.h(BRIDGE_CLEARANCE_M), (BRIDGE_DECK_M / 2) * scale.u)),
    [asset.category, pts, height, scale],
  );
  const wallGeo = useMeshGeometry(wallData);

  const color = useMemo(() => {
    const base = new Color(raked ? "#ffffff" : CATEGORY_COLOR[asset.category]);
    return riskOverlay && asset.exposure_score > 0 ? base.lerp(new Color(riskHex(asset.exposure_score)), 0.25 + (asset.exposure_score / 100) * 0.5) : base;
  }, [asset, riskOverlay, raked]);

  const handlers = {
    onPointerOver: (e: ThreeEvent<PointerEvent>) => {
      e.stopPropagation();
      events.onHover(asset, e.nativeEvent.clientX, e.nativeEvent.clientY);
    },
    onPointerOut: () => events.onHover(null),
    onClick: (e: ThreeEvent<MouseEvent>) => {
      if (e.delta > 5) return;
      e.stopPropagation();
      events.onSelect(asset);
    },
  };
  const material = (
    <meshStandardMaterial
      color={color}
      vertexColors={raked}
      roughness={0.85}
      metalness={asset.category === "tower" ? 0.4 : 0.05}
      emissive={highlighted ? "#d97757" : "#000000"}
      emissiveIntensity={highlighted ? 0.55 : 0}
      side={DoubleSide}
    />
  );

  if (polyGeo) return <mesh geometry={polyGeo} castShadow receiveShadow {...handlers}>{material}</mesh>;
  if (towerGeo) {
    const c = pts.reduce((s, p) => ({ x: s.x + p.x / pts.length, z: s.z + p.z / pts.length }), { x: 0, z: 0 });
    return <mesh geometry={towerGeo} position={[c.x, 0, c.z]} castShadow {...handlers}>{material}</mesh>;
  }
  if (pts.length > 1) return <mesh geometry={wallGeo} castShadow receiveShadow {...handlers}>{material}</mesh>;
  return null;
});

/**
 * Every insured structure at its real position and footprint (OpenStreetMap); temporary F1 grandstands missing
 * from OSM are placed by the corner the official list names (footprint assumed).
 */
export function Structures({ assets, track, scale, riskOverlay, selectedAssetId, hoveredAssetId, events }: {
  assets: Asset[];
  track: readonly Vec2[];
  scale: SceneScale;
  riskOverlay: boolean;
  selectedAssetId: string | null;
  hoveredAssetId: string | null;
  events: StructureEvents;
}) {
  return (
    <group>
      {assets.map((a) => (
        <Structure
          key={a.asset_id}
          asset={a}
          track={track}
          scale={scale}
          riskOverlay={riskOverlay}
          highlighted={a.asset_id === selectedAssetId || a.asset_id === hoveredAssetId}
          events={events}
        />
      ))}
    </group>
  );
}
