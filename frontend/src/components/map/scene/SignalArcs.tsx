"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import { AdditiveBlending, BufferAttribute, BufferGeometry, Group, Line, LineBasicMaterial, Mesh, MeshBasicMaterial, SphereGeometry, Vector3 } from "three";
import type { StoryInput } from "@/types/raceControl";
import type { StoryStage } from "@/store/storyStore";
import type { SceneScale } from "./sceneTypes";
import { carPoint, crashSubject } from "./storyAnchors";

const SEGMENTS = 40;
const PULSES = 4;

interface Arc {
  line: Line;
  geo: BufferGeometry;
  pulses: Mesh[];
  colour: string;
}

/**
 * The signal path, drawn as arcs with pulses running along them: crash -> race control (the report), then
 * race control -> the car being warned (the cockpit message). Endpoints follow the real replay cars.
 */
class SignalPaths {
  private readonly arcs: Arc[];
  private readonly pulseGeo: SphereGeometry;
  private readonly from = new Vector3();
  private readonly to = new Vector3();
  private readonly mid = new Vector3();

  constructor(private readonly group: Group, private readonly scale: SceneScale) {
    this.pulseGeo = new SphereGeometry(2.4 * scale.u, 10, 8);
    this.arcs = ["#ff5a4a", "#ffcc33"].map((colour) => {
      const geo = new BufferGeometry();
      geo.setAttribute("position", new BufferAttribute(new Float32Array((SEGMENTS + 1) * 3), 3));
      const line = new Line(geo, new LineBasicMaterial({ color: colour, transparent: true, opacity: 0.85, blending: AdditiveBlending, depthWrite: false, toneMapped: false }));
      line.frustumCulled = false;
      const pulses = Array.from({ length: PULSES }, () => new Mesh(this.pulseGeo, new MeshBasicMaterial({ color: colour, toneMapped: false })));
      group.add(line, ...pulses);
      return { line, geo, pulses, colour };
    });
  }

  private place(arc: Arc, a: Vector3 | null, b: Vector3 | null, t: number): void {
    const show = a !== null && b !== null;
    arc.line.visible = show;
    arc.pulses.forEach((p) => (p.visible = show));
    if (!show) return;
    this.from.copy(a);
    this.to.copy(b);
    const dist = this.from.distanceTo(this.to);
    this.mid.addVectors(this.from, this.to).multiplyScalar(0.5).setY(Math.max(this.from.y, this.to.y) + dist * 0.35);
    const pos = arc.geo.getAttribute("position") as BufferAttribute;
    const at = (s: number, out: Vector3) => {
      const k = 1 - s;
      return out.set(
        k * k * this.from.x + 2 * k * s * this.mid.x + s * s * this.to.x,
        k * k * this.from.y + 2 * k * s * this.mid.y + s * s * this.to.y,
        k * k * this.from.z + 2 * k * s * this.mid.z + s * s * this.to.z,
      );
    };
    const v = new Vector3();
    for (let i = 0; i <= SEGMENTS; i++) {
      at(i / SEGMENTS, v);
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    pos.needsUpdate = true;
    arc.pulses.forEach((p, i) => at((t * 0.45 + i / PULSES) % 1, p.position));
  }

  tick(t: number, stage: StoryStage, input: StoryInput, tower: Vector3 | null): void {
    const crash = crashSubject(input);
    const reporting = stage === "race_control" || stage === "drivers" || stage === "overview";
    const warning = stage === "drivers" || stage === "overview";
    const crashPt = crash ? carPoint(crash.car, crash.point, this.scale, new Vector3()) : null;
    const warned = carPoint(input.warning?.driver ?? null, null, this.scale, new Vector3());
    this.place(this.arcs[0]!, reporting ? crashPt : null, reporting ? tower : null, t);
    this.place(this.arcs[1]!, warning ? tower : null, warning ? warned : null, t);
  }

  dispose(): void {
    for (const a of this.arcs) {
      this.group.remove(a.line, ...a.pulses);
      a.geo.dispose();
      (a.line.material as LineBasicMaterial).dispose();
      a.pulses.forEach((p) => (p.material as MeshBasicMaterial).dispose());
    }
    this.pulseGeo.dispose();
  }
}

export function SignalArcs({ input, stage, scale, tower }: { input: StoryInput; stage: StoryStage; scale: SceneScale; tower: Vector3 | null }) {
  const group = useRef<Group>(null);
  const sim = useRef<SignalPaths | null>(null);
  useEffect(() => {
    if (!group.current) return;
    const s = new SignalPaths(group.current, scale);
    sim.current = s;
    return () => {
      s.dispose();
      sim.current = null;
    };
  }, [scale]);
  useFrame(({ clock }) => sim.current?.tick(clock.elapsedTime, stage, input, tower));
  return <group ref={group} />;
}
