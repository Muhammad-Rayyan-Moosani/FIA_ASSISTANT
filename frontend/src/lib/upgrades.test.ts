import { describe, expect, it } from "vitest";
import type { TrackZone } from "@/types/track";
import { diffChanges, isEmptyChanges, serializeUpgrades, withoutZone } from "./upgrades";

const zone = { zone_id: "monza-parabolica", barrier_type: "tyre_wall", runoff_depth_m: 60, fence_height_m: 4 } as TrackZone;

describe("serializeUpgrades", () => {
  it("omits empty sets", () => {
    expect(serializeUpgrades(undefined)).toBeUndefined();
    expect(serializeUpgrades({})).toBeUndefined();
    expect(serializeUpgrades({ a: {} })).toBeUndefined();
  });

  it("is stable regardless of key order", () => {
    const a = serializeUpgrades({ z2: { fence_height_m: 5, barrier_type: "tecpro" }, z1: { runoff_depth_m: 80 } });
    const b = serializeUpgrades({ z1: { runoff_depth_m: 80 }, z2: { barrier_type: "tecpro", fence_height_m: 5 } });
    expect(a).toBe(b);
    expect(a).toBe('{"z1":{"runoff_depth_m":80},"z2":{"barrier_type":"tecpro","fence_height_m":5}}');
  });
});

describe("diffChanges", () => {
  it("keeps only fields that differ from the zone", () => {
    expect(diffChanges(zone, { barrier_type: "tecpro", runoff_depth_m: 60, fence_height_m: 4 })).toEqual({ barrier_type: "tecpro" });
  });
  it("returns an empty object when nothing changed", () => {
    expect(isEmptyChanges(diffChanges(zone, { barrier_type: "tyre_wall", runoff_depth_m: 60, fence_height_m: 4 }))).toBe(true);
  });
});

it("withoutZone removes one zone without mutating the input", () => {
  const set = { a: { fence_height_m: 5 }, b: { runoff_depth_m: 90 } };
  expect(withoutZone(set, "a")).toEqual({ b: { runoff_depth_m: 90 } });
  expect(set).toHaveProperty("a");
});
