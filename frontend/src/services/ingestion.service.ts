/**
 * STEP 1 · DATA INGESTION — frontend integration (backend owner: R1 · Data).
 *
 * Everything the UI needs from the ingestion pipeline: circuits and their data coverage,
 * track geometry with safety inventory, processed incidents, and a live stream of an
 * ingestion job as it fetches OpenF1 race control, extracts incidents and places them on the map.
 *
 * Contract types: src/types/track.ts · Spec: ARCHITECTURE.md §4 and §7.
 */
import type {
  CircuitSummary,
  Incident,
  IncidentQuery,
  IngestJob,
  IngestRequest,
  IngestStreamEvent,
  TrackGeometry,
} from "@/types/track";
import { apiClient } from "./http/apiClient";
import { openEventStream, type StreamHandlers, type StreamSubscription } from "./http/eventStream";

export const INGESTION_ENDPOINTS = {
  circuits: "/api/insurance/circuits",
  track: (circuit: string) => `/api/insurance/tracks/${encodeURIComponent(circuit)}`,
  incidents: "/api/insurance/incidents",
  ingest: "/api/insurance/incidents/ingest",
  ingestStream: (jobId: string) => `/api/insurance/incidents/ingest/${encodeURIComponent(jobId)}/stream`,
} as const;

const INGEST_EVENT_TYPES = ["progress", "incident", "done", "stream_error"] as const satisfies readonly IngestStreamEvent["type"][];
const INGEST_TERMINAL = ["done", "stream_error"] as const satisfies readonly IngestStreamEvent["type"][];

export const ingestionService = {
  /** GET /api/insurance/circuits → circuits with zone counts and data coverage. */
  listCircuits(signal?: AbortSignal): Promise<CircuitSummary[]> {
    return apiClient.get<CircuitSummary[]>(INGESTION_ENDPOINTS.circuits, { signal });
  },

  /** GET /api/insurance/tracks/{circuit} → outline, zones, safety inventory and reference lap. */
  getTrack(circuit: string, signal?: AbortSignal): Promise<TrackGeometry> {
    return apiClient.get<TrackGeometry>(INGESTION_ENDPOINTS.track(circuit), { signal });
  },

  /** GET /api/insurance/incidents?circuit&zone_id&season → processed incidents, newest first. */
  listIncidents(query: IncidentQuery, signal?: AbortSignal): Promise<Incident[]> {
    return apiClient.get<Incident[]>(INGESTION_ENDPOINTS.incidents, { query: { ...query }, signal });
  },

  /** POST /api/insurance/incidents/ingest → starts a background job and returns its id immediately. */
  startIngestion(request: IngestRequest, signal?: AbortSignal): Promise<IngestJob> {
    return apiClient.post<IngestJob>(INGESTION_ENDPOINTS.ingest, request, { signal });
  },

  /**
   * GET /api/insurance/incidents/ingest/{job_id}/stream (SSE).
   * Events: `progress` per pipeline stage, `incident` for each placed incident,
   * then `done` or `stream_error`. The subscription closes itself on either.
   */
  streamIngestion(jobId: string, handlers: StreamHandlers<IngestStreamEvent>): StreamSubscription {
    return openEventStream<IngestStreamEvent>(
      INGESTION_ENDPOINTS.ingestStream(jobId),
      { eventTypes: INGEST_EVENT_TYPES, terminal: INGEST_TERMINAL },
      handlers,
    );
  },
};
