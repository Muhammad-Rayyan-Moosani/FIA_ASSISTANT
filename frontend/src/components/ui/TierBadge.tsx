import { riskHex, riskRgba } from "@/lib/riskColor";
import type { RiskTier } from "@/types/risk";

export function TierBadge({ score, tier }: { score: number; tier: RiskTier }) {
  return (
    <div className="min-w-[76px] rounded-lg px-2.5 py-1.5 text-center" style={{ background: riskRgba(score, 0.16), color: riskHex(score) }} aria-label={`Risk score ${score}, ${tier}`}>
      <b className="display block text-2xl font-bold leading-none">{score}</b>
      <span className="text-[10px] font-semibold tracking-[0.1em]">{tier}</span>
    </div>
  );
}
