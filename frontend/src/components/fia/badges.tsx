import { cn } from "@/lib/cn";
import type { FlagSuggestion, Severity } from "@/types/fia";

const FLAG_LABEL: Record<FlagSuggestion, string> = {
  YELLOW_READY: "Yellow ready",
  YELLOW: "Yellow",
  DOUBLE_YELLOW: "Double yellow",
  VSC: "VSC",
  SC: "Safety car",
  RED: "Red flag",
  CLEAR: "Clear",
};

const FLAG_STYLE: Record<FlagSuggestion, string> = {
  YELLOW_READY: "border-risk-med text-risk-med",
  YELLOW: "border-risk-med bg-risk-med text-bg",
  DOUBLE_YELLOW: "border-risk-med bg-risk-med text-bg shadow-[0_0_0_2px_var(--color-bg),0_0_0_3px_var(--color-risk-med)]",
  VSC: "border-ink bg-ink text-bg",
  SC: "border-ink bg-ink text-bg",
  RED: "border-risk-crit bg-risk-crit text-ink",
  CLEAR: "border-risk-low bg-risk-low text-bg",
};

/** Suggested flag, e.g. "Yellow ready" / "VSC". */
export function FlagChip({ flag, className }: { flag: FlagSuggestion; className?: string }) {
  return (
    <span className={cn("inline-flex h-5 items-center rounded border px-1.5 text-[11px] font-semibold uppercase tracking-wide", FLAG_STYLE[flag], className)}>
      {FLAG_LABEL[flag]}
    </span>
  );
}

const LEVEL_STYLE: Record<Severity | "CRASH", string> = {
  ALERT: "bg-risk-crit text-ink",
  CRASH: "bg-risk-crit text-ink",
  WATCH: "bg-risk-med text-bg",
  NONE: "bg-risk-low text-bg",
};

export function LevelBadge({ level }: { level: Severity | "CRASH" }) {
  return (
    <span className={cn("num inline-flex h-5 items-center rounded px-1.5 text-[11px] font-semibold", LEVEL_STYLE[level])}>
      {level === "NONE" ? "CLEAR" : level}
    </span>
  );
}

/** Left-border colour for a message card by level. */
export const LEVEL_BORDER: Record<Severity | "CRASH", string> = {
  ALERT: "border-l-risk-crit",
  CRASH: "border-l-risk-crit",
  WATCH: "border-l-risk-med",
  NONE: "border-l-risk-low",
};
