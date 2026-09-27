import { describe, expect, it } from "vitest";
import type { ActiveIncident, Mast } from "@/types/raceControl";
import { initialRaceControlState, raceControlReducer } from "./raceControlState";

const mast = (sector: number, state: Mast["state"]): Mast => ({ sector, state, x: 0, y: 0, lap_frac: sector / 20, zone_id: "z", zone_name: "Z" });
const incident = { incident_id: "i1", zone_id: "z", x: 0, y: 0, rules: [] } as unknown as ActiveIncident;

describe("raceControlReducer", () => {
  it("starts clean for a new circuit and ignores the same one", () => {
    const s = raceControlReducer({ ...initialRaceControlState, circuit: "monza", deployment: "sc" }, { type: "circuit", circuit: "montreal" });
    expect(s.circuit).toBe("montreal");
    expect(s.deployment).toBe("green");
    expect(raceControlReducer(s, { type: "circuit", circuit: "montreal" })).toBe(s);
  });

  it("counts incidents and attaches rules only to the matching one", () => {
    let s = raceControlReducer(initialRaceControlState, { type: "incident", data: incident });
    expect(s.incidentSeq).toBe(1);
    s = raceControlReducer(s, { type: "rules", data: { incident_id: "other", rules: [{ citation: "x" } as never] } });
    expect(s.incident?.rules).toHaveLength(0);
    s = raceControlReducer(s, { type: "rules", data: { incident_id: "i1", rules: [{ citation: "x" } as never] } });
    expect(s.incident?.rules).toHaveLength(1);
  });

  it("clears the incident and grip hazards when the track goes green", () => {
    let s = raceControlReducer(initialRaceControlState, { type: "incident", data: incident });
    s = raceControlReducer(s, { type: "grip", data: { segment: 3, level: "ALERT", sector: 2, cars: ["1", "2"], min_residual: 0.5 } });
    expect(s.hazards).toHaveLength(1);
    s = raceControlReducer(s, { type: "deployment", data: { deployment: "sc", label: "", at: "" } });
    expect(s.incident).not.toBeNull();
    s = raceControlReducer(s, { type: "deployment", data: { deployment: "green", label: "", at: "" } });
    expect(s.incident).toBeNull();
    expect(s.hazards).toHaveLength(0);
  });

  it("replaces masts and keeps the log newest first", () => {
    let s = raceControlReducer(initialRaceControlState, { type: "masts", data: { masts: [mast(1, "double_yellow")] } });
    expect(s.masts[0]?.state).toBe("double_yellow");
    s = raceControlReducer(s, { type: "log", data: { at: "a", text: "first", tone: "info", replay_t: 0 } });
    s = raceControlReducer(s, { type: "log", data: { at: "b", text: "second", tone: "alert", replay_t: 1 } });
    expect(s.log.map((l) => l.text)).toEqual(["second", "first"]);
  });

  it("tracks replay time from car frames", () => {
    let s = raceControlReducer(initialRaceControlState, {
      type: "replay_start",
      data: { incident_id: "i1", t: 0, t_start: -15, t_end: 14, speed: 2, running: true, incident: incident },
    });
    s = raceControlReducer(s, { type: "cars", data: { t: 3.5, cars: [] } });
    expect(s.replay?.t).toBe(3.5);
  });
});
