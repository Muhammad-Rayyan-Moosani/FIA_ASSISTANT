import Link from "next/link";
import { cn } from "@/lib/cn";

/** Circuit Guard wordmark: a shield around a circuit outline, and the name in the race-title face. */
export function Brand({ href = "/", size = "md", className }: { href?: string; size?: "md" | "lg"; className?: string }) {
  const lg = size === "lg";
  return (
    <Link href={href} className={cn("group inline-flex items-center gap-2.5", className)} aria-label="Circuit Guard, home">
      <svg viewBox="0 0 40 44" className={cn("shrink-0 drop-shadow-[0_2px_12px_rgba(225,6,0,0.45)]", lg ? "h-11 w-10" : "h-9 w-8")} aria-hidden="true">
        <defs>
          <linearGradient id="cg-shield" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="var(--color-accent)" />
            <stop offset="1" stopColor="var(--color-accent-2)" />
          </linearGradient>
        </defs>
        <path d="M20 2 L37 8 V21 C37 31 29.5 38.5 20 42 C10.5 38.5 3 31 3 21 V8 Z" fill="url(#cg-shield)" />
        <path d="M20 5.5 L34 10.4 V21 C34 29.2 28 35.4 20 38.5 C12 35.4 6 29.2 6 21 V10.4 Z" fill="var(--color-bg)" opacity="0.88" />
        {/* a small circuit: straight, hairpin, chicane */}
        <path
          d="M11 27 L11 17 Q11 13 15 13 L25 13 Q29 13 29 17 Q29 20 26 20 L22 20 Q20 20 20 22 Q20 24 22 24 L27 24 Q29 24 29 27 Q29 30 26 30 L14 30 Q11 30 11 27 Z"
          fill="none"
          stroke="url(#cg-shield)"
          strokeWidth="2.4"
          strokeLinejoin="round"
        />
        <circle cx="11" cy="21" r="1.8" fill="var(--color-ink)" />
      </svg>
      <span className={cn("race-title leading-none", lg ? "text-[30px]" : "text-[25px]")}>
        <span className="text-ink">Circuit</span> <span className="text-accent">Guard</span>
      </span>
    </Link>
  );
}
