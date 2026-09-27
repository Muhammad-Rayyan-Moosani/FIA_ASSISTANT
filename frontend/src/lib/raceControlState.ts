import type { IncidentSummary, RaceControlEvent, RaceControlSnapshot } from "@/types/raceControl";

/** Everything the race-control UI shows, folded from the SSE stream. Car frames bypass this (see replayBus). */
export interface RaceControlState extends RaceControlSnapshot {
  streamError: string | null;
  /** Bumps on each new incident so the map can fly to it once. */
  incidentSeq: number;
  /** Bumps on each replay start (restarts the cinematic camera). */
  replaySeq: number;
  /** The incident being replayed (known before the impact, for the approach shot). */
  replayIncident: IncidentSummary | null;
}

export const initialRaceControlState: RaceControlState = {
  circuit: "",
  masts: [],
  deployment: "green",
  incident: null,
  severity: null,
  warning: null,
  replay: null,
  log: [],
  hazards: [],
  streamError: null,
  incidentSeq: 0,
  replaySeq: 0,
  replayIncident: null,
};

const LOG_LIMIT = 60;

export function raceControlReducer(state: RaceControlState, event: RaceControlEvent | { type: "circuit"; circuit: string }): RaceControlState {
  switch (event.type) {
    case "circuit":
      return event.circuit === state.circuit ? state : { ...initialRaceControlState, circuit: event.circuit };
    case "snapshot":
    case "reset":
      return { ...state, ...event.data, streamError: null };
    case "masts":
      return { ...state, masts: event.data.masts };
    case "incident":
      return { ...state, incident: event.data, incidentSeq: state.incidentSeq + 1 };
    case "incident_update":
      return state.incident?.incident_id === event.data.incident_id ? { ...state, incident: event.data } : state;
    case "rules":
      return state.incident?.incident_id === event.data.incident_id ? { ...state, incident: { ...state.incident, rules: event.data.rules } } : state;
    case "advisory":
      return state.incident?.incident_id === event.data.incident_id ? { ...state, incident: { ...state.incident, advisory: event.data.advisory } } : state;
    case "escalation":
      return state.incident?.collision?.driver === event.data.car ? { ...state, incident: { ...state.incident, live: event.data } } : state;
    case "severity":
      return { ...state, severity: event.data };
    case "driver_warning":
      return { ...state, warning: event.data };
    case "deployment":
      return {
        ...state,
        deployment: event.data.deployment,
        ...(event.data.deployment === "green" && { incident: null, hazards: [] }),
      };
    case "log":
      return { ...state, log: [event.data, ...state.log].slice(0, LOG_LIMIT) };
    case "grip": {
      const rest = state.hazards.filter((h) => h.segment !== event.data.segment);
      if (event.data.level === "NONE") return { ...state, hazards: rest };
      const h = { segment: event.data.segment, level: event.data.level, sector: event.data.sector, zone_name: "", cars: event.data.cars, min_residual: event.data.min_residual, lap_frac: 0 };
      return { ...state, hazards: [...rest, h] };
    }
    case "replay_start": {
      const { incident, ...replay } = event.data;
      return { ...state, replay: { ...replay, running: true }, replayIncident: incident, replaySeq: state.replaySeq + 1, streamError: null };
    }
    case "replay_end":
      return { ...state, replay: event.data };
    case "stream_error":
      return { ...state, streamError: event.data.message };
    case "cars":
      return state.replay ? { ...state, replay: { ...state.replay, t: event.data.t } } : state;
    default:
      return state;
  }
}
