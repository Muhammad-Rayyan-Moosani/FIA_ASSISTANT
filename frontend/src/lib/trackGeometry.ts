/**
 * Pure geometry for the 3D twin and 2D map. The normalised OpenF1 outline ([-0.5, 0.5]²)
 * is mapped onto the world XZ plane; Y is up.
 */

export interface Vec2 {
  x: number;
  z: number;
}

export interface TrackFrame {
  points: Vec2[];
  tangents: Vec2[];
  /** Left-hand unit normals in the XZ plane. */
  normals: Vec2[];
}

export interface MeshData {
  positions: Float32Array;
  indices: number[];
}

export const WORLD_SCALE = 110;
export const TRACK_WIDTH = 2.4;
export const WALL_OFFSET = TRACK_WIDTH / 2 + 1.4;

export function buildTrackFrame(outline: readonly (readonly [number, number])[], scale = WORLD_SCALE): TrackFrame {
  const n = outline.length;
  const points = outline.map(([x, y]) => ({ x: x * scale, z: -y * scale }));
  const tangents = points.map((_, i) => {
    const a = points[(i - 1 + n) % n]!;
    const b = points[(i + 1) % n]!;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    return { x: dx / len, z: dz / len };
  });
  const normals = tangents.map((t) => ({ x: -t.z, z: t.x }));
  return { points, tangents, normals };
}

/** Outline index range [a, b] covered by a zone's lap fractions. */
export function zoneIndexRange(startFrac: number, endFrac: number, n: number): [number, number] {
  const a = Math.min(n - 1, Math.max(0, Math.floor(startFrac * n)));
  const b = Math.min(n - 1, Math.ceil(endFrac * n));
  return [a, Math.max(a, b)];
}

/**
 * Which side of the track is the outside of this zone: +1 along the left normal, −1 opposite.
 * Corners: away from the centre of curvature. Straights: away from the circuit centre.
 */
export function outwardSign(frame: TrackFrame, a: number, b: number): 1 | -1 {
  const n = frame.points.length;
  const m = Math.floor((a + b) / 2);
  const k = Math.max(4, Math.floor((b - a) / 2));
  const p = frame.points[m]!;
  const p1 = frame.points[(m - k + n) % n]!;
  const p2 = frame.points[(m + k) % n]!;
  let ix = (p1.x + p2.x) / 2 - p.x;
  let iz = (p1.z + p2.z) / 2 - p.z;
  if (Math.hypot(ix, iz) < 0.8) {
    ix = -p.x;
    iz = -p.z;
  }
  const nm = frame.normals[m]!;
  return nm.x * ix + nm.z * iz > 0 ? -1 : 1;
}

function indexList(a: number, b: number, n: number, closed: boolean): number[] {
  const list: number[] = [];
  for (let i = a; i <= b; i++) list.push(i % n);
  if (closed && list.length > 0) list.push(list[0]!);
  return list;
}

/** A flat ribbon between two lateral offsets (along the left normal) at height y. */
export function stripMesh(frame: TrackFrame, a: number, b: number, offA: number, offB: number, y: number, closed = false): MeshData {
  const list = indexList(a, b, frame.points.length, closed);
  const positions = new Float32Array(list.length * 6);
  const indices: number[] = [];
  list.forEach((i, k) => {
    const p = frame.points[i]!;
    const q = frame.normals[i]!;
    positions.set([p.x + q.x * offA, y, p.z + q.z * offA, p.x + q.x * offB, y, p.z + q.z * offB], k * 6);
    if (k < list.length - 1) {
      const o = k * 2;
      indices.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
    }
  });
  return { positions, indices };
}

/** A vertical wall at a lateral offset on one side of the track. */
export function wallMesh(frame: TrackFrame, a: number, b: number, side: 1 | -1, offset: number, height: number): MeshData {
  const list = indexList(a, b, frame.points.length, false);
  const positions = new Float32Array(list.length * 6);
  const indices: number[] = [];
  list.forEach((i, k) => {
    const p = frame.points[i]!;
    const q = frame.normals[i]!;
    const x = p.x + q.x * offset * side;
    const z = p.z + q.z * offset * side;
    positions.set([x, 0, z, x, height, z], k * 6);
    if (k < list.length - 1) {
      const o = k * 2;
      indices.push(o, o + 2, o + 1, o + 1, o + 2, o + 3);
    }
  });
  return { positions, indices };
}

/** A point `t` (0..1) along a zone, pushed `offset` sideways. */
export function pointAlongZone(frame: TrackFrame, a: number, b: number, t: number, side: 1 | -1, offset: number): Vec2 {
  const i = Math.min(b, Math.max(a, Math.round(a + t * (b - a))));
  const p = frame.points[i]!;
  const q = frame.normals[i]!;
  return { x: p.x + q.x * offset * side, z: p.z + q.z * offset * side };
}

/** Map a normalised outline coordinate to world space (for incident / crash positions). */
export function toWorld(x: number, y: number, scale = WORLD_SCALE): Vec2 {
  return { x: x * scale, z: -y * scale };
}

/** Nearest outline index to a normalised point. */
export function nearestIndex(outline: readonly (readonly [number, number])[], x: number, y: number): number {
  let best = 0;
  let bestD = Infinity;
  outline.forEach(([px, py], i) => {
    const d = (px - x) ** 2 + (py - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

// ----------------------------------------------------------------------------- real-scale helpers
/** World units per metre for a circuit whose normalised unit spans `extentM` metres. */
export const unitsPerMetre = (extentM: number, scale = WORLD_SCALE): number => scale / extentM;

/**
 * Ribbon with per-vertex colours alternating every `stripeM` metres (kerbs).
 * Offsets are along the left normal × side; `unitsPerM` converts the stripe length.
 */
export function stripedStrip(
  frame: TrackFrame,
  a: number,
  b: number,
  side: 1 | -1,
  offIn: number,
  offOut: number,
  y: number,
  stripeUnits: number,
  colors: readonly [readonly [number, number, number], readonly [number, number, number]],
): MeshData & { colors: Float32Array } {
  const pos: number[] = [];
  const col: number[] = [];
  const indices: number[] = [];
  let stripe = 0;
  for (let i = a; i < b; i++) {
    const p0 = frame.points[i]!;
    const p1 = frame.points[i + 1]!;
    const n0 = frame.normals[i]!;
    const n1 = frame.normals[i + 1]!;
    const segLen = Math.hypot(p1.x - p0.x, p1.z - p0.z);
    const steps = Math.max(1, Math.round(segLen / stripeUnits));
    for (let k = 0; k < steps; k++) {
      const t0 = k / steps;
      const t1 = (k + 1) / steps;
      const c = colors[stripe % 2]!;
      const base = pos.length / 3;
      for (const t of [t0, t1]) {
        const px = p0.x + (p1.x - p0.x) * t;
        const pz = p0.z + (p1.z - p0.z) * t;
        const nx = n0.x + (n1.x - n0.x) * t;
        const nz = n0.z + (n1.z - n0.z) * t;
        pos.push(px + nx * side * offIn, y, pz + nz * side * offIn, px + nx * side * offOut, y, pz + nz * side * offOut);
        col.push(...c, ...c);
      }
      indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
      stripe++;
    }
  }
  return { positions: new Float32Array(pos), indices, colors: new Float32Array(col) };
}

/** Even-odd point-in-polygon test in the XZ plane. */
export function insidePolygon(x: number, z: number, poly: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/** Deterministic pseudo-random in [0, 1) from integer coordinates (stable tree placement). */
export function hash01(i: number, j: number): number {
  const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Position and heading at a fractional outline index (wraps around the lap). */
export function sampleAlong(frame: TrackFrame, f: number, lateral = 0): { x: number; z: number; heading: number } {
  const n = frame.points.length;
  const i = ((Math.floor(f) % n) + n) % n;
  const j = (i + 1) % n;
  const t = f - Math.floor(f);
  const p = frame.points[i]!;
  const q = frame.points[j]!;
  const nm = frame.normals[i]!;
  const tg = frame.tangents[i]!;
  return {
    x: p.x + (q.x - p.x) * t + nm.x * lateral,
    z: p.z + (q.z - p.z) * t + nm.z * lateral,
    heading: Math.atan2(tg.x, tg.z),
  };
}

/**
 * Open polyline -> ribbon of a given width (roads, pit lane, old raceways). `y` may vary per vertex
 * (bridge decks ramping up from the banks).
 */
export function polylineRibbon(points: readonly Vec2[], width: number, y: number | ((i: number, n: number) => number)): MeshData {
  const n = points.length;
  const positions = new Float32Array(n * 6);
  const indices: number[] = [];
  points.forEach((p, i) => {
    const a = points[Math.max(0, i - 1)]!;
    const b = points[Math.min(n - 1, i + 1)]!;
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const nx = -(b.z - a.z) / len;
    const nz = (b.x - a.x) / len;
    const yy = typeof y === "number" ? y : y(i, n);
    positions.set([p.x + (nx * width) / 2, yy, p.z + (nz * width) / 2, p.x - (nx * width) / 2, yy, p.z - (nz * width) / 2], i * 6);
    if (i < n - 1) indices.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
  });
  return { positions, indices };
}

/** Cumulative length along a polyline, normalised to 0..1 (for ramps and spacing along it). */
export function polylineFractions(points: readonly Vec2[]): number[] {
  const d = [0];
  for (let i = 1; i < points.length; i++) d.push(d[i - 1]! + Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.z - points[i - 1]!.z));
  const total = d[d.length - 1] || 1;
  return d.map((v) => v / total);
}

/**
 * A ribbon across several lateral offsets (along the left normal) with a per-row alpha: RGBA vertex colours
 * (white, alpha from `alphas`) for glow bands tinted by the material colour. Alpha tapers to 0 over `taper`
 * points at each end so neighbouring zones blend instead of cutting hard.
 */
export function gradientStrip(frame: TrackFrame, a: number, b: number, offsets: readonly number[], alphas: readonly number[], y: number, taper = 3): MeshData & { colors: Float32Array } {
  const list = indexList(a, b, frame.points.length, false);
  const rows = offsets.length;
  const positions = new Float32Array(list.length * rows * 3);
  const colors = new Float32Array(list.length * rows * 4);
  const indices: number[] = [];
  list.forEach((i, k) => {
    const p = frame.points[i]!;
    const q = frame.normals[i]!;
    const end = Math.min(1, (Math.min(k, list.length - 1 - k) + 0.5) / Math.max(1, taper));
    offsets.forEach((off, r) => {
      const v = k * rows + r;
      positions.set([p.x + q.x * off, y, p.z + q.z * off], v * 3);
      colors.set([1, 1, 1, alphas[r]! * end], v * 4);
    });
    if (k < list.length - 1) {
      for (let r = 0; r < rows - 1; r++) {
        const o = k * rows + r;
        indices.push(o, o + 1, o + rows, o + 1, o + rows + 1, o + rows);
      }
    }
  });
  return { positions, indices, colors };
}

/** A thin flat line straight across the track at outline index `i`, from lateral offset `from` to `to`. */
export function crossLine(frame: TrackFrame, i: number, from: number, to: number, width: number, y: number): MeshData {
  const p = frame.points[i]!;
  const q = frame.normals[i]!;
  const t = frame.tangents[i]!;
  const w = width / 2;
  const at = (off: number, s: number) => [p.x + q.x * off + t.x * s, y, p.z + q.z * off + t.z * s];
  return { positions: new Float32Array([...at(from, -w), ...at(from, w), ...at(to, -w), ...at(to, w)]), indices: [0, 2, 1, 1, 2, 3] };
}
