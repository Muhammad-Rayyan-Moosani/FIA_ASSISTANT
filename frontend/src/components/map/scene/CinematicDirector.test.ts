import { PerspectiveCamera, Vector3 } from "three";
import { beforeEach, describe, expect, it } from "vitest";
import { replayPositions } from "@/store/replayBus";
import { useStoryStore } from "@/store/storyStore";
import type { ActiveIncident, DriverWarning, IncidentSummary, StoryInput } from "@/types/raceControl";
import { Director } from "./CinematicDirector";
import type { SceneScale } from "./sceneTypes";

const scale: SceneScale = { u: 0.05, trackHalf: 1, h: (m) => m * 0.1 };
const tower = new Vector3(40, 3, -20);

const replayIncident = { incident_id: "i", x: 0.1, y: -0.2, involved: [{ number: "4", code: "NOR" }], impact: { driver: "4" } } as unknown as IncidentSummary;
const incident = { incident_id: "i", x: 0.1, y: -0.2, involved: [{ number: "4" }], collision: { driver: "4" }, advice: { flag: "SC" } } as unknown as ActiveIncident;
const warning = { driver: "30", code: "LAW", lines: ["CRASH AHEAD · SECTOR 1"], distance_m: 235 } as unknown as DriverWarning;

const base: StoryInput = { cinematic: true, replaySeq: 0, incidentSeq: 0, replayIncident: null, incident: null, warning: null, deployment: "green", masts: [] };

function rig() {
  const camera = new PerspectiveCamera();
  camera.position.set(100, 80, 100);
  const controls = { target: new Vector3(), update: () => {}, autoRotate: true };
  return { camera, controls };
}

/** Run the director for `seconds` at 30 fps. */
function run(d: Director, input: StoryInput, from: number, seconds: number, r: ReturnType<typeof rig>, skip = 0): number {
  let t = from;
  for (let i = 0; i < seconds * 30; i++) {
    t += 1 / 30;
    d.update(input, skip, 1 / 30, r.camera, r.controls, scale, tower);
  }
  return t;
}

describe("cinematic replay director", () => {
  beforeEach(() => {
    replayPositions.clear();
    replayPositions.set("4", { x: 10, z: 5, yaw: 0, speed: 300 });
    replayPositions.set("30", { x: -12, z: 8, yaw: Math.PI, speed: 280 });
    useStoryStore.setState({ stage: "idle", skipSeq: 0 });
  });

  it("does nothing until a new replay starts (a remount never replays an old story)", () => {
    const r = rig();
    const d = new Director({ ...base, replaySeq: 3, incidentSeq: 2, incident }, 0);
    run(d, { ...base, replaySeq: 3, incidentSeq: 2, incident }, 0, 1, r);
    expect(d.stage).toBe("idle");
    expect(r.camera.position.x).toBe(100);
  });

  it("follows the car, holds on the crash, visits race control, the warned car, then the overview", () => {
    const r = rig();
    const d = new Director(base, 0);
    let t = run(d, { ...base, replaySeq: 1, replayIncident }, 0, 3, r);
    expect(d.stage).toBe("approach");
    expect(useStoryStore.getState().stage).toBe("approach");
    // chase camera: behind the car (yaw 0 faces +z, so the camera sits at lower z) and looking at it
    expect(r.controls.target.distanceTo(new Vector3(10, 0.3, 5))).toBeLessThan(0.5);
    expect(r.camera.position.z).toBeLessThan(5);

    const withCrash = { ...base, replaySeq: 1, replayIncident, incidentSeq: 1, incident, warning };
    t = run(d, withCrash, t, 1, r);
    expect(d.stage).toBe("impact");
    t = run(d, withCrash, t, 2.5, r);
    // the crash shot keeps the crashed car centred while circling it
    expect(r.controls.target.distanceTo(new Vector3(10, 0.3, 5))).toBeLessThan(0.3);
    expect(r.camera.position.distanceTo(new Vector3(10, 0.3, 5))).toBeLessThan(12);
    t = run(d, withCrash, t, 1.5, r);
    expect(d.stage).toBe("race_control");
    t = run(d, withCrash, t, 4, r);
    expect(r.controls.target.distanceTo(tower)).toBeLessThan(1);
    t = run(d, withCrash, t, 0.6, r);
    expect(d.stage).toBe("drivers");
    t = run(d, withCrash, t, 3.0, r);
    expect(r.controls.target.distanceTo(new Vector3(-12, 0.3, 8))).toBeLessThan(1);
    t = run(d, withCrash, t, 1.5, r);
    expect(d.stage).toBe("overview");
    run(d, withCrash, t, 4, r);
    expect(d.stage).toBe("idle");
    expect(r.controls.autoRotate).toBe(false);
  });

  it("skips the warned-car shot when no car was warned", () => {
    const r = rig();
    const d = new Director(base, 0);
    const input = { ...base, replaySeq: 1, replayIncident, incidentSeq: 1, incident };
    run(d, input, 0, 9.2, r);
    expect(d.stage).toBe("overview");
  });

  it("pauses with the tab: a long gap between frames does not skip stages", () => {
    const r = rig();
    const d = new Director(base, 0);
    const input = { ...base, replaySeq: 1, replayIncident, incidentSeq: 1, incident, warning };
    run(d, input, 0, 1, r);
    expect(d.stage).toBe("impact");
    d.update(input, 0, 0.1, r.camera, r.controls, scale, tower);    // the frame after a 30 s hidden tab (dt clamped)
    expect(d.stage).toBe("impact");
  });

  it("hands the camera back on Skip / drag and when cinematic is off", () => {
    const r = rig();
    const d = new Director(base, 0);
    const input = { ...base, replaySeq: 1, replayIncident };
    let t = run(d, input, 0, 1, r);
    expect(d.stage).toBe("approach");
    t = run(d, input, t, 0.1, r, 1);
    expect(d.stage).toBe("idle");
    const d2 = new Director(base, 0);
    run(d2, { ...input, cinematic: false }, t, 1, r);
    expect(d2.stage).toBe("idle");
  });
});
