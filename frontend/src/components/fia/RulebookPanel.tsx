"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/Panel";
import type { RuleCitation } from "@/types/fia";

export function CitationCard({ c, faded = false }: { c: RuleCitation; faded?: boolean }) {
  return (
    <article className={faded ? "rounded-lg border border-line bg-panel-2 px-3 py-2 opacity-65" : "rounded-lg border border-line bg-panel-2 px-3 py-2"}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="num text-[12.5px] font-medium text-accent">{c.article ? (c.article.startsWith("Appendix") ? c.article : `Art. ${c.article}`) : "—"}</span>
        <span className="num text-[11px] text-muted">p. {c.page} · score {c.score.toFixed(2)}</span>
      </div>
      <p className="mt-1 line-clamp-4 text-[12.5px] leading-snug">{c.text}</p>
      <p className="mt-1 truncate text-[10.5px] text-faint" title={c.document}>{c.document}</p>
    </article>
  );
}

interface RulebookPanelProps {
  documents: string[];
  samples: string[];
  citations: RuleCitation[] | undefined;
  isPending: boolean;
  error: string | null;
  onSearch: (incident: string) => void;
}

/** Stewards describe an incident in plain English and get the exact article and page back. */
export function RulebookPanel({ documents, samples, citations, isPending, error, onSearch }: RulebookPanelProps) {
  const [text, setText] = useState("");
  const search = (q: string) => {
    const incident = q.trim();
    if (incident.length < 3) return;
    setText(incident);
    onSearch(incident);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    search(text);
  };

  return (
    <Panel title="FIA rulebook" description={documents.length ? `Searching: ${documents.join(", ")}` : "No rulebook indexed yet."}>
      <form onSubmit={submit} className="flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Describe an incident…"
          aria-label="Incident description"
          className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 text-sm placeholder:text-faint"
        />
        <Button type="submit" variant="primary" disabled={isPending || text.trim().length < 3}>
          {isPending ? "Searching…" : "Search"}
        </Button>
      </form>
      <div className="flex flex-wrap gap-1.5">
        {samples.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => search(q)}
            className="rounded-full border border-line bg-panel-2 px-2.5 py-1 text-left text-[11.5px] text-muted transition-colors hover:border-faint hover:text-ink"
          >
            {q}
          </button>
        ))}
      </div>
      {error && <p className="text-[12.5px] text-risk-crit">{error}</p>}
      {citations && (
        <div className="grid gap-2" aria-live="polite">
          {citations.length === 0 && <p className="text-[12.5px] text-faint">No matching article.</p>}
          {citations.map((c, i) => (
            <CitationCard key={`${c.article}-${i}`} c={c} faded={i > 0} />
          ))}
        </div>
      )}
    </Panel>
  );
}
