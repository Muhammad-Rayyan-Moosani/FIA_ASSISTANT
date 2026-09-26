import type { RiskTier } from "@/types/risk";

type RGB = readonly [number, number, number];

/** Risk scale: green → amber → orange → red. Mirrors --color-risk-* in globals.css. */
const STOPS: readonly (readonly [number, RGB])[] = [
  [0, [63, 191, 138]],
  [45, [232, 178, 58]],
  [75, [240, 122, 58]],
  [100, [229, 72, 77]],
];

export function riskRgb(score: number): RGB {
  const s = Math.min(100, Math.max(0, score));
  for (let i = 1; i < STOPS.length; i++) {
    const [b, cb] = STOPS[i]!;
    if (s <= b) {
      const [a, ca] = STOPS[i - 1]!;
      const t = (s - a) / (b - a);
      return [0, 1, 2].map((k) => Math.round(ca[k]! + (cb[k]! - ca[k]!) * t)) as unknown as RGB;
    }
  }
  return STOPS[STOPS.length - 1]![1];
}

export function riskHex(score: number): string {
  return `#${riskRgb(score).map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

export function riskRgba(score: number, alpha: number): string {
  return `rgba(${riskRgb(score).join(", ")}, ${alpha})`;
}

export const TIER_ORDER: readonly RiskTier[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
