"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import { BufferAttribute, BufferGeometry, DoubleSide, type Group, Mesh, MeshStandardMaterial } from "three";
import { type CarTelemetry, type DemoEvent, TRACK_HALF_M, WATER_INNER_M, WetHairpinSim } from "@/lib/demoPhysics";
import { demoSetup, pickDemoZone, type DemoZoneInput } from "@/lib/demoSetup";
import { WORLD_SCALE } from "@/lib/trackGeometry";
import { mapEffects } from "@/store/crashBus";
import { demoBus, useDemoStore } from "@/store/demoStore";
import { replayPositions } from "@/store/replayBus";
import type { DemoEventPayload } from "@/types/raceControl";
import { carParts, createCar, disposeCar } from "./carModel";
import { CAR_SCALE, DRAWN_TRACK_WIDTH_M, type SceneData } from "./sceneTypes";

const LIVERY = { A: "#e8002d", B: "#27f4d2" } as const;
const DRAWN_HALF_M = DRAWN_TRACK_WIDTH_M / 2;
const REAL_CAR_HALF_W = 1;
const TELEMETRY_HZ = 8;
const EFFECT_EVERY_S = 0.045;
const END_AFTER_PASS_S = 5;
const MAX_RUN_S = 60;
/** After passing the wreck, car B drives off down the straight for this long, then leaves the scene (the demo is
 * about one corner; the rest of the lap is not part of it). */
const DRIVE_OFF_S = 12;
/** Report the impact once the barrier has taken the load for this long, so it carries the measured peak g. */
const IMPACT_REPORT_S = 0.3;
const kph = (ms: number) => Math.round(ms * 3.6);

/**
 * Where to draw a real lateral offset. The asphalt is drawn 3× wide, so on it offsets scale ×3. Beyond the edge the
 * run-off is drawn at its real depth, but the car is drawn ×6, so the run-off is compressed just enough that the
 * drawn car's flank reaches the barrier exactly when the real car's does.
 */
function lateralMap(barrierM: number) {
  const real = Math.max(1, barrierM - REAL_CAR_HALF_W - TRACK_HALF_M);
  const drawn = Math.max(1, barrierM - TRACK_HALF_M - CAR_SCALE * REAL_CAR_HALF_W);
  const beyond = drawn / real;
  const edge = DRAWN_HALF_M / TRACK_HALF_M;
  return {
    at(lat: number): number {
      const a = Math.abs(lat);
      return Math.sign(lat) * (a <= TRACK_HALF_M ? a * edge : DRAWN_HALF_M + (a - TRACK_HALF_M) * beyond);
    },
    /** How much to stretch the heading on the asphalt (as its width is), easing to the true heading off it. */
    slope(lat: number): number {
      const w = Math.min(1, Math.max(0, (Math.abs(lat) - (TRACK_HALF_M - 1.5)) / 3));
      return edge + (1 - edge) * w;
    },
  };
}

interface DrawnCar {
  car: Group;
  lastFx: number;
  /** 0 → 1 once spinning: the drawn heading turns into the true heading so the spin rotates evenly. */
  spin: number;
}

/**
 * The wet-hairpin demo on the 3D twin: two simulated cars (lib/demoPhysics.ts) driven at 240 Hz, the standing-water
 * patch in the braking zone, spray, tyre smoke, run-off dust and the barrier impact. Every physics event goes to
 * race control over the demo bus; car B only reacts once race control's warning reaches it (demoStore.warned).
 */
class DemoLayer {
  private sim: WetHairpinSim | null = null;
  private cars: { A: DrawnCar; B: DrawnCar } | null = null;
  private water: Mesh | null = null;
  private readonly waterMat = new MeshStandardMaterial({
    color: "#6d8aa3", roughness: 0.04, metalness: 0.85, transparent: true, opacity: 0.72, side: DoubleSide, depthWrite: false,
  });
  private readonly zone: DemoZoneInput | null;
  private runId = 0;
  private telemetryAt = 0;
  private tickAt = 0;
  private passedAt: number | null = null;
  private ended = false;
  private offSpeed = 0;
  private impact: { t: number; speed: number; impactSpeed: number; peakG: number } | null = null;
  private readonly map: ReturnType<typeof lateralMap>;

  constructor(private readonly group: Group, private readonly scene: SceneData) {
    this.zone = pickDemoZone(
      scene.zones.map((z) => ({
        zoneId: z.view.zone.zone_id, range: z.range, side: z.side, barrierOffset: z.barrierOffset,
        runoff: z.view.zone.runoff_type, apexKph: z.view.zone.v_apex_kph,
      })),
    );
    const { u, trackHalf } = scene.scale;
    this.map = lateralMap(this.zone ? TRACK_HALF_M + (this.zone.barrierOffset - trackHalf) / u : 30);
  }

  // ------------------------------------------------------------------ lifecycle
  sync(): void {
    const s = useDemoStore.getState();
    if (s.phase === "idle" && this.sim) this.clear();
    if (s.phase === "starting" && s.runId !== this.runId && this.zone) this.start(s.runId);
  }

  private start(runId: number): void {
    this.clear();
    const zone = this.zone!;
    const { u, trackHalf } = this.scene.scale;
    const setup = demoSetup(this.scene.frame.points, u, trackHalf, TRACK_HALF_M, zone);
    const sim = new WetHairpinSim(setup);
    this.sim = sim;
    this.runId = runId;
    this.passedAt = null;
    this.ended = false;
    this.impact = null;
    this.telemetryAt = this.tickAt = 0;
    const scale = u * CAR_SCALE;
    this.cars = {
      A: { car: createCar(LIVERY.A, scale), lastFx: 0, spin: 0 },
      B: { car: createCar(LIVERY.B, scale), lastFx: 0, spin: 0 },
    };
    this.group.add(this.cars.A.car, this.cars.B.car);
    this.water = this.buildWater(sim);
    this.group.add(this.water);
    const apex = setup.centre[setup.apexIndex]!;
    demoBus.emit({
      kind: "start",
      body: { zone_id: zone.zoneId, x: (apex.x * u) / WORLD_SCALE, y: (-apex.z * u) / WORLD_SCALE, lap_frac: setup.apexIndex / setup.centre.length },
    });
    useDemoStore.getState().setPhase("running");
  }

  private clear(): void {
    if (this.cars) {
      for (const c of [this.cars.A, this.cars.B]) {
        this.group.remove(c.car);
        disposeCar(c.car);
      }
    }
    if (this.water) {
      this.group.remove(this.water);
      this.water.geometry.dispose();
    }
    replayPositions.delete("A");
    replayPositions.delete("B");
    this.sim = null;
    this.cars = null;
    this.water = null;
  }

  dispose(): void {
    this.clear();
    this.waterMat.dispose();
  }

  // ------------------------------------------------------------------ frame
  tick(dt: number, clock: number): void {
    this.sync();
    const sim = this.sim;
    if (!sim || !this.cars) return;
    const store = useDemoStore.getState();
    if (store.warned && !sim.warned) sim.warn();
    const gone = this.passedAt !== null && sim.t - this.passedAt > DRIVE_OFF_S;
    if (sim.t < MAX_RUN_S && !gone) for (const e of sim.step(dt)) this.onEvent(sim, e);

    const telA = sim.telemetry("A");
    const telB = sim.telemetry("B");
    if (gone && this.cars.B.car.visible) {
      this.cars.B.car.visible = false;
      replayPositions.delete("B");
    }
    if (this.impact) {
      this.impact.peakG = Math.max(this.impact.peakG, Math.hypot(telA.longG, telA.latG));
      if (sim.t - this.impact.t >= IMPACT_REPORT_S) this.reportImpact();
    }
    this.pose(sim, this.cars.A, telA, clock);
    if (!gone) this.pose(sim, this.cars.B, telB, clock);

    if (!gone && sim.t - this.telemetryAt >= 1 / TELEMETRY_HZ) {
      this.telemetryAt = sim.t;
      store.setTelemetry(sim.t, telA, telB);
    }
    if (sim.t - this.tickAt >= 1 && this.passedAt === null) {
      this.tickAt = sim.t;
      this.send({ kind: "tick", t: sim.t, distance_m: this.gap(sim, telB, telA) });
    }
    if (!this.ended && this.passedAt !== null && sim.t - this.passedAt > END_AFTER_PASS_S) {
      this.ended = true;
      this.send({ kind: "end", t: sim.t });
      store.setPhase("ended");
    }
  }

  private toWater(sim: WetHairpinSim, s: number): number {
    return Math.max(0, Math.round(sim.toApex(s) - sim.toApex(sim.waterRange[0])));
  }

  private reportImpact(): void {
    const i = this.impact;
    if (!i) return;
    this.impact = null;
    this.send({ kind: "impact", t: i.t, speed_kph: kph(i.speed), impact_speed_kph: kph(i.impactSpeed),
      entry_speed_kph: kph(this.offSpeed || i.impactSpeed), peak_g: Math.round(i.peakG) });
  }

  /** How far car B is behind car A (the incident), along the lap. */
  private gap(sim: WetHairpinSim, b: CarTelemetry, a: CarTelemetry): number {
    return Math.max(0, Math.round(sim.toApex(b.s) - sim.toApex(a.s)));
  }

  private send(body: DemoEventPayload): void {
    demoBus.emit({ kind: "event", body });
  }

  private onEvent(sim: WetHairpinSim, e: DemoEvent): void {
    const tel = e.telemetry;
    const B = sim.telemetry("B");
    switch (e.kind) {
      case "slip":
        this.send({ kind: "slip", t: e.t, speed_kph: kph(tel.speed), measured_g: +e.measuredDecelG.toFixed(2), expected_g: +e.expectedDecelG.toFixed(2),
          distance_m: this.gap(sim, B, tel), b_speed_kph: kph(B.speed) });
        break;
      case "spin":
        this.send({ kind: "spin", t: e.t, speed_kph: kph(tel.speed), slide_deg: Math.round(Math.abs(tel.slide) * 57.3) });
        break;
      case "off":
        this.offSpeed = tel.speed;
        this.send({ kind: "off", t: e.t, speed_kph: kph(tel.speed) });
        break;
      case "impact": {
        this.impact = { t: e.t, speed: tel.speed, impactSpeed: e.impactSpeed, peakG: 0 };
        const p = this.world(sim, tel);
        mapEffects.emit({ kind: "impact", x: p.x / WORLD_SCALE, y: -p.z / WORLD_SCALE, zoneId: this.zone!.zoneId, severe: true, exact: true });
        break;
      }
      case "stopped":
        this.reportImpact();
        this.send({ kind: "stopped", t: e.t, peak_g: Math.round(e.peakG) });
        break;
      case "reacted":
        this.send({ kind: "reacted", t: e.t, speed_kph: kph(tel.speed), distance_m: this.toWater(sim, tel.s) });
        break;
      case "passed":
        this.passedAt = e.t;
        this.send({ kind: "passed", t: e.t, speed_kph: kph(tel.speed), min_speed_kph: kph(e.minSpeed) });
        useDemoStore.getState().setPhase("passed");
        break;
    }
  }

  /** World position of a car: along the centre line, then its lateral offset mapped onto the widened drawn track. */
  private world(sim: WetHairpinSim, tel: CarTelemetry): { x: number; z: number; rel: number } {
    const st = sim.station(tel.s);
    const dx = tel.x - st.p.x;
    const dz = tel.z - st.p.z;
    const along = dx * st.t.x + dz * st.t.z;
    const lat = dx * st.n.x + dz * st.n.z;
    const off = this.map.at(lat);
    const u = this.scene.scale.u;
    return { x: (st.p.x + st.t.x * along + st.n.x * off) * u, z: (st.p.z + st.t.z * along + st.n.z * off) * u, rel: lat };
  }

  private pose(sim: WetHairpinSim, drawn: DrawnCar, tel: CarTelemetry, clock: number): void {
    const p = this.world(sim, tel);
    const st = sim.station(tel.s);
    // heading relative to the track, stretched like the lateral offsets so the nose follows the drawn path
    const trackYaw = Math.atan2(st.t.x, st.t.z);
    const rel = Math.atan2(Math.sin(tel.yaw - trackYaw), Math.cos(tel.yaw - trackYaw));
    drawn.spin += ((tel.spinning ? 1 : 0) - drawn.spin) * Math.min(1, (1 / 60) * 4);
    const k = this.map.slope(p.rel) * (1 - drawn.spin) + drawn.spin;
    const yaw = trackYaw + Math.atan2(k * Math.sin(rel), Math.cos(rel));
    const car = drawn.car;
    car.position.set(p.x, 0.02, p.z);
    car.rotation.y = yaw;
    const parts = carParts(car);
    parts.wheels.forEach((w) => (w.rotation.x = tel.frontLocked && parts.front.includes(w) ? w.rotation.x : tel.wheelSpin));
    parts.front.forEach((w) => (w.rotation.y = -tel.steer));
    parts.body.rotation.z = Math.max(-0.08, Math.min(0.08, tel.latG * 0.022));        // roll into the corner
    parts.body.rotation.x = Math.max(-0.05, Math.min(0.05, tel.longG * 0.012));       // dive under braking
    const flash = Math.sin(clock * 25) > 0 ? 4 : 0.4;                                 // wet-weather rain light
    parts.rainLight.color.setRGB(flash, flash * 0.08, flash * 0.1);
    replayPositions.set(tel.id, { x: p.x, z: p.z, yaw, speed: kph(tel.speed) });

    // spray off standing water, smoke off locked tyres, dust in the run-off
    if (sim.t - drawn.lastFx >= EFFECT_EVERY_S && tel.speed > 8 && !tel.inBarrier) {
      const spray = tel.surface === "water" && tel.speed > 15;
      const smoke = tel.frontLocked || tel.rearLocked;
      const dust = tel.surface === "runoff";
      if (spray || smoke || dust) {
        drawn.lastFx = sim.t;
        mapEffects.emit({ kind: "smoke", x: p.x / WORLD_SCALE, y: -p.z / WORLD_SCALE, dust: dust && !spray });
      }
    }
  }

  /** The standing water, exactly where the physics has it: from the outside edge across to WATER_INNER_M past the
   * centre line. Reflective like the real thing; the inner edge is a little ragged (drawn only, ±0.3 m). */
  private buildWater(sim: WetHairpinSim): Mesh {
    const [s0] = sim.waterRange;
    const len = ((sim.waterRange[1] - s0) % sim.lapLength + sim.lapLength) % sim.lapLength;
    const u = this.scene.scale.u;
    const side = this.zone!.side;
    const pos: number[] = [];
    const idx: number[] = [];
    const steps = Math.max(2, Math.round(len / 2));
    for (let i = 0; i <= steps; i++) {
      const s = s0 + (len * i) / steps;
      const st = sim.station(s);
      const outer = side * this.map.at(side * TRACK_HALF_M) * 0.99;
      const inner = this.map.at(-side * (WATER_INNER_M + 0.3 * Math.sin(i * 0.9) * Math.sin(i * 0.37)));
      pos.push((st.p.x + st.n.x * outer) * u, 0.03, (st.p.z + st.n.z * outer) * u);
      pos.push((st.p.x + st.n.x * inner) * u, 0.03, (st.p.z + st.n.z * inner) * u);
      if (i > 0) {
        const a = 2 * (i - 1);
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new Mesh(geo, this.waterMat);
    mesh.renderOrder = 2;
    mesh.raycast = () => null;
    return mesh;
  }
}

/** The wet-hairpin demo layer (idle until the Demo button starts a run). */
export function DemoCars({ scene }: { scene: SceneData }) {
  const groupRef = useRef<Group>(null);
  const layerRef = useRef<DemoLayer | null>(null);

  useEffect(() => {
    if (!groupRef.current) return;
    const layer = new DemoLayer(groupRef.current, scene);
    layerRef.current = layer;
    return () => {
      layer.dispose();
      layerRef.current = null;
    };
  }, [scene]);

  useFrame(({ clock }, dt) => layerRef.current?.tick(Math.min(dt, 0.1), clock.elapsedTime));
  return <group ref={groupRef} />;
}
