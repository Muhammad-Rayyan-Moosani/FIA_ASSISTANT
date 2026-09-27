"use client";

import { useEffect, useRef, useState } from "react";
import { describeError } from "@/services/http/errors";
import { raceControlService } from "@/services/raceControl.service";
import { DEMO_CIRCUIT, demoBus, useDemoStore } from "@/store/demoStore";
import type { DriverWarning, ReplayState } from "@/types/raceControl";

/** If race control's warning hasn't reached car B this long after the slip (backend offline), warn it locally. */
const FALLBACK_WARN_MS = 2500;

/**
 * Race-control side of the wet-hairpin demo: posts the 3D layer's physics events to the backend in order, and hands
 * car B the warning the moment race control's cockpit message for it arrives on the SSE stream.
 */
export function useDemoRaceControl(circuitId: string | null, warning: DriverWarning | null, replay: ReplayState | null) {
  const phase = useDemoStore((s) => s.phase);
  const [error, setError] = useState<string | null>(null);
  const chain = useRef<Promise<unknown>>(Promise.resolve());

  // physics events -> race control, strictly in order (the start must land before the slip)
  useEffect(() => {
    if (!circuitId) return;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    const off = demoBus.subscribe((m) => {
      if (m.kind === "start") setError(null);
      if (m.kind === "event" && m.body.kind === "slip") {
        fallback = setTimeout(() => useDemoStore.getState().warn("fallback"), FALLBACK_WARN_MS);
      }
      chain.current = chain.current
        .then((): Promise<unknown> => (m.kind === "start" ? raceControlService.demoStart(circuitId, m.body) : raceControlService.demoEvent(circuitId, m.body)))
        .catch((e: unknown) => setError(`Race control didn't get the demo events: ${describeError(e)}`));
    });
    return () => {
      off();
      clearTimeout(fallback);
    };
  }, [circuitId]);

  // the cockpit warning for car B is what makes it react (only one sent during this run, not a previous run's)
  const runId = useDemoStore((s) => s.runId);
  const [stale, setStale] = useState<{ runId: number; warning: DriverWarning | null }>({ runId, warning });
  if (stale.runId !== runId) setStale({ runId, warning });
  const fresh = warning !== null && warning !== stale.warning && stale.runId === runId && warning.driver === "B";
  useEffect(() => {
    if (fresh && phase !== "idle") useDemoStore.getState().warn("race_control");
  }, [fresh, phase]);

  // a real replay, a reset or another circuit ends the demo
  const other = replay !== null && !replay.demo;
  useEffect(() => {
    if (other) useDemoStore.getState().stop();
  }, [other]);
  useEffect(() => {
    if (circuitId && circuitId !== DEMO_CIRCUIT && useDemoStore.getState().phase !== "starting") useDemoStore.getState().stop();
  }, [circuitId]);

  return { phase, error };
}
