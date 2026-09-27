import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import type { ActiveIncident, DriverWarning, IncidentSummary, Mast, StoryInput } from "@/types/raceControl";
import { storyCallouts } from "./calloutRules";

const replayIncident = { x: 0, y: 0, session_type: "Race", season: 2025, involved: [{ number: "4", code: "NOR", team: "McLaren" }], impact: { driver: "4" } } as unknown as IncidentSummary;
const incident = {
  x: 0, y: 0, zone_name: "To the line", marshal_sector: 1, raw_message: "DOUBLE YELLOW IN TRACK SECTOR 1", involved: [{ number: "4", code: "NOR" }],
  collision: { driver: "4", level: "crash", impact_speed_kph: 286, peak_long_g: 3.4, stopped: true }, advice: { flag: "SC" },
} as unknown as ActiveIncident;
const warning = { driver: "30", code: "LAW", title: "CRASH AHEAD", lines: ["CRASH AHEAD · SECTOR 1"], distance_m: 235 } as unknown as DriverWarning;
const masts = [{ sector: 1, state: "double_yellow", x: 0, y: 0 }, { sector: 15, state: "yellow", x: 0, y: 0 }] as unknown as Mast[];
const input: StoryInput = { cinematic: true, replaySeq: 1, incidentSeq: 1, replayIncident, incident, warning, deployment: "green", masts };
const tower = new Vector3(1, 1, 1);
const ids = (stage: Parameters<typeof storyCallouts>[0], i: StoryInput = input) => storyCallouts(stage, i, tower, "in the paddock building").map((c) => c.id);

describe("story callouts", () => {
  it("labels the followed car before the impact with its live speed", () => {
    const c = storyCallouts("approach", { ...input, incident: null }, tower, null);
    expect(c.map((x) => x.id)).toEqual(["subject"]);
    expect(c[0]!.title).toBe("Car 4 (NOR)");
    expect(c[0]!.liveSpeed).toBe("4");
  });

  it("adds race control, then the warned car, then the marshal post, stage by stage", () => {
    expect(ids("impact")).toEqual(["crash"]);
    expect(ids("race_control")).toEqual(["crash", "rc"]);
    expect(ids("drivers")).toEqual(["crash", "rc", "warned"]);
    expect(ids("overview")).toEqual(["crash", "rc", "warned", "mast"]);
    expect(ids("idle")).toEqual(["crash"]);          // the crash stays labelled after the story
  });

  it("says what race control received and what it suggests, then what it did", () => {
    const rc = storyCallouts("race_control", input, tower, null).find((c) => c.id === "rc")!;
    expect(rc.lines).toContain("Signal received from the track");
    expect(rc.lines).toContain("Suggests: Safety Car");
    expect(rc.lines.join(" ")).toContain("S1 double yellow");
    const sc = storyCallouts("overview", { ...input, deployment: "sc" }, tower, null).find((c) => c.id === "rc")!;
    expect(sc.lines[0]).toBe("Safety Car deployed");
    const warned = storyCallouts("drivers", input, tower, null).find((c) => c.id === "warned")!;
    expect(warned.title).toBe("Car 30 (LAW) notified");
    expect(warned.lines).toContain("235 m to the incident");
  });
});
