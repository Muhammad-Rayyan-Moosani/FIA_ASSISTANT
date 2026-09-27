import { Vector3 } from "three";
import { toWorld, type TrackFrame } from "@/lib/trackGeometry";
import { replayPositions } from "@/store/replayBus";
import type { Asset } from "@/types/assets";
import type { StoryInput } from "@/types/raceControl";
import type { SceneScale } from "./sceneTypes";

/** Car height above the road for anchors (world units come from the scene scale). */
const CAR_ANCHOR_M = 3;

/** The car the story follows before the impact: the detected impact's driver, else the first named car. */
export function subjectCar(input: StoryInput): string | null {
  const inc = input.replayIncident;
  return inc?.impact?.driver ?? inc?.involved[0]?.number ?? null;
}

/** The crashed car (if the telemetry shows one) and the crash point. */
export function crashSubject(input: StoryInput): { car: string | null; point: Vector3 } | null {
  const inc = input.incident;
  if (!inc) return null;
  const w = toWorld(inc.x, inc.y);
  // the demo's car is on screen from the first slip, before any impact
  return { car: inc.collision?.driver ?? (inc.demo ? inc.involved[0]?.number ?? null : null), point: new Vector3(w.x, 0, w.z) };
}

/** A replay car's live position, or `fallback` when it is not on screen. */
export function carPoint(n: string | null, fallback: Vector3 | null, scale: SceneScale, out = new Vector3()): Vector3 | null {
  const pose = n ? replayPositions.get(n) : undefined;
  if (pose) return out.set(pose.x, scale.h(CAR_ANCHOR_M), pose.z);
  return fallback ? out.copy(fallback) : null;
}

export function carYaw(n: string | null): number | null {
  const pose = n ? replayPositions.get(n) : undefined;
  return pose ? pose.yaw : null;
}

const RC_CATEGORIES = ["race_control", "pit_building", "paddock"] as const;

/**
 * Where race control sits: the OSM race-control building if mapped, else the pit building, else the paddock
 * (race control at F1 circuits is in the pit / control building by the start line). The point is the corner of
 * that building nearest the start line, raised to its roof.
 */
export function raceControlSite(assets: Asset[] | undefined, frame: TrackFrame, scale: SceneScale): { position: Vector3; name: string; basis: string } | null {
  if (!assets) return null;
  for (const cat of RC_CATEGORIES) {
    const a = assets.find((x) => x.category === cat && x.geometry === "polygon");
    if (!a) continue;
    const start = frame.points[0]!;
    const pts = a.points.map(([x, y]) => toWorld(x, y));
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cz = pts.reduce((s, p) => s + p.z, 0) / pts.length;
    const near = pts.reduce((b, p) => (Math.hypot(p.x - start.x, p.z - start.z) < Math.hypot(b.x - start.x, b.z - start.z) ? p : b), pts[0]!);
    const x = near.x + (cx - near.x) * 0.25;
    const z = near.z + (cz - near.z) * 0.25;
    const basis = cat === "race_control" ? "OpenStreetMap race-control building" : `in the ${cat === "pit_building" ? "pit building" : "paddock building"} by the start line (OpenStreetMap: ${a.name ?? cat})`;
    return { position: new Vector3(x, scale.h(a.height_m), z), name: a.name ?? "Race control", basis };
  }
  return null;
}
