import { describe, expect, it } from "vitest";
import { formatEur, formatEurDelta, formatFraction, formatLapTime } from "./format";

describe("formatEur", () => {
  it.each([
    [950, "€950"],
    [8_400, "€8.4k"],
    [245_300, "€245k"],
    [1_240_000, "€1.24M"],
    [12_300_000, "€12.3M"],
    [-3_400, "−€3.4k"],
  ])("%d → %s", (input, expected) => expect(formatEur(input)).toBe(expected));

  it("handles non-finite values", () => expect(formatEur(Number.NaN)).toBe("–"));
});

describe("other formatters", () => {
  it("formats signed deltas", () => {
    expect(formatEurDelta(1200)).toBe("+€1.2k");
    expect(formatEurDelta(-3400)).toBe("−€3.4k");
    expect(formatEurDelta(0.1)).toBe("no change");
  });
  it("formats fractions", () => expect(formatFraction(0.539, 1)).toBe("53.9%"));
  it("formats lap times", () => expect(formatLapTime(84.916)).toBe("1:24.916"));
});
