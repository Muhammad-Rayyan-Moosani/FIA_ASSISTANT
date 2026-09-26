import { cn } from "@/lib/cn";

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  title?: string;
  disabled?: boolean;
}

interface SegmentedControlProps<T extends string> {
  label: string;
  options: readonly SegmentOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  tone?: "neutral" | "accent";
  className?: string;
}

export function SegmentedControl<T extends string>({ label, options, value, onChange, tone = "neutral", className }: SegmentedControlProps<T>) {
  return (
    <div role="group" aria-label={label} className={cn("inline-flex rounded-lg border border-line bg-bg p-0.5", className)}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            title={o.title}
            disabled={o.disabled}
            aria-pressed={active}
            onClick={() => onChange(o.value)}
            className={cn(
              "h-8 whitespace-nowrap rounded-md px-3 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40",
              !active && "text-muted hover:text-ink",
              active && tone === "neutral" && "bg-panel-2 text-ink shadow-[inset_0_0_0_1px_var(--color-line)]",
              active && tone === "accent" && "bg-accent text-accent-ink",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
