"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import { Group, Mesh, MeshBasicMaterial, RingGeometry } from "three";
import { toWorld } from "@/lib/trackGeometry";
import { replayBus } from "@/store/replayBus";
import type { CarsFrame } from "@/types/raceControl";
import { carParts, createCar, disposeCar, WHEEL_RADIUS_M } from "./carModel";
import { CAR_SCALE, type SceneData } from "./sceneTypes";

const SMOOTH = 9;            // 1/s, easing towards each new real position (frames arrive 4× per replay second)
const MAX_SPIN = 28;

interface ReplayCar {
  car: Group;
  ring: Mesh | null;
  x: number;
  z: number;
  tx: number;
  tz: number;
  yaw: number;
  speed: number;
  spin: number;
  seen: boolean;
}

/**
 * Every car of the replayed incident at its real OpenF1 position, in its team colour. Cars involved in the
 * incident carry a pulsing red ring. Positions ease between frames; heading follows the real path.
 */
class ReplayField {
  private readonly cars = new Map<string, ReplayCar>();
  private readonly ringGeo: RingGeometry;
  private readonly ringMat = new MeshBasicMaterial({ color: "#ff2b3e", transparent: true, opacity: 0.8, depthWrite: false, toneMapped: false });

  constructor(private readonly group: Group, private readonly scene: SceneData) {
    const u = scene.scale.u;
    this.ringGeo = new RingGeometry(u * 9, u * 12, 32).rotateX(-Math.PI / 2);
  }

  apply(frame: CarsFrame | null): void {
    const live = new Set(frame?.cars.map((c) => c.n) ?? []);
    for (const [n, c] of this.cars) {
      if (!live.has(n)) {
        this.group.remove(c.car);
        disposeCar(c.car);
        this.cars.delete(n);
      }
    }
    for (const fc of frame?.cars ?? []) {
      const p = toWorld(fc.x, fc.y);
      let c = this.cars.get(fc.n);
      if (!c) {
        const car = createCar(fc.colour ? `#${fc.colour}` : "#cccccc", this.scene.scale.u * CAR_SCALE);
        let ring: Mesh | null = null;
        if (fc.involved) {
          ring = new Mesh(this.ringGeo, this.ringMat);
          ring.position.y = 0.05;
          car.add(ring);
          ring.scale.setScalar(1 / (this.scene.scale.u * CAR_SCALE));
        }
        this.group.add(car);
        c = { car, ring, x: p.x, z: p.z, tx: p.x, tz: p.z, yaw: 0, speed: 0, spin: 0, seen: false };
        this.cars.set(fc.n, c);
      }
      c.tx = p.x;
      c.tz = p.z;
      c.speed = fc.speed;
      if (!c.seen) {
        c.x = p.x;
        c.z = p.z;
        c.seen = true;
      }
    }
  }

  tick(dt: number, t: number): void {
    const k = 1 - Math.exp(-dt * SMOOTH);
    for (const c of this.cars.values()) {
      const dx = c.tx - c.x;
      const dz = c.tz - c.z;
      if (Math.hypot(dx, dz) > 1e-4) {
        const want = Math.atan2(dx, dz);
        let d = want - c.yaw;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        c.yaw += d * Math.min(1, dt * 10);
      }
      c.x += dx * k;
      c.z += dz * k;
      c.car.position.set(c.x, 0.02, c.z);
      c.car.rotation.y = c.yaw;
      const parts = carParts(c.car);
      c.spin = (c.spin + Math.min(MAX_SPIN, c.speed / 3.6 / WHEEL_RADIUS_M) * dt) % (Math.PI * 2);
      parts.wheels.forEach((w) => (w.rotation.x = c.spin));
      if (c.ring) (c.ring.material as MeshBasicMaterial).opacity = 0.45 + 0.4 * Math.sin(t * 6);
    }
  }

  dispose(): void {
    for (const c of this.cars.values()) {
      this.group.remove(c.car);
      disposeCar(c.car);
    }
    this.cars.clear();
    this.ringGeo.dispose();
    this.ringMat.dispose();
  }
}

export function ReplayCars({ scene }: { scene: SceneData }) {
  const groupRef = useRef<Group>(null);
  const fieldRef = useRef<ReplayField | null>(null);

  useEffect(() => {
    if (!groupRef.current) return;
    const field = new ReplayField(groupRef.current, scene);
    fieldRef.current = field;
    field.apply(replayBus.latest());
    const unsubscribe = replayBus.subscribe((f) => field.apply(f));
    return () => {
      unsubscribe();
      field.dispose();
      fieldRef.current = null;
    };
  }, [scene]);

  useFrame(({ clock }, dt) => fieldRef.current?.tick(Math.min(dt, 0.1), clock.elapsedTime));

  return <group ref={groupRef} />;
}
