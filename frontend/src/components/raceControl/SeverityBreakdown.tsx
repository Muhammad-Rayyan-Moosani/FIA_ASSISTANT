import { Panel } from "@/components/ui/Panel";
import { cn } from "@/lib/cn";
import type { SeverityResult } from "@/types/raceControl";

const LABEL_TONE: Record<string, string> = {
  "Low slip": "text-risk-low", "Medium incident": "text-risk-med", "Critical crash": "text-risk-crit",
};
const SOURCE = {
  provenance: "modelled" as const,
  title: "Multimodal severity",
  detail:
    "Three legs fused with fixed weights (a missing leg is dropped and the rest renormalised):\n\n" +
    "Telemetry 60%: the physics collision estimator on the real OpenF1 speed and position samples (impact load, ½mv² energy, speed lost, stopped car).\n\n" +
    "Voice 25%: Hugging Face models run locally on the real team-radio clip. openai/whisper-base.en transcribes it; j-hartmann/emotion-english-distilroberta-base reads the transcript (distress = fear + sadness + 0.6 anger + 0.4 surprise), blended with crash and reassurance keywords.\n\n" +
    "Audio 15%: signal features of the clip (loudness, vocal strain, sharp transients). Plain signal processing, not a trained model.\n\n" +
    "Labels: under 0.35 Low slip, under 0.65 Medium incident, otherwise Critical crash.",
};

function Bar({ label, value, weight, note }: { label: string; value: number | null | undefined; weight: number | undefined; note?: string }) {
  const v = value ?? 0;
  return (
    <div className="grid grid-cols-[88px_1fr_44px] items-center gap-2 text-[12px]">
      <span className="text-muted">{label}{weight !== undefined && <span className="text-faint"> · {Math.round(weight * 100)}%</span>}</span>
      <div className="h-2 rounded-full bg-bg">
        {value !== null && value !== undefined && (
          <div className="h-2 rounded-full bg-[linear-gradient(90deg,var(--color-risk-low),var(--color-risk-med),var(--color-risk-crit))] bg-[length:var(--w)_100%]"
            style={{ width: `${Math.max(3, v * 100)}%`, ["--w" as string]: `${100 / Math.max(v, 0.03)}%` }} />
        )}
      </div>
      <span className="num text-right text-[11.5px]">{value === null || value === undefined ? (note ?? "n/a") : `${Math.round(v * 100)}%`}</span>
    </div>
  );
}

/** Telemetry physics + driver radio, fused into one severity (backend/services/multimodal_severity.py). */
export function SeverityBreakdown({ severity }: { severity: SeverityResult | null }) {
  if (!severity) return null;
  const radio = severity.radio;
  const emotions = Object.entries(radio?.voice?.emotions ?? {}).slice(0, 3);
  return (
    <Panel title="Multimodal severity" source={SOURCE}>
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className={cn("display text-[28px] font-bold uppercase leading-none", LABEL_TONE[severity.label ?? ""] ?? "text-muted")}>
            {severity.label ?? "No signal"}
          </div>
          <div className="mt-1 text-[11px] text-faint">
            {severity.radio_pending ? "Telemetry now · radio being transcribed by the local models…" : radio ? "Telemetry + driver radio" : "Telemetry only · no radio released for this incident"}
          </div>
        </div>
        <div className="num text-[34px] font-semibold leading-none">{severity.score !== null ? Math.round(severity.score * 100) : "–"}<span className="text-sm text-faint">/100</span></div>
      </div>
      <div className="grid gap-1.5">
        <Bar label="Telemetry" value={severity.telemetry?.telemetry_score} weight={severity.weights.telemetry} note="no impact" />
        <Bar label="Voice" value={radio?.voice?.score} weight={severity.weights.voice} note={severity.radio_pending ? "…" : "n/a"} />
        <Bar label="Audio" value={radio?.audio?.score} weight={severity.weights.audio} note={severity.radio_pending ? "…" : "n/a"} />
      </div>
      {radio?.transcript && (
        <figure className="rounded-lg border border-line-soft bg-bg px-3 py-2">
          <blockquote className="text-[13px] italic leading-snug">“{radio.transcript}”</blockquote>
          <figcaption className="mt-1.5 flex flex-wrap gap-1.5 text-[11px] text-muted">
            {radio.driver && <span>Car {radio.driver}{radio.offset_s !== null ? ` · ${radio.offset_s >= 0 ? "+" : ""}${Math.round(radio.offset_s)} s` : ""}</span>}
            {emotions.map(([k, v]) => <span key={k} className="rounded bg-panel-2 px-1.5">{k} {Math.round(v * 100)}%</span>)}
            {radio.voice?.keywords.map((k) => <span key={k} className="rounded bg-risk-high/15 px-1.5 text-risk-high">“{k}”</span>)}
            {radio.voice?.reassured && <span className="rounded bg-risk-low/15 px-1.5 text-risk-low">driver OK</span>}
          </figcaption>
        </figure>
      )}
      {(severity.radio_error || radio?.error) && <p className="text-[11.5px] text-risk-high">Radio: {severity.radio_error ?? radio?.error}</p>}
      <p className="text-[10.5px] text-faint">Transcribed by openai/whisper-base.en; emotion by j-hartmann/emotion-english-distilroberta-base. Both run locally.</p>
    </Panel>
  );
}
