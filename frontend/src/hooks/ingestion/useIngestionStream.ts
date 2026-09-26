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
  | { type: "event"; event: IngestStreamEvent }
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
    case "event": {
      const e = action.event;
      switch (e.type) {
        case "progress":
          return {
            ...state,
            currentStage: e.stage,
            stages: { ...state.stages, [e.stage]: { done: e.done, total: e.total, message: e.message } },
          };
        case "incident":
          return {
            ...state,
            feed: [e.incident, ...state.feed].slice(0, FEED_LIMIT),
            incidentCount: state.incidentCount + 1,
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
 * Placed incidents are forwarded to the map; cached track, incident and risk data refresh when it finishes.
 */
export function useIngestionStream(circuitId: string | null) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const queryClient = useQueryClient();
  const subscription = useRef<StreamSubscription | null>(null);
  const abort = useRef<AbortController | null>(null);

  const stopAll = useCallback(() => {
    abort.current?.abort();
    subscription.current?.close();
    abort.current = null;
    subscription.current = null;
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
          dispatch({ type: "event", event });
          if (event.type === "incident") mapEffects.emit({ kind: "incident", incident: event.incident });
          if (event.type === "done") {
            void queryClient.invalidateQueries({ queryKey: queryKeys.circuits() });
            void queryClient.invalidateQueries({ queryKey: queryKeys.track(circuitId) });
            void queryClient.invalidateQueries({ queryKey: queryKeys.incidentsForCircuit(circuitId) });
            void queryClient.invalidateQueries({ queryKey: queryKeys.riskMapsForCircuit(circuitId) });
          }
        },
        onError: (err) => dispatch({ type: "fail", message: describeError(err) }),
      });
    } catch (err) {
      if (!controller.signal.aborted) dispatch({ type: "fail", message: describeError(err) });
    }
  }, [circuitId, queryClient, stopAll]);

  const cancel = useCallback(() => {
    stopAll();
    dispatch({ type: "reset" });
  }, [stopAll]);

  const isActive = state.status === "starting" || state.status === "streaming";
  return { state, start, cancel, isActive };
}
