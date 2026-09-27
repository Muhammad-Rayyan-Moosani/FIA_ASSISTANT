import { create } from "zustand";
import type { CarTelemetry } from "@/lib/demoPhysics";
import type { DemoEventPayload, DemoStartPayload } from "@/types/raceControl";

/** The circuit whose slowest corner (the Hairpin) the demo physics is tuned and tested on. */
export const DEMO_CIRCUIT = "montreal";
export const DEMO_LABEL = "Demo · simulated physics";

export type DemoPhase = "idle" | "starting" | "running" | "passed" | "ended";

interface DemoState {
  phase: DemoPhase;
  /** Bumps on every Demo press; the 3D layer starts one simulation per run. */
  runId: number;
  /** Race control's warning has reached car B (from the SSE stream, or the offline fallback). */
  warned: boolean;
  warnedBy: "race_control" | "fallback" | null;
  cars: { A: CarTelemetry | null; B: CarTelemetry | null };
  t: number;
  start: () => void;
  stop: () => void;
  warn: (by: "race_control" | "fallback") => void;
  setPhase: (phase: DemoPhase) => void;
  setTelemetry: (t: number, A: CarTelemetry, B: CarTelemetry) => void;
}

export const useDemoStore = create<DemoState>()((set) => ({
  phase: "idle",
  runId: 0,
  warned: false,
  warnedBy: null,
  cars: { A: null, B: null },
  t: 0,
  start: () => set((s) => ({ phase: "starting", runId: s.runId + 1, warned: false, warnedBy: null, cars: { A: null, B: null }, t: 0 })),
  stop: () => set((s) => (s.phase === "idle" ? s : { phase: "idle", warned: false, warnedBy: null, cars: { A: null, B: null } })),
  warn: (by) => set((s) => (s.warned ? s : { warned: true, warnedBy: by })),
  setPhase: (phase) => set({ phase }),
  setTelemetry: (t, A, B) => set({ t, cars: { A, B } }),
}));

/**
 * Physics events from the 3D demo layer to race control (posted by the workspace, in order).
 * Fire-and-forget like mapEffects: the scene never waits on the network.
 */
export type DemoMessage = { kind: "start"; body: DemoStartPayload } | { kind: "event"; body: DemoEventPayload };
type Listener = (m: DemoMessage) => void;
const listeners = new Set<Listener>();

export const demoBus = {
  emit(m: DemoMessage): void {
    for (const l of listeners) l(m);
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
