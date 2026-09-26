import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import type { SourceInfo } from "@/types/api";
import { SourceBadge } from "./SourceBadge";

interface PanelProps {
  title?: string;
  source?: SourceInfo;
  actions?: ReactNode;
  description?: ReactNode;
  className?: string;
  children: ReactNode;
}

/** A section of the side rail. */
export function Panel({ title, source, actions, description, className, children }: PanelProps) {
  return (
    <section className={cn("grid gap-3 border-b border-line px-5 py-[18px]", className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3">
          {title && (
            <h2 className="eyebrow flex items-center">
              {title}
              <SourceBadge source={source} />
            </h2>
          )}
          {actions}
        </header>
      )}
      {description && <p className="-mt-1.5 text-xs text-faint">{description}</p>}
      {children}
    </section>
  );
}
