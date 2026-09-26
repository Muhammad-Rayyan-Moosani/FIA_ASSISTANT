import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import type { SourceInfo } from "@/types/api";
import { SourceBadge } from "./SourceBadge";

interface StatProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  source?: SourceInfo;
  size?: "sm" | "md" | "lg";
  className?: string;
  valueClassName?: string;
}

const VALUE_SIZE = {
  sm: "num text-[15px] leading-snug",
  md: "num text-[17px] leading-snug",
  lg: "display text-[34px] font-semibold leading-none",
} as const;

export function Stat({ label, value, hint, source, size = "md", className, valueClassName }: StatProps) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="text-[11.5px] leading-snug text-muted">
        {label}
        <SourceBadge source={source} />
      </div>
      <div className={cn("mt-1", VALUE_SIZE[size], valueClassName)}>{value}</div>
      {hint && <div className="mt-0.5 text-[11.5px] text-muted">{hint}</div>}
    </div>
  );
}
