"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { describeError } from "@/services/http/errors";
import type { StreamSubscription } from "@/services/http/eventStream";
import { ingestionService } from "@/services/ingestion.service";
import { queryKeys } from "@/services/queryKeys";
import { mapEffects } from "@/store/crashBus";
import type { Incident, IngestStage, IngestStreamEvent } from "@/types/track";

const FEED_LIMIT = 40;

export type IngestionStatus = "idle" | "starting" | "streaming" | "succeeded" | "failed";

export interface StageProgress {
  done: number;
  total: number;
  message: string | null;
}

export interface IngestionState {
  status: IngestionStatus;
  jobId: string | null;
  currentStage: IngestStage | null;
  stages: Partial<Record<IngestStage, StageProgress>>;
  /** Most recent incidents first, capped for rendering. */
  feed: Incident[];
  incidentCount: number;
  result: { incidentsWritten: number; durationS: number } | null;
  error: string | null;
}

type Action =
  | { type: "start" }
  | { type: "job"; jobId: string }
  | { type: "event"; event: Exclude<IngestStreamEvent, { type: "incident" }> }
  | { type: "incidents"; incidents: Incident[] }
  | { type: "fail"; message: string }
  | { type: "reset" };

const initialState: IngestionState = {
  status: "idle",
  jobId: null,
  currentStage: null,
  stages: {},
  feed: [],
  incidentCount: 0,
  result: null,
  error: null,
};

function reducer(state: IngestionState, action: Action): IngestionState {
  switch (action.type) {
    case "start":
      return { ...initialState, status: "starting" };
    case "job":
      return { ...state, status: "streaming", jobId: action.jobId };
    case "fail":
      return { ...state, status: "failed", error: action.message };
    case "reset":
      return initialState;
    case "incidents":
      return {
        ...state,
        feed: [...[...action.incidents].reverse(), ...state.feed].slice(0, FEED_LIMIT),
        incidentCount: state.incidentCount + action.incidents.length,
      };
    case "event": {
      const e = action.event;
      switch (e.type) {
        case "progress":
          return {
            ...state,
            currentStage: e.stage,
            stages: { ...state.stages, [e.stage]: { done: e.done, total: e.total, message: e.message } },
          };
        case "done":
          return {
            ...state,
            status: "succeeded",
            currentStage: null,
            result: { incidentsWritten: e.incidents_written, durationS: e.duration_s },
          };
        case "stream_error":
          return { ...state, status: "failed", error: e.message };
      }
    }
  }
}

/**
 * Step 1 streaming hook: starts an ingestion job for a circuit and follows its SSE stream.
 * Placed incidents go to the map immediately and into the feed once per animation frame (a run can
 * stream hundreds in a burst). Cached track, incident and risk data refresh when it finishes.
 */
export function useIngestionStream(circuitId: string | null) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const queryClient = useQueryClient();
  const subscription = useRef<StreamSubscription | null>(null);
  const abort = useRef<AbortController | null>(null);
  const pending = useRef<Incident[]>([]);
  const frame = useRef<number | null>(null);

  const flush = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    if (pending.current.length === 0) return;
    dispatch({ type: "incidents", incidents: pending.current });
    pending.current = [];
  }, []);

  const stopAll = useCallback(() => {
    abort.current?.abort();
    subscription.current?.close();
    abort.current = null;
    subscription.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    pending.current = [];
  }, []);

  // A new circuit starts from a clean slate; leaving the page closes the stream.
  useEffect(() => {
    dispatch({ type: "reset" });
    return stopAll;
  }, [circuitId, stopAll]);

  const start = useCallback(async () => {
    if (!circuitId) return;
    stopAll();
    dispatch({ type: "start" });
    const controller = new AbortController();
    abort.current = controller;
    try {
      const job = await ingestionService.startIngestion({ circuit: circuitId }, controller.signal);
      dispatch({ type: "job", jobId: job.job_id });
      subscription.current = ingestionService.streamIngestion(job.job_id, {
        onEvent: (event) => {
          if (event.type === "incident") {
            mapEffects.emit({ kind: "incident", incident: event.incident });
            pending.current.push(event.incident);
            frame.current ??= requestAnimationFrame(flush);
            return;
          }
          flush();
          dispatch({ type: "event", event });
          if (event.type === "done") {
            void queryClient.invalidateQueries({ queryKey: queryKeys.circuits() });
            void queryClient.invalidateQueries({ queryKey: queryKeys.track(circuitId) });
            void queryClient.invalidateQueries({ queryKey: queryKeys.incidentsForCircuit(circuitId) });
            void queryClient.invalidateQueries({ queryKey: queryKeys.riskMapsForCircuit(circuitId) });
          }
        },
        onError: (err) => {
          flush();
          dispatch({ type: "fail", message: describeError(err) });
        },
      });
    } catch (err) {
      if (!controller.signal.aborted) dispatch({ type: "fail", message: describeError(err) });
    }
  }, [circuitId, queryClient, stopAll, flush]);

  const cancel = useCallback(() => {
    stopAll();
    dispatch({ type: "reset" });
  }, [stopAll]);

  const isActive = state.status === "starting" || state.status === "streaming";
  return { state, start, cancel, isActive };
}
