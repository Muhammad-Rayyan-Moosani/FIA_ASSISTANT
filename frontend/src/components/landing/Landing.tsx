"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Brand } from "@/components/layout/Brand";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { Button } from "@/components/ui/Button";
import { StateMessage } from "@/components/ui/StateMessage";
import { useCircuits } from "@/hooks/ingestion/useCircuits";
import { useIngestionStream } from "@/hooks/ingestion/useIngestionStream";
import { useExposure } from "@/hooks/insurance/useExposure";
import { cn } from "@/lib/cn";
import { formatFraction } from "@/lib/format";
import { UPLOADS, checkUpload, type CheckResult, type UploadKey, type UploadSpec } from "@/lib/uploadFiles";
import { useUiStore } from "@/store/uiStore";
import type { IngestStage } from "@/types/track";

type Picked = { fileName: string; result: CheckResult };

const STAGES: { key: IngestStage; label: string }[] = [
  { key: "fetch", label: "Checking your files" },
  { key: "load", label: "Reading the incident log" },
  { key: "zones", label: "Building track zones from the layout" },
  { key: "extract", label: "Classifying incidents" },
  { key: "geolocate", label: "Placing incidents on the track" },
  { key: "write", label: "Saving the analysis" },
];
/** Each stage stays on screen at least this long, so the run can be followed. */
const STAGE_MIN_MS = 700;

/** Front page: what the tool does, the circuit upload, and the analysis run. */
export function Landing() {
  const router = useRouter();
  const circuits = useCircuits();
  const setCircuit = useUiStore((s) => s.setCircuit);

  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Partial<Record<UploadKey, Picked>>>({});
  const [target, setTarget] = useState<string | null>(null);
  const [unknown, setUnknown] = useState(false);
  const ingestion = useIngestionStream(target);
  const exposure = useExposure(ingestion.state.status === "succeeded" ? target : null);

  const ready = UPLOADS.every((u) => !u.required || picked[u.key]?.result.ok) && name.trim().length > 1;
  const running = target !== null;

  // Start the run once the target circuit is set (the hook is keyed on it).
  const started = useRef<string | null>(null);
  useEffect(() => {
    if (target && started.current !== target) {
      started.current = target;
      void ingestion.start();
    }
  }, [target, ingestion]);

  // Pace the stage list so each step is visible, but never ahead of the real run.
  const [shown, setShown] = useState(0);
  const realIndex = ingestion.state.status === "succeeded" ? STAGES.length : Math.max(0, STAGES.findIndex((s) => s.key === ingestion.state.currentStage));
  useEffect(() => {
    if (!running || shown >= realIndex) return;
    const t = setTimeout(() => setShown((n) => n + 1), STAGE_MIN_MS);
    return () => clearTimeout(t);
  }, [running, shown, realIndex]);
  const finished = ingestion.state.status === "succeeded" && shown >= STAGES.length;

  const circuit = useMemo(() => circuits.data?.find((c) => c.id === target), [circuits.data, target]);

  function submit() {
    // Recognise the circuit from the uploaded lap (length within 2% of a circuit we know), or from its name.
    const lap = picked.track?.result.lengthM ?? 0;
    const q = name.trim().toLowerCase();
    const match =
      circuits.data?.find((c) => Math.abs(c.length_m - lap) / c.length_m < 0.02) ??
      circuits.data?.find((c) => [c.id, c.name, c.short_name].some((n) => n.toLowerCase().includes(q) || q.includes(n.toLowerCase())));
    if (!match) {
      setUnknown(true);
      return;
    }
    setUnknown(false);
    setShown(0);
    setTarget(match.id);
  }

  function open() {
    if (!target) return;
    setCircuit(target);
    router.push("/circuit");
  }

  return (
    <div className="relative min-h-full overflow-hidden bg-bg">
      <div
        className="pointer-events-none absolute inset-0 -z-0 opacity-90"
        aria-hidden="true"
        style={{
          background:
            "radial-gradient(900px 420px at 12% -10%, color-mix(in srgb, var(--color-accent) 22%, transparent), transparent 70%)," +
            "radial-gradient(700px 380px at 95% 15%, color-mix(in srgb, var(--color-risk-high) 16%, transparent), transparent 70%)",
        }}
      />
      <header className="relative z-10 flex items-center justify-between gap-4 border-b border-line/70 bg-panel/60 px-5 py-3 backdrop-blur">
        <Brand size="lg" />
        <div className="flex items-center gap-2.5">
          <ThemeToggle />
          <Button onClick={() => router.push("/circuit")}>Open the live map</Button>
        </div>
      </header>

      <main className="relative z-10 mx-auto grid max-w-[1180px] gap-10 px-5 py-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:py-14">
        <section className="grid content-start gap-6 lg:content-center">
          <h1 className="font-serif text-[clamp(38px,4.6vw,58px)] font-semibold leading-[1.02] tracking-[-0.015em]">
            Find where your track is dangerous, and pay less to insure it.
          </h1>
          <p className="max-w-[46ch] text-[15px] leading-relaxed text-muted">
            See which corners put marshals and spectators at risk, and give your insurer the proof to help bring your premium down.
          </p>
          <ol className="grid gap-3 text-[13.5px]">
            {[
              ["Upload", "Your track and incident log."],
              ["Analyse", "We find the risky corners."],
              ["Act", "Get the proof and a safety plan."],
            ].map(([t, d], i) => (
              <li key={t} className="grid grid-cols-[28px_1fr] gap-3">
                <span className="display grid size-7 place-items-center rounded-full bg-accent/15 text-[14px] font-semibold text-accent">{i + 1}</span>
                <span>
                  <b className="text-ink">{t}.</b> <span className="text-muted">{d}</span>
                </span>
              </li>
            ))}
          </ol>
        </section>

        <section className="grid content-start gap-4 rounded-2xl border border-line bg-panel/90 p-5 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.45)] backdrop-blur lg:p-6" aria-label="Upload your circuit">
          {!running ? (
            <>
              <header>
                <h2 className="font-serif text-[26px] font-semibold leading-none">Upload your circuit</h2>
              </header>

              <label className="grid gap-1.5 text-[12.5px]">
                <span className="font-medium">Circuit name</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Autodromo Nazionale Monza"
                  className="h-10 rounded-lg border border-line bg-bg px-3 text-[14px] outline-none focus:border-accent"
                />
              </label>

              <div className="grid gap-2">
                {UPLOADS.map((u) => (
                  <FileSlot key={u.key} spec={u} picked={picked[u.key]} onPick={(p) => setPicked((s) => ({ ...s, [u.key]: p }))} />
                ))}
              </div>

              {unknown && (
                <StateMessage tone="info" title="Files look good">
                  This prototype can run the full analysis for circuits already set up (
                  {circuits.data?.map((c) => c.short_name).join(", ")}). New circuits are the next step.
                </StateMessage>
              )}

              <Button variant="primary" onClick={submit} disabled={!ready} className="h-11 text-[15px]">
                Analyse my circuit
              </Button>
              {!ready && <p className="-mt-2 text-center text-[11.5px] text-faint">Add a circuit name and the three required files to continue.</p>}
            </>
          ) : (
            <Generating
              circuitName={circuit?.name ?? name}
              shown={shown}
              failed={ingestion.state.status === "failed" ? ingestion.state.error : null}
              incidents={ingestion.state.incidentCount}
              finished={finished}
              exposure={exposure.data}
              onOpen={open}
              onRetry={() => {
                started.current = null;
                setShown(0);
                setTarget(null);
                setTimeout(() => setTarget(target), 0);
              }}
            />
          )}
        </section>
      </main>
    </div>
  );
}

function FileSlot({ spec, picked, onPick }: { spec: UploadSpec; picked: Picked | undefined; onPick: (p: Picked) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

  async function read(file: File | undefined) {
    if (!file) return;
    onPick({ fileName: file.name, result: checkUpload(spec, await file.text()) });
  }

  const ok = picked?.result.ok;
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        void read(e.dataTransfer.files[0]);
      }}
      className={cn(
        "grid grid-cols-[1fr_auto] items-center gap-3 rounded-xl border px-3.5 py-3 transition-colors",
        drag ? "border-accent bg-accent/10" : ok ? "border-risk-low/50 bg-risk-low/6" : picked ? "border-risk-crit/50 bg-risk-crit/6" : "border-line bg-bg/60",
      )}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-[13.5px]">
          <b>{spec.title}</b>
          <span className={cn("text-[10.5px] uppercase tracking-wide", spec.required ? "text-accent" : "text-faint")}>
            {spec.required ? "Required" : "Optional"}
          </span>
        </div>
        {picked ? (
          <p className={cn("mt-0.5 truncate text-[12px]", ok ? "text-risk-low" : "text-risk-crit")}>
            {ok ? "✓ " : "✕ "}
            {picked.fileName}: {picked.result.summary}
          </p>
        ) : (
          <p className="mt-0.5 truncate text-[11.5px] leading-snug text-muted">
            {spec.hint}{" "}
            <a href={spec.template} download className="text-accent underline-offset-2 hover:underline">
              Template
            </a>
          </p>
        )}
      </div>
      <input ref={input} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => void read(e.target.files?.[0])} />
      <Button size="sm" onClick={() => input.current?.click()}>
        {picked ? "Replace" : "Choose file"}
      </Button>
    </div>
  );
}

interface GeneratingProps {
  circuitName: string;
  shown: number;
  failed: string | null;
  incidents: number;
  finished: boolean;
  exposure: ReturnType<typeof useExposure>["data"];
  onOpen: () => void;
  onRetry: () => void;
}

function Generating({ circuitName, shown, failed, incidents, finished, exposure, onOpen, onRetry }: GeneratingProps) {
  return (
    <div className="grid gap-4" aria-live="polite">
      <header>
        <p className="eyebrow">{finished ? "Analysis ready" : "Analysing"}</p>
        <h2 className="display mt-1 text-[26px] font-semibold leading-tight">{circuitName}</h2>
      </header>

      <ol className="grid gap-1.5">
        {STAGES.map((s, i) => {
          const state = i < shown ? "done" : i === shown && !finished && !failed ? "active" : "pending";
          return (
            <li key={s.key} className="flex items-center gap-3 rounded-lg border border-line bg-bg/60 px-3 py-2 text-[13px]">
              <span
                className={cn(
                  "grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold",
                  state === "done" ? "bg-risk-low text-bg" : state === "active" ? "animate-pulse bg-accent/30 text-accent" : "bg-line text-faint",
                )}
              >
                {state === "done" ? "✓" : i + 1}
              </span>
              <span className={state === "pending" ? "text-faint" : "text-ink"}>{s.label}</span>
              {s.key === "geolocate" && incidents > 0 && <span className="num ml-auto text-[11.5px] text-muted">{incidents} placed</span>}
            </li>
          );
        })}
      </ol>

      {failed && (
        <StateMessage tone="error" title="The analysis stopped" action={<Button size="sm" onClick={onRetry}>Try again</Button>}>
          {failed}
        </StateMessage>
      )}

      {finished && exposure && (
        <div className="grid gap-3 rounded-xl border border-risk-low/40 bg-risk-low/6 p-4">
          <p className="text-[13px] text-muted">
            {exposure.serious_total} serious incidents across {exposure.weekends} race weekends, placed on {exposure.zones.length} track zones.
          </p>
          <div className="grid grid-cols-3 gap-3 text-center">
            <Teaser value={`~${Math.round(exposure.marshals_out_per_weekend)}×`} label="marshal call-outs per weekend" />
            <Teaser value={formatFraction(exposure.near_crowd_share)} label="of incidents next to a grandstand" />
            <Teaser value={`${exposure.backtest.lift.toFixed(1)}×`} label="better than chance at predicting next year" />
          </div>
          <Button variant="primary" onClick={onOpen} className="h-11 text-[15px]">
            Open the results
          </Button>
        </div>
      )}
    </div>
  );
}

function Teaser({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel px-2 py-2.5">
      <div className="display text-[26px] font-semibold leading-none">{value}</div>
      <div className="mt-1 text-[11px] leading-snug text-muted">{label}</div>
    </div>
  );
}
