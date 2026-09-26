"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { Color, DoubleSide, Mesh, MeshBasicMaterial, RingGeometry, SphereGeometry, type Group } from "three";
import { nearestIndex, TRACK_WIDTH } from "@/lib/trackGeometry";
import { mapEffects, type MapEffect } from "@/store/crashBus";
import type { FlashMap, FlashRef, SceneData } from "./sceneTypes";

const POOL_SIZE = 90;
const DROP_HEIGHT = 16;
const COLORS = { crash: new Color("#ffffff"), severe: new Color("#e5484d"), incident: new Color("#4fd1c5") };

interface Slot {
  sphere: Mesh;
  ring: Mesh;
  sphereMat: MeshBasicMaterial;
  ringMat: MeshBasicMaterial;
  start: number;
  active: boolean;
  landed: boolean;
  severe: boolean;
  zoneId: string | null;
  life: number;
}

export interface SpawnPoint {
  x: number;
  z: number;
  color: Color;
  scale: number;
  severe: boolean;
  zoneId: string | null;
  life: number;
}

/** A fixed pool of drop + ring meshes, animated imperatively so bursts of events never re-render React. */
class EffectsPool {
  private readonly slots: Slot[] = [];
  private readonly sphereGeo = new SphereGeometry(0.5, 16, 12);
  private readonly ringGeo = new RingGeometry(0.55, 0.8, 36);

  constructor(private readonly group: Group) {
    for (let i = 0; i < POOL_SIZE; i++) {
      const sphereMat = new MeshBasicMaterial({ transparent: true });
      const ringMat = new MeshBasicMaterial({ transparent: true, side: DoubleSide, depthWrite: false });
      const sphere = new Mesh(this.sphereGeo, sphereMat);
      const ring = new Mesh(this.ringGeo, ringMat);
      ring.rotation.x = -Math.PI / 2;
      sphere.visible = ring.visible = false;
      group.add(sphere, ring);
      this.slots.push({ sphere, ring, sphereMat, ringMat, start: 0, active: false, landed: false, severe: false, zoneId: null, life: 1.7 });
    }
  }

  spawn(p: SpawnPoint): void {
    const s = this.slots.find((slot) => !slot.active);
    if (!s) return;
    s.sphereMat.color.copy(p.color);
    s.ringMat.color.copy(p.color);
    s.sphere.scale.setScalar(p.scale);
    s.sphere.position.set(p.x, DROP_HEIGHT, p.z);
    s.ring.position.set(p.x, 0.08, p.z);
    s.ring.scale.setScalar(1);
    s.severe = p.severe;
    s.zoneId = p.zoneId;
    s.life = p.life;
    s.landed = false;
    s.active = true;
    s.start = performance.now();
  }

  tick(now: number, fallSeconds: number, flash: FlashMap): void {
    for (const s of this.slots) {
      if (!s.active) continue;
      const t = (now - s.start) / 1000;
      if (t < fallSeconds) {
        const e = t / fallSeconds;
        s.sphere.visible = true;
        s.sphere.position.y = DROP_HEIGHT * (1 - e * e) + 0.5;
        s.sphereMat.opacity = 1;
        continue;
      }
      const a = t - fallSeconds;
      if (!s.landed) {
        s.landed = true;
        if (s.severe && s.zoneId) flash.set(s.zoneId, 1);
      }
      s.sphere.position.y = 0.5;
      s.sphereMat.opacity = Math.max(0, 1 - a / s.life);
      s.ring.visible = true;
      s.ring.scale.setScalar(1 + a * (s.severe ? 9 : 5));
      s.ringMat.opacity = Math.max(0, 1 - a);
      if (a > s.life) {
        s.active = false;
        s.sphere.visible = s.ring.visible = false;
      }
    }
  }

  dispose(): void {
    for (const s of this.slots) {
      this.group.remove(s.sphere, s.ring);
      s.sphereMat.dispose();
      s.ringMat.dispose();
    }
    this.sphereGeo.dispose();
    this.ringGeo.dispose();
  }
}

/**
 * Animates map effects from the event bus: simulated crashes fall onto the run-off and ring out
 * (red for one of the costliest 5% of crashes); freshly ingested incidents drop in as teal pins.
 */
export function MapEffectsLayer({ scene, flash, reducedMotion }: { scene: SceneData; flash: FlashRef; reducedMotion: boolean }) {
  const groupRef = useRef<Group>(null);
  const poolRef = useRef<EffectsPool | null>(null);
  const sideByZone = useMemo(() => new Map(scene.zones.map((z) => [z.view.zone.zone_id, z.side])), [scene.zones]);

  useEffect(() => {
    if (!groupRef.current) return;
    const pool = new EffectsPool(groupRef.current);
    poolRef.current = pool;
    return () => {
      pool.dispose();
      poolRef.current = null;
    };
  }, []);

  useEffect(
    () =>
      mapEffects.subscribe((effect: MapEffect) => {
        const isCrash = effect.kind === "crash";
        const src = isCrash ? effect.crash : effect.incident;
        const i = nearestIndex(scene.outline, src.x, src.y);
        const p = scene.frame.points[i]!;
        const q = scene.frame.normals[i]!;
        const side = (src.zone_id && sideByZone.get(src.zone_id)) || 1;
        const off = TRACK_WIDTH / 2 + 0.7;
        const severe = isCrash && effect.crash.severe;
        poolRef.current?.spawn({
          x: p.x + q.x * side * off,
          z: p.z + q.z * side * off,
          color: isCrash ? (severe ? COLORS.severe : COLORS.crash) : COLORS.incident,
          scale: isCrash ? 1 : 0.7,
          severe,
          zoneId: src.zone_id,
          life: isCrash ? 1.7 : 3,
        });
      }),
    [scene, sideByZone],
  );

  useFrame(() => poolRef.current?.tick(performance.now(), reducedMotion ? 0.01 : 0.55, flash.current));

  return <group ref={groupRef} />;
}
