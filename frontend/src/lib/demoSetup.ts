import type { DemoSetup, Pt, Runoff } from "./demoPhysics";

/** What the demo needs to know about one zone of the drawn track. */
export interface DemoZoneInput {
  zoneId: string;
  /** Outline index range of the zone. */
  range: [number, number];
  /** Outside of the corner: +1 along the left normal, −1 opposite. */
  side: 1 | -1;
  /** Barrier face distance from the drawn centre line, world units. */
  barrierOffset: number;
  runoff: Runoff;
  apexKph: number;
}

/**
 * The demo corner: the slowest corner of the lap (Montreal: the Hairpin; Monza: the Rettifilo). Heavy braking
 * from top speed into a tight apex is exactly where standing water catches a car out.
 */
export function pickDemoZone<T extends { apexKph: number; range: [number, number] }>(zones: readonly T[]): T | null {
  const corners = zones.filter((z) => z.range[1] - z.range[0] >= 3);
  return corners.reduce<T | null>((best, z) => (!best || z.apexKph < best.apexKph ? z : best), null);
}

/**
 * Physics setup from the drawn track: the centre line in real metres (world ÷ units-per-metre) and the barrier at
 * its real distance. The asphalt is drawn 3× wide but run-off is drawn at real depth beyond the drawn edge, so the
 * barrier sits `realHalf + (barrierOffset − drawnHalf) / u` metres from the real centre line.
 */
export function demoSetup(points: readonly Pt[], u: number, drawnHalf: number, realHalfM: number, zone: DemoZoneInput): DemoSetup {
  const centre = points.map((p) => ({ x: p.x / u, z: p.z / u }));
  const [a, b] = zone.range;
  // apex: the point of sharpest turning inside the zone
  let apex = a, best = 0;
  for (let i = Math.max(1, a + 1); i < Math.min(centre.length - 1, b - 1); i++) {
    const p0 = centre[i - 1]!, p1 = centre[i]!, p2 = centre[i + 1]!;
    const turn = (p1.x - p0.x) * (p2.z - p1.z) - (p1.z - p0.z) * (p2.x - p1.x);
    if (Math.abs(turn) > Math.abs(best)) { best = turn; apex = i; }
  }
  return {
    centre,
    apexIndex: apex,
    side: zone.side,
    barrierM: realHalfM + (zone.barrierOffset - drawnHalf) / u,
    barrierRange: [a, b],
    runoff: zone.runoff,
  };
}
