/**
 * STEP 3 · INSURANCE API — frontend integration (backend owner: R3 · API; maths by R2 · actuarial.py).
 *
 * Risk map, safety what-if, the live season-simulation stream and the underwriter report.
 * Every call accepts the active what-if upgrades so all views price the same scenario.
 *
 * Contract types: src/types/risk.ts · Spec: ARCHITECTURE.md §5–§7.
 */
import { serializeUpgrades } from "@/lib/upgrades";
import type { AssetMap } from "@/types/assets";
import type { ExposureMap } from "@/types/exposure";
import type { SafetyPlan } from "@/types/safetyPlan";
import type {
  ReportQuery,
  RiskMap,
  RiskMapQuery,
  SimulationQuery,
  SimulationStreamEvent,
  UnderwriterReport,
  WhatIfRequest,
  WhatIfResponse,
} from "@/types/risk";
import { apiClient } from "./http/apiClient";
import { openEventStream, type StreamHandlers, type StreamSubscription } from "./http/eventStream";

export const INSURANCE_ENDPOINTS = {
  exposure: (circuit: string) => `/api/insurance/exposure/${encodeURIComponent(circuit)}`,
  safetyPlan: (circuit: string) => `/api/insurance/safety-plan/${encodeURIComponent(circuit)}`,
  riskMap: "/api/insurance/risk-map",
  assets: (circuit: string) => `/api/insurance/assets/${encodeURIComponent(circuit)}`,
  whatIf: "/api/insurance/what-if",
  simulateStream: "/api/insurance/simulate/stream",
  report: "/api/insurance/report/export",
} as const;

const SIM_EVENT_TYPES = ["season_start", "crash", "progress", "done", "stream_error"] as const satisfies readonly SimulationStreamEvent["type"][];
const SIM_TERMINAL = ["done", "stream_error"] as const satisfies readonly SimulationStreamEvent["type"][];

/** The 10,000-season Monte Carlo can take a moment on a cold cache. */
const MODEL_TIMEOUT_MS = 30_000;
/** Report generation may call the LLM. */
const REPORT_TIMEOUT_MS = 60_000;

export const insuranceService = {
  /** GET /api/insurance/exposure/{circuit} → how often people are exposed, where, and whether it repeats. */
  getExposure(circuit: string, signal?: AbortSignal): Promise<ExposureMap> {
    return apiClient.get<ExposureMap>(INSURANCE_ENDPOINTS.exposure(circuit), { signal });
  },

  /** GET /api/insurance/safety-plan/{circuit} → options to protect spectators at the busiest crowd corners, with estimated CAD prices. */
  getSafetyPlan(circuit: string, signal?: AbortSignal): Promise<SafetyPlan> {
    return apiClient.get<SafetyPlan>(INSURANCE_ENDPOINTS.safetyPlan(circuit), { signal });
  },

  /** GET /api/insurance/risk-map?circuit&series&upgrades → zone risk, premiums and totals. */
  getRiskMap({ circuit, series, upgrades }: RiskMapQuery, signal?: AbortSignal): Promise<RiskMap> {
    return apiClient.get<RiskMap>(INSURANCE_ENDPOINTS.riskMap, {
      query: { circuit, series, upgrades: serializeUpgrades(upgrades) },
      signal,
      timeoutMs: MODEL_TIMEOUT_MS,
    });
  },

  /** GET /api/insurance/assets/{circuit}?series&upgrades → real structures, coverage lines and exposure. */
  getAssets({ circuit, series, upgrades }: RiskMapQuery, signal?: AbortSignal): Promise<AssetMap> {
    return apiClient.get<AssetMap>(INSURANCE_ENDPOINTS.assets(circuit), {
      query: { series, upgrades: serializeUpgrades(upgrades) },
      signal,
      timeoutMs: MODEL_TIMEOUT_MS,
    });
  },

  /** POST /api/insurance/what-if → before/after for one zone and the repriced risk map. */
  runWhatIf(request: WhatIfRequest, signal?: AbortSignal): Promise<WhatIfResponse> {
    return apiClient.post<WhatIfResponse>(INSURANCE_ENDPOINTS.whatIf, request, { signal, timeoutMs: MODEL_TIMEOUT_MS });
  },

  /**
   * GET /api/insurance/simulate/stream?circuit&series&seasons&upgrades (SSE).
   * Events: `season_start`, `crash`, `progress` (running EAL), then `done` or `stream_error`.
   */
  streamSimulation(
    { circuit, series, seasons, upgrades }: SimulationQuery,
    handlers: StreamHandlers<SimulationStreamEvent>,
  ): StreamSubscription {
    return openEventStream<SimulationStreamEvent>(
      INSURANCE_ENDPOINTS.simulateStream,
      {
        query: { circuit, series, seasons, upgrades: serializeUpgrades(upgrades) },
        eventTypes: SIM_EVENT_TYPES,
        terminal: SIM_TERMINAL,
      },
      handlers,
    );
  },

  /** GET /api/insurance/report/export?format=json → structured underwriter report. */
  getReport({ circuit, series, upgrades }: ReportQuery, signal?: AbortSignal): Promise<UnderwriterReport> {
    return apiClient.get<UnderwriterReport>(INSURANCE_ENDPOINTS.report, {
      query: { circuit, series, format: "json", upgrades: serializeUpgrades(upgrades) },
      signal,
      timeoutMs: REPORT_TIMEOUT_MS,
    });
  },

  /** GET /api/insurance/report/export?format=pdf → PDF file. */
  downloadReportPdf({ circuit, series, upgrades }: ReportQuery, signal?: AbortSignal): Promise<Blob> {
    return apiClient.getBlob(INSURANCE_ENDPOINTS.report, {
      query: { circuit, series, format: "pdf", upgrades: serializeUpgrades(upgrades) },
      signal,
      timeoutMs: REPORT_TIMEOUT_MS,
    });
  },
};
