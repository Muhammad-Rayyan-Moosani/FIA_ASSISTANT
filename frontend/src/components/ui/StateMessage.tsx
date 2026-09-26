import type { ReactNode } from "react";
import { IconAlert } from "@/assets/icons";
import { cn } from "@/lib/cn";

interface StateMessageProps {
  tone?: "error" | "empty" | "info";
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function StateMessage({ tone = "info", title, children, action, className }: StateMessageProps) {
  return (
    <div role={tone === "error" ? "alert" : "status"} className={cn("grid justify-items-start gap-2 rounded-xl border border-line bg-panel/80 p-4 text-sm", className)}>
      <div className={cn("flex items-center gap-2 font-medium", tone === "error" ? "text-risk-crit" : "text-ink")}>
        {tone === "error" && <IconAlert />}
        {title}
      </div>
      {children && <div className="max-w-[60ch] text-[13px] text-muted">{children}</div>}
      {action}
    </div>
  );
}
