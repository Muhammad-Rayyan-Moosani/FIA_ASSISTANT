"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import type { Group } from "three";
import { sampleAlong } from "@/lib/trackGeometry";
import { carParts, createCar, disposeCar, LIVERIES, WHEEL_RADIUS_M, type CarParts } from "./carModel";
import { CAR_SCALE, type SceneData } from "./sceneTypes";

const CARS = 10;
const ACCEL = 13;             // m/s², traction-limited acceleration out of corners
const BRAKE = 42;             // m/s², peak braking
const FOLLOW_GAP_M = 38;      // start reacting to the car ahead
const MIN_GAP_M = 22;
const LATERAL_SPEED = 9;      // m/s, how fast a car changes line
const MAX_SPIN = 28;          // rad/s shown on the wheels (faster reads as strobing)
const G = 9.81;

/** Signed curvature per outline point (1/m, + = turning towards the left normal), lightly smoothed. */
function curvature(scene: SceneData, segM: number): number[] {
  const { tangents } = scene.frame;
  const n = tangents.length;
  const raw = tangents.map((_, i) => {
    const a = tangents[(i - 1 + n) % n]!;
    const b = tangents[(i + 1) % n]!;
    return (a.x * b.z - a.z * b.x) / (2 * segM);
  });
  return smooth(raw, 2);
}

function smooth(v: number[], k: number): number[] {
  const n = v.length;
  return v.map((_, i) => {
    let s = 0;
    for (let j = -k; j <= k; j++) s += v[(i + j + n) % n]!;
    return s / (2 * k + 1);
  });
}

/**
 * The racing line as a lateral offset (world units): outside on the way in, clipping the inside at the apex,
 * running out wide on the exit. Built from the real track curvature, not hand-placed.
 */
function racingLine(kappa: number[], half: number, segM: number): number[] {
  const n = kappa.length;
  const ref = [...kappa].map(Math.abs).sort((a, b) => a - b)[Math.floor(n * 0.92)] || 1e-3;
  const g = smooth(kappa.map((k) => Math.max(-1, Math.min(1, k / ref))), Math.max(2, Math.round(60 / segM)));
  const look = Math.max(4, Math.round(110 / segM));
  const line = g.map((gi, i) => {
    const around = (g[(i + look) % n]! + g[(i - look + n) % n]!) * (1 - Math.abs(gi));
    return Math.max(-0.78, Math.min(0.78, 0.66 * gi - 0.42 * around)) * half;
  });
  return smooth(line, Math.max(2, Math.round(40 / segM)));
}

interface Racer {
  car: Group;
  parts: CarParts;
  f: number;          // fractional outline index
  v: number;          // m/s
  w: number;          // lateral offset, world units
  pass: number;       // extra lateral offset while overtaking
  passT: number;
  pace: number;
  yaw: number;
  x: number;
  z: number;
  spin: number;
  accel: number;
}

/** A field of cars lapping at the real reference-lap speed, each on the racing line, following and overtaking. */
class TrafficSim {
  private readonly racers: Racer[];
  private readonly segM: number;
  private readonly kappa: number[];
  private readonly line: number[];
  private clock = 0;

  constructor(private readonly group: Group, private readonly scene: SceneData) {
    const n = scene.frame.points.length;
    this.segM = scene.lengthM / n;
    this.kappa = curvature(scene, this.segM);
    this.line = racingLine(this.kappa, scene.scale.trackHalf, this.segM);
    this.racers = Array.from({ length: CARS }, (_, i) => {
      const car = createCar(LIVERIES[i % LIVERIES.length]!, scene.scale.u * CAR_SCALE);
      group.add(car);
      const f = ((1 - i / CARS) * n + (i % 3) * 0.6) % n;
      return {
        car, parts: carParts(car), f, v: this.speedAt(f) * 0.9, w: this.line[Math.floor(f)]!, pass: 0, passT: 0,
        pace: 1 - i * 0.0035, yaw: 0, x: 0, z: 0, spin: 0, accel: 0,
      };
    });
  }

  private speedAt(f: number): number {
    const n = this.scene.speedKph.length;
    const i = Math.floor(f) % n;
    const t = f - Math.floor(f);
    const a = this.scene.speedKph[i] ?? 200;
    const b = this.scene.speedKph[(i + 1) % n] ?? a;
    return (a + (b - a) * t) / 3.6;
  }

  private ahead(i: number): { r: Racer; gapM: number } | null {
    const n = this.scene.frame.points.length;
    const me = this.racers[i]!;
    let best: { r: Racer; gapM: number } | null = null;
    for (let j = 0; j < this.racers.length; j++) {
      if (j === i) continue;
      const o = this.racers[j]!;
      const gapM = ((((o.f - me.f) % n) + n) % n) * this.segM;
      if (!best || gapM < best.gapM) best = { r: o, gapM };
    }
    return best;
  }

  tick(rawDt: number, night: boolean): void {
    const dt = Math.min(rawDt, 0.05);
    this.clock += dt;
    const n = this.scene.frame.points.length;
    const { u, trackHalf } = this.scene.scale;
    const carWidth = 2 * CAR_SCALE * u;
    this.racers.forEach((r, i) => {
      // longitudinal: chase the reference speed with traction / braking limits, back off behind a slower car
      let target = this.speedAt(r.f + 1.5) * r.pace;
      const front = this.ahead(i);
      if (front && front.gapM < FOLLOW_GAP_M && Math.abs(front.r.w - r.w) < carWidth * 1.3) {
        target = Math.min(target, front.r.v + (front.gapM - MIN_GAP_M) * 0.6);
        if (r.passT <= 0 && front.gapM < FOLLOW_GAP_M * 0.8) {
          // pull out to the side with more room and try a pass
          const room = front.r.w >= 0 ? -1 : 1;
          r.pass = room * trackHalf * 0.55;
          r.passT = 3.5;
        }
      }
      const prevV = r.v;
      r.v += Math.max(-BRAKE * dt, Math.min(ACCEL * dt, target - r.v));
      r.v = Math.max(8, r.v);
      r.accel = r.accel * 0.85 + ((r.v - prevV) / dt) * 0.15;
      r.f = (r.f + (r.v * dt) / this.segM) % n;

      // lateral: racing line plus any overtaking offset, changed at a finite rate
      r.passT -= dt;
      if (r.passT <= 0) r.pass *= Math.exp(-dt * 1.5);
      const lineW = this.line[Math.floor(r.f) % n]!;
      const wTarget = Math.max(-trackHalf * 0.85, Math.min(trackHalf * 0.85, lineW + r.pass));
      const maxStep = LATERAL_SPEED * u * dt;
      r.w += Math.max(-maxStep, Math.min(maxStep, wTarget - r.w));

      // pose: heading from the actual path, body roll from lateral g, pitch from braking / acceleration
      const p = sampleAlong(this.scene.frame, r.f, r.w);
      const dx = p.x - r.x;
      const dz = p.z - r.z;
      const moved = Math.hypot(dx, dz);
      const heading = moved > 1e-4 && moved < 5 ? Math.atan2(dx, dz) : p.heading;
      let d = heading - r.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      r.yaw += d * Math.min(1, dt * 14);
      r.x = p.x;
      r.z = p.z;
      r.car.position.set(p.x, 0.02, p.z);
      r.car.rotation.y = r.yaw;

      const k = this.kappa[Math.floor(r.f) % n]!;
      const latG = (r.v * r.v * k) / G;
      r.parts.body.rotation.z = Math.max(-0.07, Math.min(0.07, latG * 0.018));
      r.parts.body.rotation.x = Math.max(-0.05, Math.min(0.06, (-r.accel / G) * 0.012));
      const steer = Math.max(-0.5, Math.min(0.5, Math.atan(3.6 * k) * 3));
      r.spin = (r.spin + Math.min(MAX_SPIN, r.v / WHEEL_RADIUS_M) * dt) % (Math.PI * 2);
      r.parts.wheels.forEach((w) => (w.rotation.x = r.spin));
      r.parts.front.forEach((w) => (w.rotation.y = steer));

      // rain light flashes under braking; livery glows a little at night so the field stays visible
      const braking = r.accel < -10;
      const blink = braking ? (Math.sin(this.clock * 28) > 0 ? 4 : 0.6) : night ? 1.2 : 0.35;
      r.parts.rainLight.color.setRGB(blink, blink * 0.08, blink * 0.1);
      r.parts.paint.emissiveIntensity = night ? 0.28 : 0;
    });
  }

  dispose(): void {
    this.racers.forEach((r) => {
      this.group.remove(r.car);
      disposeCar(r.car);
    });
  }
}

/** Cars lapping at the real reference-lap speed (real time): flat out on the straights, braking into each corner. */
export function Traffic({ scene, visible, night }: { scene: SceneData; visible: boolean; night: boolean }) {
  const groupRef = useRef<Group>(null);
  const simRef = useRef<TrafficSim | null>(null);

  useEffect(() => {
    if (!groupRef.current) return;
    const sim = new TrafficSim(groupRef.current, scene);
    simRef.current = sim;
    return () => {
      sim.dispose();
      simRef.current = null;
    };
  }, [scene]);

  useFrame((_, dt) => {
    if (visible) simRef.current?.tick(dt, night);
  });

  return <group ref={groupRef} visible={visible} />;
}
