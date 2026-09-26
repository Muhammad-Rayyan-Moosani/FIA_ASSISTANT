"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import type { Group } from "three";
import { sampleAlong } from "@/lib/trackGeometry";
import { createCar, disposeCar, LIVERIES } from "./carModel";
import { CAR_SCALE, type SceneData } from "./sceneTypes";

const CARS = 5;

/** Cars lapping the outline, each advanced by the real reference-lap speed at its position. */
class TrafficSim {
  private readonly cars: { car: Group; f: number; lane: number }[];
  private readonly segM: number;

  constructor(private readonly group: Group, private readonly scene: SceneData) {
    const n = scene.frame.points.length;
    this.segM = scene.lengthM / n;
    this.cars = Array.from({ length: CARS }, (_, i) => ({
      car: createCar(LIVERIES[i % LIVERIES.length]!, scene.scale.u * CAR_SCALE),
      f: (i / CARS) * n,
      lane: (i % 2 ? -1 : 1) * 0.18,
    }));
    this.cars.forEach((c) => group.add(c.car));
  }

  tick(dt: number): void {
    const n = this.scene.frame.points.length;
    for (const c of this.cars) {
      const kph = this.scene.speedKph[Math.floor(c.f) % n] ?? 200;
      c.f = (c.f + ((kph / 3.6) * dt) / this.segM) % n;
      const p = sampleAlong(this.scene.frame, c.f, c.lane * this.scene.scale.trackHalf);
      c.car.position.set(p.x, 0.02, p.z);
      c.car.rotation.y = p.heading;
    }
  }

  dispose(): void {
    this.cars.forEach((c) => {
      this.group.remove(c.car);
      disposeCar(c.car);
    });
  }
}

/** Cars lapping at the real reference-lap speed (real time): flat out on the straights, braking into each corner. */
export function Traffic({ scene, visible }: { scene: SceneData; visible: boolean }) {
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
    if (visible) simRef.current?.tick(Math.min(dt, 0.1));
  });

  return <group ref={groupRef} visible={visible} />;
}
