import { describe, expect, it } from "vitest";
import type { CarPositionMessage, CrashMessage, HazardMessage, PlainAlert } from "@/types/fia";
import { FEED_LIMIT, TRAIL_LIMIT, carPhase, cellRect, feedReducer, initialFeedState, residualTone } from "./fiaFeed";

const plain = (headline: string, level: PlainAlert["level"] = "WATCH"): PlainAlert => ({
  level, colour: level === "ALERT" ? "red" : "amber", changed_from: "NONE", headline, why: "", action: "",
  flag: "YELLOW_READY", cars: [], where: "Turn 1", text: headline, say: headline, note: "Suggestion only. Race control decides.",
});

const hazard = (sector: string, level: HazardMessage["severity_level"]): HazardMessage => ({
  type: "hazard", sector_id: sector, coordinates: { x: 560, y: 10 }, severity_level: level, previous_level: "NONE",
  evidence_card_data: { hazard_types: ["grip_cliff"], cars_flagged: ["1"], min_residual: 0.46, mean_residual: 0.5, flag_count: 3, vision: [], narrative: "" },
  timestamp: 31, plain: plain(`SLIPPERY at ${sector}`, level),
});

const position = (car: string, x: number, residual: number | null = null): CarPositionMessage => ({
  type: "car_position", car_id: car, timestamp: x, x, y: 10, speed_kph: 300, brake: 100, throttle: 0, residual, below_threshold: false,
});

describe("feedReducer", () => {
  it("tracks active cells, feed and the race-director message", () => {
    let s = feedReducer(initialFeedState, hazard("grid_22_0", "WATCH"));
    s = feedReducer(s, hazard("grid_22_0", "ALERT"));
    expect(s.cells).toEqual({ grid_22_0: "ALERT" });
    expect(s.feed.map((e) => e.plain.headline)).toEqual(["SLIPPERY at grid_22_0", "SLIPPERY at grid_22_0"]);
    expect(s.feed[0]!.id).toBeGreaterThan(s.feed[1]!.id);
    expect(s.director?.level).toBe("ALERT");
    s = feedReducer(s, hazard("grid_22_0", "NONE"));
    expect(s.cells).toEqual({});
  });

  it("builds per-car trails and caps them", () => {
    let s = initialFeedState;
    for (let i = 0; i < TRAIL_LIMIT + 5; i++) s = feedReducer(s, position("1", i, 0.5));
    s = feedReducer(s, position("2", 1));
    expect(s.cars.map((c) => c.id)).toEqual(["1", "2"]);
    expect(s.cars[0]!.trail).toHaveLength(TRAIL_LIMIT);
    expect(s.cars[0]!.x).toBe(TRAIL_LIMIT + 4);
  });

  it("records crashes, caps the feed and clears on reset", () => {
    const crash: CrashMessage = {
      type: "crash", driver: "2", driver_code: null, kind: "stop+hit", impact_speed_kph: 172, peak_decel_g: 18.4,
      still_moving: false, coordinates: { x: 654, y: 3 }, severity_level: "ALERT", timestamp: 44, plain: plain("CRASH at Turn 1", "ALERT"),
    };
    let s = feedReducer(initialFeedState, crash);
    expect(s.crashes).toEqual([{ x: 654, y: 3 }]);
    for (let i = 0; i < FEED_LIMIT + 3; i++) s = feedReducer(s, hazard(`grid_${i}_0`, "WATCH"));
    expect(s.feed).toHaveLength(FEED_LIMIT);
    const reset = feedReducer(s, { type: "demo_reset" });
    expect(reset.feed).toEqual([]);
    expect(reset.crashes).toEqual([]);
    expect(reset.nextId).toBe(s.nextId);
  });

  it("ignores messages it does not render", () => {
    expect(feedReducer(initialFeedState, { type: "pong" })).toBe(initialFeedState);
  });
});

describe("helpers", () => {
  it("maps grid sector ids to 25 m cells", () => {
    expect(cellRect("grid_22_0", 25)).toEqual({ x: 550, y: 0, size: 25 });
    expect(cellRect("grid_-3_-1", 25)).toEqual({ x: -75, y: -25, size: 25 });
    expect(cellRect("seg_0042", 25)).toBeNull();
  });

  it("bands residuals", () => {
    expect(residualTone(null, 0.75)).toBeNull();
    expect(residualTone(1.01, 0.75)).toBe("normal");
    expect(residualTone(0.8, 0.75)).toBe("reduced");
    expect(residualTone(0.46, 0.75)).toBe("cliff");
  });

  it("names the driving phase", () => {
    expect(carPhase({ brake: 100, throttle: 0 })).toBe("BRAKING");
    expect(carPhase({ brake: 0, throttle: 100 })).toBe("FULL THROTTLE");
    expect(carPhase({ brake: 0, throttle: 35 })).toBe("CORNER");
  });
});
