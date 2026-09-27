"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/Panel";
import type { RuleCitation } from "@/types/raceControl";

interface RulesCardProps {
  citations: RuleCitation[];
  pending: boolean;
  error: string | null;
  onSearch: (q: string) => void;
}

/** FIA 2026 Sporting Regulations articles for the incident (local embedding search over the real PDF). */
export function RulesCard({ citations, pending, error, onSearch }: RulesCardProps) {
  const [q, setQ] = useState("");
  return (
    <Panel title="FIA regulations" description="FIA 2026 F1 Sporting Regulations (Section B, issue 8), searched with all-MiniLM-L6-v2.">
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (q.trim().length > 2) onSearch(q.trim()); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. overtaking under double yellow"
          className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 text-[13px] outline-none placeholder:text-faint focus:border-accent" />
        <Button type="submit" size="sm" disabled={pending}>{pending ? "…" : "Search"}</Button>
      </form>
      {error && <p className="text-[12px] text-risk-high">{error}</p>}
      <ul className="grid gap-2">
        {citations.map((c) => (
          <li key={`${c.article}-${c.page}`} className="rounded-lg border border-line-soft bg-bg px-3 py-2">
            <div className="flex items-baseline justify-between gap-2 text-[12px] font-semibold">
              <span>{c.article ? `Art. ${c.article}` : c.document}</span>
              <span className="num text-[11px] font-normal text-faint">p. {c.page} · {Math.round(c.score * 100)}%</span>
            </div>
            {c.heading && <div className="text-[11px] text-faint">{c.heading}</div>}
            <p className="mt-1 line-clamp-4 text-[12px] leading-snug text-muted">{c.text}</p>
          </li>
        ))}
        {!citations.length && !pending && <li className="text-[12px] text-faint">Articles appear here with each incident, or search above.</li>}
      </ul>
    </Panel>
  );
}
