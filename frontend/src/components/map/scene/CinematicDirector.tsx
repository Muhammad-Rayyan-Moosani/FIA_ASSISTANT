"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import { type Camera, Vector3 } from "three";
import { toWorld } from "@/lib/trackGeometry";
import { useStoryStore, type StoryStage } from "@/store/storyStore";
import type { StoryInput } from "@/types/raceControl";
import type { SceneScale } from "./sceneTypes";
import { carPoint, carYaw, crashSubject, subjectCar } from "./storyAnchors";

/** Seconds each stage holds before the next (the approach lasts until the impact arrives). */
const HOLD: Partial<Record<StoryStage, number>> = { approach: 60, impact: 4.5, race_control: 4.5, drivers: 4.5, overview: 3.5 };
const DRIVERS_HOLD_MAX_S = 30;
/** The demo: stay on the spinning car until just after it hits the fence, then cut to the car behind while it is
 * still flat out (it got the message at the slip), hold it until it is past the wreck, then race control. */
const DEMO_HOLD: Partial<Record<StoryStage, number>> = { approach: 60, impact: 3.8, drivers: 4.5, race_control: 3.5, overview: 3.5 };
/** Shot distances in metres (converted with the scene scale). */
const SHOT = {
  follow: { back: 150, up: 70 },
  impact: { radius: 150, up: 95, spin: 0.35 },
  raceControl: { back: 320, up: 210 },
  drivers: { back: 180, up: 110 },
  overviewPad: 260,
};

interface Controls {
  target: Vector3;
  update: () => void;
  autoRotate: boolean;
}

/**
 * The broadcast camera for a replay: follow the car on its real telemetry, hold on the incident, fly to race
 * control as the signal arrives, then to the car being warned, and pull back to a race-control view before
 * handing the camera back. Any drag or the Skip button ends it at once.
 */
export class Director {
  stage: StoryStage = "idle";
  /** Seconds of rendered frames. Not wall time: a hidden tab pauses rendering, and the story pauses with it. */
  private now = 0;
  private t0 = 0;
  private orbit0 = 0;
  private replaySeq: number;
  private incidentSeq: number;
  private skipSeq: number;
  private readonly target = new Vector3();
  private readonly pos = new Vector3();
  private readonly a = new Vector3();
  private readonly b = new Vector3();
  private readonly c = new Vector3();

  constructor(input: StoryInput, skipSeq: number) {
    // start where the stream already is, so a remount never replays an old story
    this.replaySeq = input.replaySeq;
    this.incidentSeq = input.incidentSeq;
    this.skipSeq = skipSeq;
  }

  private go(stage: StoryStage, clock: number, camera?: Camera, around?: Vector3): void {
    this.stage = stage;
    this.t0 = clock;
    if (camera && around) this.orbit0 = Math.atan2(camera.position.z - around.z, camera.position.x - around.x);
    useStoryStore.getState().setStage(stage);
  }

  update(input: StoryInput, skipSeq: number, dt: number, camera: Camera, controls: Controls | null, scale: SceneScale, tower: Vector3 | null): void {
    this.now += dt;
    const clock = this.now;
    if (skipSeq !== this.skipSeq || !input.cinematic) {
      this.skipSeq = skipSeq;
      this.replaySeq = input.replaySeq;
      this.incidentSeq = input.incidentSeq;
      if (this.stage !== "idle") this.go("idle", clock);
      return;
    }
    const crash = crashSubject(input);
    if (input.replaySeq !== this.replaySeq) {
      this.replaySeq = input.replaySeq;
      // if this replay's impact already arrived (both events landed before a frame), still show it next
      const arrived = input.incident !== null && input.incident.incident_id === input.replayIncident?.incident_id;
      this.incidentSeq = arrived ? input.incidentSeq - 1 : input.incidentSeq;
      this.go("approach", clock);
    }
    if (input.incidentSeq !== this.incidentSeq) {
      this.incidentSeq = input.incidentSeq;
      if (crash) this.go("impact", clock, camera, crash.point);
    }
    if (this.stage === "idle" || !controls) return;

    const e = clock - this.t0;
    const demo = input.holdDrivers !== undefined;
    const hold = (demo ? DEMO_HOLD : HOLD)[this.stage];
    // the demo stays on the warned car until it is through the corner
    const held = this.stage === "drivers" && input.holdDrivers === true && e < DRIVERS_HOLD_MAX_S;
    if (hold !== undefined && e > hold && !held) {
      const next: StoryStage = demo
        ? this.stage === "impact" ? "drivers" : this.stage === "drivers" ? (tower ? "race_control" : "overview") : this.stage === "race_control" ? "overview" : "idle"
        : this.stage === "impact" ? (tower ? "race_control" : input.warning?.driver ? "drivers" : "overview")
        : this.stage === "race_control" ? (input.warning?.driver ? "drivers" : "overview")
        : this.stage === "drivers" ? "overview" : "idle";          // (an approach with no impact times out)
      this.go(next, clock);
      if (next === "idle") return;
    }

    const u = scale.u;
    let rate = 2.2;
    const fallback = crash?.point ?? null;
    switch (this.stage) {
      case "approach": {
        const n = subjectCar(input);
        const inc = input.replayIncident;
        const w = inc ? toWorld(inc.x, inc.y) : null;
        const p = carPoint(n, w ? this.b.set(w.x, 0, w.z) : null, scale, this.a);
        if (!p) return;
        this.follow(p, carYaw(n), SHOT.follow, u);
        rate = 4.5;
        break;
      }
      case "impact": {
        const p = carPoint(crash?.car ?? null, fallback, scale, this.a);
        if (!p) return;
        const ang = this.orbit0 + e * SHOT.impact.spin;
        this.target.copy(p);
        this.pos.set(p.x + Math.cos(ang) * SHOT.impact.radius * u, p.y + SHOT.impact.up * u, p.z + Math.sin(ang) * SHOT.impact.radius * u);
        rate = 3;
        break;
      }
      case "race_control": {
        if (!tower || !fallback) return;
        const dir = this.b.copy(fallback).sub(tower).setY(0).normalize();
        this.target.copy(tower);
        this.pos.copy(tower).addScaledVector(dir, SHOT.raceControl.back * u).setY(tower.y + SHOT.raceControl.up * u);
        break;
      }
      case "drivers": {
        const n = input.warning?.driver ?? null;
        const p = carPoint(n, null, scale, this.a);
        if (!p) return;
        this.follow(p, carYaw(n), SHOT.drivers, u);
        rate = 3.5;
        break;
      }
      case "overview": {
        const pts = [fallback, tower, carPoint(input.warning?.driver ?? null, null, scale, this.c)].filter((v): v is Vector3 => v !== null);
        if (!pts.length) return;
        const centre = this.b.set(0, 0, 0);
        pts.forEach((v) => centre.add(v));
        centre.divideScalar(pts.length).setY(0);
        const r = Math.max(...pts.map((v) => Math.hypot(v.x - centre.x, v.z - centre.z))) + SHOT.overviewPad * u;
        const az = Math.atan2(camera.position.z - centre.z, camera.position.x - centre.x);
        this.target.copy(centre);
        this.pos.set(centre.x + Math.cos(az) * r * 1.15, r * 0.95, centre.z + Math.sin(az) * r * 1.15);
        rate = 1.8;
        break;
      }
    }
    const k = 1 - Math.exp(-dt * rate);
    controls.autoRotate = false;
    controls.target.lerp(this.target, k);
    camera.position.lerp(this.pos, k);
    controls.update();
  }

  private follow(p: Vector3, yaw: number | null, shot: { back: number; up: number }, u: number): void {
    const y = yaw ?? 0;
    this.target.copy(p);
    this.pos.set(p.x - Math.sin(y) * shot.back * u, p.y + shot.up * u, p.z - Math.cos(y) * shot.back * u);
  }
}

export function CinematicDirector({ input, scale, tower }: { input: StoryInput; scale: SceneScale; tower: Vector3 | null }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as unknown as Controls | null;
  const skipSeq = useStoryStore((s) => s.skipSeq);
  const ref = useRef<Director | null>(null);

  useEffect(() => {
    ref.current = new Director(input, useStoryStore.getState().skipSeq);
    return () => {
      ref.current = null;
      useStoryStore.getState().setStage("idle");
    };
    // one director per scene; it reads the latest input every frame
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useFrame((_, dt) => ref.current?.update(input, skipSeq, Math.min(dt, 0.1), camera, controls, scale, tower));
  return null;
}
