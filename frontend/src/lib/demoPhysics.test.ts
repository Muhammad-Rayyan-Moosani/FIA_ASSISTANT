import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type DemoEvent, type Pt, visualLateral, WetHairpinSim } from "./demoPhysics";
import { demoSetup } from "./demoSetup";

/** A circuit as the 3D scene sees it: world points, units per metre and the demo zone with its barrier. */
function circuit(id: "montreal" | "monza", runoffM: number) {
  const track = JSON.parse(readFileSync(fileURLToPath(new URL(`../../../data/tracks/${id}.json`, import.meta.url)), "utf8"));
  const raw: [number, number][] = track.outline;
  let per = 0;
  for (let i = 0; i < raw.length; i++) per += Math.hypot(raw[(i + 1) % raw.length]![0] - raw[i]![0], raw[(i + 1) % raw.length]![1] - raw[i]![1]);
  const u = 110 / (track.length_m / per);
  const points: Pt[] = raw.map(([x, y]) => ({ x: x * 110, z: -y * 110 }));
  const zone = track.zones.find((z: { v_apex_kph: number }) => z.v_apex_kph === Math.min(...track.zones.map((q: { v_apex_kph: number }) => q.v_apex_kph)));
  const range: [number, number] = [Math.floor(zone.start_frac * raw.length), Math.ceil(zone.end_frac * raw.length)];
  // outside: away from the turn at the sharpest point
  const probe = demoSetup(points, u, 21 * u, 7, { zoneId: zone.zone_id, range, side: 1, barrierOffset: 0, runoff: "asphalt", apexKph: 0 });
  const c = probe.centre, i = probe.apexIndex;
  const turn = (c[i]!.x - c[i - 1]!.x) * (c[i + 1]!.z - c[i]!.z) - (c[i]!.z - c[i - 1]!.z) * (c[i + 1]!.x - c[i]!.x);
  return demoSetup(points, u, 21 * u, 7, {
    zoneId: zone.zone_id, range, side: turn > 0 ? -1 : 1, barrierOffset: (21 + runoffM) * u, runoff: zone.runoff_type, apexKph: zone.v_apex_kph,
  });
}
const montreal = () => circuit("montreal", 16);

function run(warn: boolean, seconds = 26, setup = montreal()) {
  const sim = new WetHairpinSim(setup);
  const events: DemoEvent[] = [];
  let maxYawStep = 0;
  let prevYaw = sim.cars.B.yaw;
  for (let f = 0; f < seconds * 60; f++) {
    const ev = sim.step(1 / 60);
    events.push(...ev);
    if (warn && ev.some((e) => e.kind === "slip")) sim.warn();
    const dy = Math.abs(Math.atan2(Math.sin(sim.cars.B.yaw - prevYaw), Math.cos(sim.cars.B.yaw - prevYaw)));
    maxYawStep = Math.max(maxYawStep, dy);
    prevYaw = sim.cars.B.yaw;
  }
  return { sim, events, maxYawStep };
}

describe("wet hairpin demo physics", () => {
  it("car A aquaplanes under braking, runs off and hits the barrier; warned car B slows and gets through", () => {
    const { sim, events, maxYawStep } = run(true, 34);
    const has = (car: string, kind: string) => events.some((e) => e.car === car && e.kind === kind);
    expect(has("A", "slip") && has("A", "off") && has("A", "impact") && has("A", "stopped")).toBe(true);
    expect(has("B", "reacted") && has("B", "passed")).toBe(true);
    // A snaps sideways in the water and goes into the fence sliding, not nose first
    const spin = events.find((e) => e.car === "A" && e.kind === "spin")!;
    const impact = events.find((e) => e.car === "A" && e.kind === "impact")!;
    expect(spin.t).toBeLessThan(impact.t);
    expect(Math.abs(impact.telemetry.slide)).toBeGreaterThan(Math.PI / 4);
    expect(sim.cars.B.spun).toBe(false);
    expect(sim.cars.B.inBarrier).toBe(false);
    expect(Math.abs(sim.cars.B.lateral)).toBeLessThan(7);      // still on the asphalt, accelerating away down the straight
    expect(maxYawStep).toBeLessThan(0.08);                       // smooth: no heading jumps frame to frame
  });

  it("without the warning, car B would crash too (so the message is what saves it)", () => {
    const { events } = run(false);
    expect(events.some((e) => e.car === "B" && e.kind === "passed")).toBe(false);
  });

  it("crashes into the barrier whatever the drawn run-off depth", () => {
    for (const runoff of [8, 16, 30]) {
      const { events } = run(true, 12, circuit("montreal", runoff));
      expect(events.some((e) => e.car === "A" && e.kind === "impact")).toBe(true);
    }
  });

  it("maps lateral offsets onto the widened drawn track", () => {
    expect(visualLateral(7, 21)).toBeCloseTo(21);
    expect(visualLateral(-3.5, 21)).toBeCloseTo(-10.5);
    expect(visualLateral(12, 21)).toBeCloseTo(26);
  });
});
