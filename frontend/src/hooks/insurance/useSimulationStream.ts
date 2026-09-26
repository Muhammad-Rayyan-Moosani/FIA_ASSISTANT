"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import { describeError } from "@/services/http/errors";
import type { StreamSubscription } from "@/services/http/eventStream";
import { insuranceService } from "@/services/insurance.service";
import { mapEffects } from "@/store/crashBus";
import type { Series } from "@/types/api";
import type { SimulationStreamEvent, UpgradeSet } from "@/types/risk";

export const SAMPLE_SEASONS = 40;

export type SimulationStatus = "idle" | "running" | "done" | "failed";

export interface SimulationState {
  status: SimulationStatus;
  /** Sampled seasons shown so far (1-based count). */
  seasonsShown: number;
  currentSeason: number | null;
  seasonLossEur: number;
  seasonCrashes: number;
  seasonsDone: number;
  seasonsTotal: number;
  runningEalEur: number | null;
  /** Running EAL after each progress event, for the convergence chart. */
  convergence: number[];
  crashes: number;
  /** Crashes among the costliest 5% of all simulated crashes. */
  severe: number;
  final: { ealEur: number; var99Eur: number; nSeasons: number } | null;
  error: string | null;
}

interface CrashBatch {
  crashes: number;
  severe: number;
  lossEur: number;
}

type Action =
  | { type: "start" }
  | { type: "event"; event: Exclude<SimulationStreamEvent, { type: "crash" }> }
  | { type: "crashes"; batch: CrashBatch }
  | { type: "fail"; message: string }
  | { type: "reset" };

const emptyBatch = (): CrashBatch => ({ crashes: 0, severe: 0, lossEur: 0 });

const initialState: SimulationState = {
  status: "idle",
  seasonsShown: 0,
  currentSeason: null,
  seasonLossEur: 0,
  seasonCrashes: 0,
  seasonsDone: 0,
  seasonsTotal: 0,
  runningEalEur: null,
  convergence: [],
  crashes: 0,
  severe: 0,
  final: null,
  error: null,
};

function reducer(state: SimulationState, action: Action): SimulationState {
  switch (action.type) {
    case "start":
      return { ...initialState, status: "running" };
    case "fail":
      return { ...state, status: "failed", error: action.message };
    case "reset":
      return initialState;
    case "crashes":
      return {
        ...state,
        crashes: state.crashes + action.batch.crashes,
        severe: state.severe + action.batch.severe,
        seasonLossEur: state.seasonLossEur + action.batch.lossEur,
        seasonCrashes: state.seasonCrashes + action.batch.crashes,
      };
    case "event": {
      const e = action.event;
      switch (e.type) {
        case "season_start":
          return { ...state, currentSeason: e.season, seasonsShown: state.seasonsShown + 1, seasonLossEur: 0, seasonCrashes: 0 };
        case "progress":
          return {
            ...state,
            seasonsDone: e.seasons_done,
            seasonsTotal: e.seasons_total,
            runningEalEur: e.running_eal_eur,
            convergence: [...state.convergence, e.running_eal_eur],
          };
        case "done":
          return { ...state, status: "done", final: { ealEur: e.eal_eur, var99Eur: e.var99_eur, nSeasons: e.n_seasons } };
        case "stream_error":
          return { ...state, status: "failed", error: e.message };
      }
    }
  }
}

/**
 * Step 3 streaming hook: follows the season simulation and drops each crash onto the map.
 * Crashes go to the map immediately but are counted in a buffer that is flushed into React state once
 * per season (a busy F3 season streams ~60 crashes), so the panels re-render per season, not per crash.
 * Changing circuit, series or scenario stops the run.
 */
export function useSimulationStream(circuitId: string | null, series: Series, upgrades: UpgradeSet) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const subscription = useRef<StreamSubscription | null>(null);
  const pending = useRef<CrashBatch>(emptyBatch());

  const flush = useCallback(() => {
    if (pending.current.crashes === 0) return;
    dispatch({ type: "crashes", batch: pending.current });
    pending.current = emptyBatch();
  }, []);

  const stop = useCallback(() => {
    subscription.current?.close();
    subscription.current = null;
  }, []);

  useEffect(() => {
    dispatch({ type: "reset" });
    return stop;
  }, [circuitId, series, upgrades, stop]);

  const start = useCallback(() => {
    if (!circuitId) return;
    stop();
    pending.current = emptyBatch();
    dispatch({ type: "start" });
    subscription.current = insuranceService.streamSimulation(
      { circuit: circuitId, series, seasons: SAMPLE_SEASONS, upgrades },
      {
        onEvent: (event) => {
          if (event.type === "crash") {
            mapEffects.emit({ kind: "crash", crash: event });
            pending.current.crashes += 1;
            pending.current.severe += event.severe ? 1 : 0;
            pending.current.lossEur += event.loss_eur;
            return;
          }
          flush();
          dispatch({ type: "event", event });
        },
        onError: (err) => {
          flush();
          dispatch({ type: "fail", message: describeError(err) });
        },
      },
    );
  }, [circuitId, series, upgrades, stop, flush]);

  const cancel = useCallback(() => {
    stop();
    dispatch({ type: "reset" });
  }, [stop]);

  return { state, start, cancel, isRunning: state.status === "running" };
}
