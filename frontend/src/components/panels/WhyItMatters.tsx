import { Panel } from "@/components/ui/Panel";
import { formatNumber } from "@/lib/format";
import type { ExposureMap } from "@/types/exposure";

function Source({ href }: { href: string | null }) {
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noreferrer" className="ml-1 text-[11px] text-accent underline-offset-2 hover:underline">
      source
    </a>
  );
}

/** Why the insurer should care, and what the owner does with this. Sourced facts only. */
export function WhyItMatters({ exposure }: { exposure: ExposureMap | undefined }) {
  if (!exposure) return null;
  const c = exposure.context;

  return (
    <Panel title="Why it matters">
      <ul className="grid gap-2.5 text-[12.5px] leading-snug">
        {c.history && (
          <li className="grid grid-cols-[44px_1fr] gap-2.5">
            <span className="display text-[17px] font-semibold text-risk-crit">{c.history_year}</span>
            <span className="text-muted">
              {c.history}
              <Source href={c.history_source} />
            </span>
          </li>
        )}
        {c.attendance && (
          <li className="grid grid-cols-[44px_1fr] gap-2.5">
            <span className="display text-[17px] font-semibold text-ink">{formatNumber(Math.round(c.attendance / 1000))}k</span>
            <span className="text-muted">
              people at the {c.attendance_year} race weekend.
              <Source href={c.attendance_source} />
            </span>
          </li>
        )}
        <li className="grid grid-cols-[44px_1fr] gap-2.5">
          <span className="display text-[17px] font-semibold text-ink">FIA</span>
          <span className="text-muted">
            {c.task_force}
            <Source href={c.task_force_source} />
          </span>
        </li>
      </ul>

      <div className="rounded-lg border border-accent/40 bg-accent/10 px-3 py-2.5 text-[12.5px] leading-snug">
        <b className="text-ink">What the owner does with this:</b>{" "}
        <span className="text-muted">
          hands it to the insurer instead of letting them guess, protects the corners above first, and shows next season&apos;s data to earn a
          fairer premium. We don&apos;t set the price; the evidence does.
        </span>
      </div>
    </Panel>
  );
}
