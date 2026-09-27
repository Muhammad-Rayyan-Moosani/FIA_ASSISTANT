import { env } from "@/config/env";
import { apiClient } from "@/services/http/apiClient";
import type { DemoEventPayload, DemoStartPayload, DeployAction, IncidentList, IncidentSummary, MarshalSector, RaceControlSnapshot, RuleCitation } from "@/types/raceControl";

/** Race control lives in the same backend as insurance (merged from the old FIA service). */
export const RACE_CONTROL_ENDPOINTS = {
  marshalSectors: (c: string) => `/api/fia/${encodeURIComponent(c)}/marshal-sectors`,
  incidents: (c: string) => `/api/fia/${encodeURIComponent(c)}/incidents`,
  state: (c: string) => `/api/fia/${encodeURIComponent(c)}/state`,
  stream: (c: string) => `/api/fia/${encodeURIComponent(c)}/stream`,
  replay: (c: string) => `/api/fia/${encodeURIComponent(c)}/replay`,
  evaluate: (c: string) => `/api/fia/${encodeURIComponent(c)}/evaluate`,
  deploy: (c: string) => `/api/fia/${encodeURIComponent(c)}/deploy`,
  reset: (c: string) => `/api/fia/${encodeURIComponent(c)}/reset`,
  demoStart: (c: string) => `/api/fia/${encodeURIComponent(c)}/demo/start`,
  demoEvent: (c: string) => `/api/fia/${encodeURIComponent(c)}/demo/event`,
  rules: "/api/fia/rules/query",
};

export const raceControlService = {
  streamUrl: (circuit: string) => `${env.apiBaseUrl}${RACE_CONTROL_ENDPOINTS.stream(circuit)}`,
  marshalSectors: (circuit: string, signal?: AbortSignal) =>
    apiClient.get<{ circuit: string; sectors: MarshalSector[]; source: string }>(RACE_CONTROL_ENDPOINTS.marshalSectors(circuit), { signal }),
  incidents: (circuit: string, signal?: AbortSignal) => apiClient.get<IncidentList>(RACE_CONTROL_ENDPOINTS.incidents(circuit), { signal }),
  replay: (circuit: string, incidentId: string, speed: number) =>
    apiClient.post<IncidentSummary>(RACE_CONTROL_ENDPOINTS.replay(circuit), { incident_id: incidentId, speed }),
  evaluate: (circuit: string, target: { marshal_sector?: number; zone_id?: string }, speed: number) =>
    apiClient.post<IncidentSummary>(RACE_CONTROL_ENDPOINTS.evaluate(circuit), { ...target, speed }),
  deploy: (circuit: string, action: DeployAction) => apiClient.post<RaceControlSnapshot>(RACE_CONTROL_ENDPOINTS.deploy(circuit), { action }),
  reset: (circuit: string) => apiClient.post<RaceControlSnapshot>(RACE_CONTROL_ENDPOINTS.reset(circuit), {}),
  demoStart: (circuit: string, body: DemoStartPayload) => apiClient.post<IncidentSummary>(RACE_CONTROL_ENDPOINTS.demoStart(circuit), body),
  demoEvent: (circuit: string, body: DemoEventPayload) => apiClient.post<{ ok: boolean }>(RACE_CONTROL_ENDPOINTS.demoEvent(circuit), body),
  queryRules: (query: string) =>
    apiClient.post<{ query: string; citations: RuleCitation[]; documents: string[] }>(RACE_CONTROL_ENDPOINTS.rules, { query, top_k: 3 }, { timeoutMs: 60_000 }),
};
