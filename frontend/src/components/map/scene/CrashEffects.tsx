"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import { BufferAttribute, BufferGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial, Points, PointsMaterial, SphereGeometry } from "three";
import { nearestIndex, sampleAlong } from "@/lib/trackGeometry";
import { mapEffects, type MapEffect } from "@/store/crashBus";
import type { RunoffType } from "@/types/track";
import { carParts, createCar, disposeCar, LIVERIES, WHEEL_RADIUS_M } from "./carModel";
import { CAR_SCALE, type FlashMap, type FlashRef, type PlacedZone, type SceneData } from "./sceneTypes";

const CAR_POOL = 24;
const PARTICLES = 900;
const PIN_POOL = 60;
const G = 9.81;
/** Visual deceleration once off the asphalt (m/s²). Animation only: the model prices energy, not this path. */
const RUNOFF_DECEL: Record<RunoffType, number> = { gravel: 8, asphalt: 5, grass: 3.5 };
const DUST: Record<RunoffType, [number, number, number]> = { gravel: [0.82, 0.74, 0.58], asphalt: [0.55, 0.56, 0.58], grass: [0.45, 0.55, 0.32] };

interface CrashCar {
  car: Group;
  active: boolean;
  t: number;
  f: number;       // fractional outline index (along the track)
  w: number;       // lateral distance from the centreline towards the outside, metres
  v: number;       // speed, m/s
  yaw: number;     // extra yaw relative to the track direction, radians
  spin: number;
  stopped: boolean;
  zone: PlacedZone;
  severe: boolean;
  wheel: number;   // wheel spin angle
}

interface Particle {
  life: number;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  gravity: number;
}

/**
 * Crash replay physics: the car leaves the racing line at its impact speed (from the simulated crash energy),
 * loses the rear, slides across the zone's real run-off surface and either stops or hits the barrier
 * (debris, dust, a barrier flash on severe crashes). Ingested incidents rise as pins.
 */
class CrashSim {
  private readonly cars: CrashCar[];
  private readonly particles: Particle[];
  private readonly pins: { g: Group; t: number }[];
  private readonly geo = new BufferGeometry();
  private readonly mat: PointsMaterial;
  private readonly pinParts: { stem: CylinderGeometry; head: SphereGeometry; mat: MeshStandardMaterial };
  private readonly points: Points;
  private readonly zoneById: Map<string, PlacedZone>;
  private readonly segM: number;

  constructor(private readonly group: Group, private readonly scene: SceneData, private readonly flash: FlashMap) {
    const { u } = scene.scale;
    this.segM = scene.lengthM / scene.frame.points.length;
    this.zoneById = new Map(scene.zones.map((z) => [z.view.zone.zone_id, z]));
    this.cars = Array.from({ length: CAR_POOL }, (_, i) => ({
      car: createCar(LIVERIES[(i + 2) % LIVERIES.length]!, u * CAR_SCALE), active: false, t: 0, f: 0, w: 0, v: 0,
      yaw: 0, spin: 0, stopped: false, zone: scene.zones[0]!, severe: false, wheel: 0,
    }));
    this.cars.forEach((c) => {
      c.car.visible = false;
      group.add(c.car);
    });

    this.particles = Array.from({ length: PARTICLES }, () => ({ life: 0, x: 0, y: -99, z: 0, vx: 0, vy: 0, vz: 0, gravity: 0 }));
    this.geo.setAttribute("position", new BufferAttribute(new Float32Array(PARTICLES * 3).fill(-99), 3));
    this.geo.setAttribute("color", new BufferAttribute(new Float32Array(PARTICLES * 3), 3));
    this.mat = new PointsMaterial({ size: 4.8 * u, vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false });
    this.points = new Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    group.add(this.points);

    this.pinParts = {
      stem: new CylinderGeometry(0.05, 0.05, 1, 6).translate(0, 0.5, 0),
      head: new SphereGeometry(0.28, 12, 10),
      mat: new MeshStandardMaterial({ color: "#4fd1c5", emissive: "#4fd1c5", emissiveIntensity: 0.6 }),
    };
    this.pins = Array.from({ length: PIN_POOL }, () => {
      const g = new Group();
      g.add(new Mesh(this.pinParts.stem, this.pinParts.mat));
      const head = new Mesh(this.pinParts.head, this.pinParts.mat);
      head.position.y = 1;
      g.add(head);
      g.visible = false;
      group.add(g);
      return { g, t: -1 };
    });
  }

  handle(effect: MapEffect): void {
    const { u } = this.scene.scale;
    const n = this.scene.frame.points.length;
    if (effect.kind === "incident") {
      const pin = this.pins.find((p) => p.t < 0);
      if (!pin) return;
      const p = sampleAlong(this.scene.frame, nearestIndex(this.scene.outline, effect.incident.x, effect.incident.y));
      pin.g.position.set(p.x, 0, p.z);
      pin.g.scale.setScalar(u * 6);
      pin.g.visible = true;
      pin.t = 0;
      return;
    }
    const crash = effect.crash;
    const zone = this.zoneById.get(crash.zone_id);
    const c = this.cars.find((x) => !x.active);
    if (!zone || !c) return;
    // Impact speed back from the simulated crash energy (E = ½mv², 800 kg), clamped to a plausible range.
    c.v = Math.min(95, Math.max(18, Math.sqrt((2 * crash.energy_kj * 1000) / 800)));
    c.active = true;
    c.t = 0;
    c.f = crash.lap_frac * n;
    c.w = (Math.random() - 0.5) * 4;
    c.yaw = 0;
    c.spin = (Math.random() < 0.5 ? -1 : 1) * (0.8 + Math.random() * 2.2);
    c.stopped = false;
    c.zone = zone;
    c.severe = crash.severe;
    c.car.visible = true;
    c.car.scale.setScalar(u * CAR_SCALE);
  }

  private emit(x: number, y: number, z: number, count: number, rgb: [number, number, number], speed: number, gravity: number): void {
    const colors = this.geo.getAttribute("color") as BufferAttribute;
    let made = 0;
    for (let i = 0; i < PARTICLES && made < count; i++) {
      const p = this.particles[i]!;
      if (p.life > 0) continue;
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.3 + Math.random() * 0.7);
      p.life = 0.8 + Math.random() * 0.9;
      p.x = x;
      p.y = y;
      p.z = z;
      p.vx = Math.cos(a) * s;
      p.vz = Math.sin(a) * s;
      p.vy = speed * (0.4 + Math.random());
      p.gravity = gravity;
      colors.setXYZ(i, ...rgb);
      made++;
    }
    colors.needsUpdate = true;
  }

  tick(rawDt: number, reducedMotion: boolean, night: boolean): void {
    const { u, trackHalf } = this.scene.scale;
    const dt = Math.min(rawDt, 0.05) * (reducedMotion ? 4 : 1);
    const offTrackM = trackHalf / u;
    for (const c of this.cars) {
      if (!c.active) continue;
      c.t += dt;
      const zone = c.zone.view.zone;
      const barrierM = c.zone.barrierOffset / u;
      if (!c.stopped) {
        const slip = Math.min(1, c.t / 0.45);            // the rear lets go over ~half a second
        c.yaw += c.spin * dt * slip;
        const drift = 0.55 * slip;                        // heading angle towards the outside
        c.v = Math.max(0, c.v - (c.w > offTrackM ? RUNOFF_DECEL[zone.runoff_type] : 0.45 * G) * dt);
        c.f += (c.v * Math.cos(drift) * dt) / this.segM;
        c.w += c.v * Math.sin(drift) * dt;
        const pos = sampleAlong(this.scene.frame, c.f, c.zone.side * c.w * u);
        if (c.w > offTrackM && Math.random() < 0.6) this.emit(pos.x, 0.05, pos.z, 3, DUST[zone.runoff_type], 4.2 * u, -0.5 * u);
        else if (slip > 0.3 && Math.random() < 0.5) this.emit(pos.x, 0.1, pos.z, 2, [0.86, 0.86, 0.88], 2.6 * u, 0.4 * u);   // tyre smoke
        if (c.w >= barrierM) {
          c.stopped = true;
          c.w = barrierM - 1.2;
          this.emit(pos.x, 0.9 * u, pos.z, c.severe ? 70 : 28, [0.12, 0.12, 0.13], (c.severe ? 21 : 12) * u, -G * u * 0.9);
          this.emit(pos.x, 0.1, pos.z, 30, DUST[zone.runoff_type], 6 * u, -0.3 * u);
          if (c.severe) this.flash.set(zone.zone_id, 1);
        } else if (c.v <= 0.5) {
          c.stopped = true;
        }
      }
      const pos = sampleAlong(this.scene.frame, c.f, c.zone.side * c.w * u);
      c.car.position.set(pos.x, 0.02, pos.z);
      c.car.rotation.y = pos.heading + c.yaw * c.zone.side;
      const parts = carParts(c.car);
      c.wheel = (c.wheel + Math.min(28, c.v / WHEEL_RADIUS_M) * dt) % (Math.PI * 2);
      parts.wheels.forEach((w) => (w.rotation.x = c.wheel));
      parts.front.forEach((w) => (w.rotation.y = c.stopped ? 0 : -Math.sign(c.spin) * c.zone.side * 0.45));   // opposite lock
      parts.body.rotation.z = c.stopped ? 0 : Math.sign(c.spin) * c.zone.side * -0.06;
      const flash = Math.sin(c.t * 26) > 0 ? 4 : 0.5;
      parts.rainLight.color.setRGB(flash, flash * 0.08, flash * 0.1);
      parts.paint.emissiveIntensity = night ? 0.28 : 0;
      if (c.t > 4.2) {
        c.active = false;
        c.car.visible = false;
      } else if (c.t > 3.6) {
        c.car.scale.setScalar(u * CAR_SCALE * Math.max(0.01, (4.2 - c.t) / 0.6));
      }
    }

    const positions = this.geo.getAttribute("position") as BufferAttribute;
    let alive = false;
    this.particles.forEach((p, i) => {
      if (p.life <= 0) return;
      alive = true;
      p.life -= rawDt;
      p.vy += p.gravity * rawDt;
      p.x += p.vx * rawDt;
      p.y = Math.max(0.02, p.y + p.vy * rawDt);
      p.z += p.vz * rawDt;
      p.vx *= 0.97;
      p.vz *= 0.97;
      positions.setXYZ(i, p.x, p.life > 0 ? p.y : -99, p.z);
    });
    if (alive) positions.needsUpdate = true;

    for (const pin of this.pins) {
      if (pin.t < 0) continue;
      pin.t += rawDt;
      pin.g.scale.y = u * 6 * Math.min(1, pin.t * 3);
      if (pin.t > 3) {
        pin.g.visible = false;
        pin.t = -1;
      }
    }
  }

  dispose(): void {
    this.cars.forEach((c) => {
      this.group.remove(c.car);
      disposeCar(c.car);
    });
    this.pins.forEach((p) => this.group.remove(p.g));
    this.group.remove(this.points);
    this.geo.dispose();
    this.mat.dispose();
    this.pinParts.stem.dispose();
    this.pinParts.head.dispose();
    this.pinParts.mat.dispose();
  }
}

/** Replays simulated crashes and ingested incidents from the map-effects bus. */
export function CrashEffects({ scene, flash, reducedMotion, night }: { scene: SceneData; flash: FlashRef; reducedMotion: boolean; night: boolean }) {
  const root = useRef<Group>(null);
  const simRef = useRef<CrashSim | null>(null);

  useEffect(() => {
    if (!root.current) return;
    const sim = new CrashSim(root.current, scene, flash.current);
    simRef.current = sim;
    const unsubscribe = mapEffects.subscribe((e) => sim.handle(e));
    return () => {
      unsubscribe();
      sim.dispose();
      simRef.current = null;
    };
  }, [scene, flash]);

  useFrame((_, dt) => simRef.current?.tick(dt, reducedMotion, night));

  return <group ref={root} />;
}
