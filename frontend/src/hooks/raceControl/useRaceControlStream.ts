"use client";

import { useEffect, useReducer, useState } from "react";
import { initialRaceControlState, raceControlReducer } from "@/lib/raceControlState";
import { raceControlService } from "@/services/raceControl.service";
import { mapEffects } from "@/store/crashBus";
import { replayBus } from "@/store/replayBus";
import type { RaceControlEvent } from "@/types/raceControl";

export type StreamConnection = "connecting" | "live" | "offline";

const EVENTS: RaceControlEvent["type"][] = [
  "snapshot", "reset", "cars", "masts", "incident", "rules", "severity", "driver_warning", "deployment", "log", "grip",
  "replay_start", "replay_end", "stream_error",
];

/**
 * Follows the race-control SSE stream of one circuit: masts, incidents, cockpit warnings, severity, log.
 * Car frames go to replayBus (read by the 3D scene each animation frame), not into React state.
 * EventSource reconnects on its own; a snapshot on every (re)connect restores the full state.
 */
export function useRaceControlStream(circuitId: string | null) {
  const [state, dispatch] = useReducer(raceControlReducer, initialRaceControlState);
  const [connection, setConnection] = useState<StreamConnection>("connecting");

  useEffect(() => {
    if (!circuitId) return;
    dispatch({ type: "circuit", circuit: circuitId });
    replayBus.push(null);
    const source = new EventSource(raceControlService.streamUrl(circuitId));
    source.onopen = () => setConnection("live");
    source.onerror = () => setConnection(source.readyState === EventSource.CLOSED ? "offline" : "connecting");
    const onEvent = (e: MessageEvent<string>) => {
      let ev: RaceControlEvent;
      try {
        ev = JSON.parse(e.data) as RaceControlEvent;
      } catch {
        return;
      }
      if (ev.type === "cars") replayBus.push(ev.data);
      if (ev.type === "reset" || ev.type === "replay_start") replayBus.push(null);
      if (ev.type === "incident") {
        const hard = ev.data.collision?.level === "crash";
        mapEffects.emit({ kind: "impact", x: ev.data.x, y: ev.data.y, zoneId: ev.data.zone_id, severe: hard });
      }
      dispatch(ev);
    };
    for (const name of EVENTS) source.addEventListener(name, onEvent as EventListener);
    return () => {
      source.close();
      replayBus.push(null);
    };
  }, [circuitId]);

  return { state, connection };
}
