import { cn } from "@/lib/cn";
import type { Deployment, SuggestedFlag } from "@/types/raceControl";

const LABEL: Record<SuggestedFlag, string> = {
  YELLOW: "Yellow", SLIPPERY: "Slippery surface", DOUBLE_YELLOW: "Double yellow", VSC: "VSC", SC: "Safety Car", RED: "Red flag", CLEAR: "Clear",
};
const STYLE: Record<SuggestedFlag, string> = {
  YELLOW: "border-[#e0b000] bg-[#ffcc12] text-black",
  SLIPPERY: "border-[#e0b000] bg-[repeating-linear-gradient(90deg,#ffcc12_0_6px,#ff2a2a_6px_12px)] text-black",
  DOUBLE_YELLOW: "border-[#e0b000] bg-[#ffcc12] text-black shadow-[0_0_0_2px_var(--color-panel),0_0_0_3px_#ffcc12]",
  VSC: "border-[#ffb000] bg-black text-[#ffc233]",
  SC: "border-[#ffb000] bg-[#ffb000] text-black",
  RED: "border-risk-crit bg-risk-crit text-white",
  CLEAR: "border-risk-low bg-risk-low text-white",
};

export function FlagChip({ flag, className }: { flag: SuggestedFlag; className?: string }) {
  return (
    <span className={cn("inline-flex h-5 items-center rounded border px-1.5 text-[11px] font-bold uppercase tracking-wide", STYLE[flag], className)}>
      {LABEL[flag]}
    </span>
  );
}

export const DEPLOYMENT_LABEL: Record<Deployment, string> = { green: "Green flag", sc: "Safety Car", vsc: "Virtual Safety Car", red: "Red flag" };
