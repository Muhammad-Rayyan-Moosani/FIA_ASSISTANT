"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ReplayIntro } from "@/components/intro/IntroSplash";
import { Brand } from "@/components/layout/Brand";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { Button } from "@/components/ui/Button";
import { StateMessage } from "@/components/ui/StateMessage";
import { useCircuits } from "@/hooks/ingestion/useCircuits";
import { useIngestionStream } from "@/hooks/ingestion/useIngestionStream";
import { useExposure } from "@/hooks/insurance/useExposure";
import { cn } from "@/lib/cn";
import { formatFraction } from "@/lib/format";
import { UPLOADS, checkUpload, sortUploads, type CheckResult, type UploadKey, type UploadSpec } from "@/lib/uploadFiles";
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
  const [unmatched, setUnmatched] = useState<string[]>([]);
  const allInput = useRef<HTMLInputElement>(null);
  const [dragAll, setDragAll] = useState(false);
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

  // Several files at once: each goes to the slot its columns (or its name) fit.
  async function pickAll(list: FileList | null) {
    if (!list?.length) return;
    const files = await Promise.all([...list].map(async (f) => ({ name: f.name, text: await f.text() })));
    const { matched, unmatched } = sortUploads(files);
    setPicked((s) => ({ ...s, ...matched }));
    setUnmatched(unmatched);
  }

  function open() {
    if (!target) return;
    setCircuit(target);
    router.push("/circuit");
  }

  return (
    <div className="carbon relative min-h-full overflow-hidden bg-bg">
      <div
        className="pointer-events-none absolute inset-0 -z-0"
        aria-hidden="true"
        style={{
          background:
            "radial-gradient(900px 460px at 8% -12%, color-mix(in srgb, var(--color-accent) 26%, transparent), transparent 70%)," +
            "radial-gradient(760px 420px at 100% 105%, color-mix(in srgb, var(--color-accent-2) 14%, transparent), transparent 70%)",
        }}
      />
      <SpeedLines />
      <header className="speed-stripe relative z-10 flex items-center justify-between gap-4 border-b border-line/70 bg-panel/70 px-5 py-3 backdrop-blur">
        <Brand size="lg" />
        <div className="flex items-center gap-2.5">
          <ReplayIntro />
          <Button variant="primary" onClick={() => router.push("/circuit")} title="Open the live map: race control and insurance">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">
              <path d="M3 3h8v8H3zM13 3h8v5h-8zM13 10h8v11h-8zM3 13h8v8H3z" />
            </svg>
            Dashboard
          </Button>
          <ThemeToggle />
        </div>
      </header>

      <main className="relative z-10 mx-auto grid max-w-[1180px] gap-10 px-5 py-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:py-14">
        <section className="grid content-start gap-6 lg:content-center">
          <div className="flex items-center gap-3">
            <span className="checker h-4 w-10 opacity-80" aria-hidden="true" />
            <span className="eyebrow text-accent">Race control · Insurance · One live map</span>
          </div>
          <h1 className="race-title text-[clamp(44px,5.6vw,76px)]">
            Find where your track is <span className="text-accent">dangerous</span>, and pay less to insure it.
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
                <span className="race-title grid size-7 -skew-x-12 place-items-center rounded-[4px] bg-accent text-[15px] text-accent-ink">{i + 1}</span>
                <span>
                  <b className="text-ink">{t}.</b> <span className="text-muted">{d}</span>
                </span>
              </li>
            ))}
          </ol>
        </section>

        <section className="speed-stripe grid content-start gap-4 overflow-hidden rounded-xl border border-line bg-panel/92 p-5 shadow-[0_24px_70px_-24px_rgba(0,0,0,0.6)] backdrop-blur lg:p-6" aria-label="Upload your circuit">
          {!running ? (
            <>
              <header>
                <h2 className="race-title text-[30px]">Upload your circuit</h2>
              </header>

              <label className="grid gap-1.5 text-[12.5px]">
                <span className="font-medium">Circuit name</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Autodromo Nazionale Monza"
                  className="h-10 rounded-md border border-line bg-bg px-3 text-[14px] outline-none transition-colors focus:border-accent focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent)_22%,transparent)]"
                />
              </label>

              <div className="grid gap-2">
                {UPLOADS.map((u) => (
                  <FileSlot key={u.key} spec={u} picked={picked[u.key]} onPick={(p) => setPicked((s) => ({ ...s, [u.key]: p }))} />
                ))}
              </div>

              <div
                role="button"
                tabIndex={0}
                onClick={() => allInput.current?.click()}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && allInput.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragAll(true);
                }}
                onDragLeave={() => setDragAll(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragAll(false);
                  void pickAll(e.dataTransfer.files);
                }}
                className={cn(
                  "grid cursor-pointer place-items-center gap-2 rounded-xl border-2 border-dashed px-4 py-5 text-center transition-colors",
                  dragAll ? "border-accent bg-accent/10" : "border-line bg-bg/40 hover:border-accent/60 hover:bg-accent/5",
                )}
              >
                <svg viewBox="0 0 24 24" className="size-7 text-accent" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
                </svg>
                <span className="text-[14px] font-medium">Drop all your files here</span>
                <span className="text-[12px] text-muted">or click to choose them. Each file goes to the right slot above.</span>
                <input
                  ref={allInput}
                  onClick={(e) => e.stopPropagation()}
                  type="file"
                  multiple
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={(e) => {
                    void pickAll(e.target.files);
                    e.target.value = "";
                  }}
                />
              </div>
              {unmatched.length > 0 && (
                <p className="-mt-2 text-[12px] text-risk-crit">Not sure what {unmatched.join(", ")} {unmatched.length > 1 ? "are" : "is"}: add {unmatched.length > 1 ? "them" : "it"} in the right slot above.</p>
              )}

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
        "grid grid-cols-[1fr_auto] items-center gap-3 rounded-md border border-l-[3px] px-3.5 py-3 transition-colors",
        drag
          ? "border-accent border-l-accent bg-accent/10"
          : ok
            ? "border-risk-low/40 border-l-risk-low bg-risk-low/6"
            : picked
              ? "border-risk-crit/40 border-l-risk-crit bg-risk-crit/6"
              : "border-line border-l-line bg-bg/60 hover:border-l-accent",
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
        <h2 className="race-title mt-1 text-[30px]">{circuitName}</h2>
      </header>

      <ol className="grid gap-1.5">
        {STAGES.map((s, i) => {
          const state = i < shown ? "done" : i === shown && !finished && !failed ? "active" : "pending";
          return (
            <li key={s.key} className="flex items-center gap-3 rounded-md border border-line bg-bg/60 px-3 py-2 text-[13px]">
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
    <div className="rounded-md border border-line bg-panel px-2 py-2.5">
      <div className="race-title text-[28px] text-accent">{value}</div>
      <div className="mt-1 text-[11px] leading-snug text-muted">{label}</div>
    </div>
  );
}

/** Faint red streaks sweeping across the page, like light trails down a straight. */
function SpeedLines() {
  return (
    <div className="pointer-events-none absolute inset-0 -z-0 overflow-hidden opacity-60" aria-hidden="true">
      {[18, 34, 57, 71, 86].map((top, i) => (
        <span
          key={top}
          className="absolute left-0 h-px w-[38%] animate-streak bg-gradient-to-r from-transparent via-accent/60 to-transparent"
          style={{ top: `${top}%`, animationDelay: `${i * 0.55}s`, animationDuration: `${2.4 + (i % 3) * 0.7}s` }}
        />
      ))}
    </div>
  );
}
