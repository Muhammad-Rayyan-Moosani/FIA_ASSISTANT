import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/Panel";
import type { Transcription } from "@/types/fia";
import { CitationCard } from "./RulebookPanel";

interface RadioPanelProps {
  result: Transcription | undefined;
  isPending: boolean;
  error: string | null;
  onRun: () => void;
}

/** Team radio → transcript → the articles it points to. Each spoken segment is matched on its own. */
export function RadioPanel({ result, isPending, error, onRun }: RadioPanelProps) {
  return (
    <Panel title="Team radio" description="Sample clip: the transcript is a fixture in faster-whisper's output format; the rule matching runs live.">
      <div>
        <Button onClick={onRun} disabled={isPending}>
          {isPending ? "Processing…" : "🎙 Process sample radio clip"}
        </Button>
      </div>
      {error && <p className="text-[12.5px] text-risk-crit">{error}</p>}
      {result && (
        <div className="grid gap-2" aria-live="polite">
          <div className="rounded-lg border border-line bg-panel-2 px-3 py-2">
            {result.segments.map((s) => (
              <p key={s.start} className="text-[12.5px] leading-relaxed">
                <span className="num mr-2 text-[11px] text-faint">
                  {s.start.toFixed(1)}–{s.end.toFixed(1)}s
                </span>
                {s.text}
              </p>
            ))}
            <p className="num mt-1.5 text-[10.5px] text-faint">
              {result.model} · {result.duration_s}s · {result.language ?? "?"}
            </p>
          </div>
          {result.related_rules.map((c, i) => (
            <CitationCard key={`${c.article}-${i}`} c={c} faded={i > 0} />
          ))}
        </div>
      )}
    </Panel>
  );
}
