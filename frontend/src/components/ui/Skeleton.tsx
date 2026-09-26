import { cn } from "@/lib/cn";

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("animate-pulse rounded-md bg-panel-2", className)} />;
}

export function PanelSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="grid gap-3 border-b border-line px-5 py-[18px]" aria-busy="true">
      <Skeleton className="h-3 w-32" />
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-8 w-full" />
      ))}
    </div>
  );
}
