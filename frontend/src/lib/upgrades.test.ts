import { describe, expect, it } from "vitest";
import type { TrackZone } from "@/types/track";
import { diffChanges, isEmptyChanges, serializeUpgrades, withoutZone } from "./upgrades";

const zone = { zone_id: "monza-z10", barrier_type: "tyre_wall" } as TrackZone;

describe("serializeUpgrades", () => {
  it("omits empty sets", () => {
    expect(serializeUpgrades(undefined)).toBeUndefined();
    expect(serializeUpgrades({})).toBeUndefined();
    expect(serializeUpgrades({ a: {} })).toBeUndefined();
  });

  it("is stable regardless of key order", () => {
    const a = serializeUpgrades({ z2: { frequency_multiplier: 0.8, barrier_type: "tecpro" }, z1: { speed_factor: 0.9 } });
    const b = serializeUpgrades({ z1: { speed_factor: 0.9 }, z2: { barrier_type: "tecpro", frequency_multiplier: 0.8 } });
    expect(a).toBe(b);
    expect(a).toBe('{"z1":{"speed_factor":0.9},"z2":{"barrier_type":"tecpro","frequency_multiplier":0.8}}');
  });
});

describe("diffChanges", () => {
  it("keeps only fields that differ from the zone", () => {
    expect(diffChanges(zone, { barrier_type: "tecpro", speed_factor: 1, frequency_multiplier: 0.8 })).toEqual({ barrier_type: "tecpro", frequency_multiplier: 0.8 });
  });
  it("returns an empty object when nothing changed", () => {
    expect(isEmptyChanges(diffChanges(zone, { barrier_type: "tyre_wall", speed_factor: 1, frequency_multiplier: 1 }))).toBe(true);
  });
});

it("withoutZone removes one zone without mutating the input", () => {
  const set = { a: { speed_factor: 0.9 }, b: { frequency_multiplier: 0.7 } };
  expect(withoutZone(set, "a")).toEqual({ b: { frequency_multiplier: 0.7 } });
  expect(set).toHaveProperty("a");
});
