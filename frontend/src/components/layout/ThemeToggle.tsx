"use client";

import { useEffect } from "react";
import { cn } from "@/lib/cn";
import { useThemeStore, type Theme } from "@/store/themeStore";

const Sun = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 2.5v2.2M12 19.3v2.2M4.7 4.7l1.6 1.6M17.7 17.7l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.7 19.3l1.6-1.6M17.7 6.3l1.6-1.6" />
  </svg>
);
const Moon = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">
    <path d="M20.5 14.6A8.6 8.6 0 0 1 9.4 3.5a8.6 8.6 0 1 0 11.1 11.1Z" />
  </svg>
);

const OPTIONS: { id: Theme; label: string; icon: () => React.ReactElement }[] = [
  { id: "day", label: "Day", icon: Sun },
  { id: "night", label: "Night", icon: Moon },
];

/** Day / night switch for the whole app: light or dark interface, and daylight or night on the 3D twin. */
export function ThemeToggle() {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const sync = useThemeStore((s) => s.sync);
  useEffect(() => sync(), [sync]);

  return (
    <div role="radiogroup" aria-label="Theme" className="inline-flex rounded-lg border border-line bg-bg p-0.5">
      {OPTIONS.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={theme === id}
          title={`${label} mode`}
          onClick={() => setTheme(id)}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors",
            theme === id ? "bg-panel-2 text-ink shadow-[inset_0_0_0_1px_var(--color-line)]" : "text-muted hover:text-ink",
          )}
        >
          <Icon />
          <span className="max-sm:sr-only">{label}</span>
        </button>
      ))}
    </div>
  );
}
