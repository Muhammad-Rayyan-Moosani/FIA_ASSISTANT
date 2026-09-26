import { describe, expect, it } from "vitest";
import { buildTrackFrame, hash01, insidePolygon, nearestIndex, outwardSign, sampleAlong, stripMesh, stripedStrip, unitsPerMetre, wallMesh, zoneIndexRange } from "./trackGeometry";

/** A counter-clockwise circle of radius 0.5 in the normalised plane. */
const circle = Array.from({ length: 120 }, (_, i) => {
  const a = (i / 120) * Math.PI * 2;
  return [0.5 * Math.cos(a), 0.5 * Math.sin(a)] as [number, number];
});

describe("trackGeometry", () => {
  const frame = buildTrackFrame(circle, 100);

  it("produces unit tangents and perpendicular normals", () => {
    frame.tangents.forEach((t, i) => {
      const n = frame.normals[i]!;
      expect(Math.hypot(t.x, t.z)).toBeCloseTo(1, 6);
      expect(t.x * n.x + t.z * n.z).toBeCloseTo(0, 6);
    });
  });

  it("maps lap fractions to outline indices", () => {
    expect(zoneIndexRange(0, 0.1, 120)).toEqual([0, 12]);
    expect(zoneIndexRange(0.95, 1, 120)).toEqual([114, 119]);
  });

  it("puts barriers on the outside of a corner", () => {
    const [a, b] = zoneIndexRange(0.2, 0.3, 120);
    const side = outwardSign(frame, a, b);
    const m = Math.floor((a + b) / 2);
    const p = frame.points[m]!;
    const n = frame.normals[m]!;
    const outside = { x: p.x + n.x * side * 5, z: p.z + n.z * side * 5 };
    expect(Math.hypot(outside.x, outside.z)).toBeGreaterThan(Math.hypot(p.x, p.z));
  });

  it("builds indexed strips and walls", () => {
    const strip = stripMesh(frame, 0, 119, 1, -1, 0, true);
    expect(strip.positions.length).toBe(121 * 6);
    expect(strip.indices.length).toBe(120 * 6);
    const wall = wallMesh(frame, 10, 20, 1, 2, 1.1);
    expect(wall.positions.length).toBe(11 * 6);
    expect(wall.indices.length).toBe(10 * 6);
  });

  it("finds the nearest outline point", () => {
    expect(nearestIndex(circle, 0.5, 0)).toBe(0);
    expect(nearestIndex(circle, 0, 0.5)).toBe(30);
  });
});

describe("real-scale helpers", () => {
  const frame = buildTrackFrame(circle, 100);
  it("converts metres to world units", () => expect(unitsPerMetre(2000)).toBeCloseTo(0.055, 3));
  it("tests points inside polygons", () => {
    const square = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }];
    expect(insidePolygon(5, 5, square)).toBe(true);
    expect(insidePolygon(15, 5, square)).toBe(false);
  });
  it("hash01 is deterministic and in range", () => {
    expect(hash01(3, 4)).toBe(hash01(3, 4));
    expect(hash01(3, 4)).toBeGreaterThanOrEqual(0);
    expect(hash01(3, 4)).toBeLessThan(1);
  });
  it("samples along the lap and wraps", () => {
    const a = sampleAlong(frame, 0);
    const b = sampleAlong(frame, frame.points.length);
    expect(b.x).toBeCloseTo(a.x, 6);
  });
  it("builds striped kerbs with colours per vertex", () => {
    const k = stripedStrip(frame, 10, 20, 1, 1, 2, 0, 1, [[1, 0, 0], [1, 1, 1]] as const);
    expect(k.colors.length).toBe(k.positions.length);
    expect(k.indices.length % 6).toBe(0);
  });
});
