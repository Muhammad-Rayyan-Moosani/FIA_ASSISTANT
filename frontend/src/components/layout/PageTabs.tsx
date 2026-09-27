import Link from "next/link";
import { cn } from "@/lib/cn";
import { ThemeToggle } from "./ThemeToggle";

export type AppPage = "insurance" | "fia";

const PAGES: { id: AppPage; href: string; label: string; title: string }[] = [
  { id: "insurance", href: "/insurance", label: "Insurance", title: "Zone-based circuit insurance" },
  { id: "fia", href: "/fia", label: "FIA", title: "Race control: μMap grip alerts, camera checks, rulebook" },
];

/** Switches between the app's pages (and holds the day / night switch); styled like SegmentedControl. */
export function PageTabs({ active }: { active: AppPage }) {
  return (
    <div className="flex items-center gap-2.5">
    <nav aria-label="Pages" className="inline-flex rounded-lg border border-line bg-bg p-0.5">
      {PAGES.map((p) => {
        const current = p.id === active;
        return (
          <Link
            key={p.id}
            href={p.href}
            title={p.title}
            aria-current={current ? "page" : undefined}
            className={cn(
              "inline-flex h-8 items-center whitespace-nowrap rounded-md px-3 text-[13px] font-medium transition-colors",
              current ? "bg-panel-2 text-ink shadow-[inset_0_0_0_1px_var(--color-line)]" : "text-muted hover:text-ink",
            )}
          >
            {p.label}
          </Link>
        );
      })}
    </nav>
    <ThemeToggle />
    </div>
  );
}
