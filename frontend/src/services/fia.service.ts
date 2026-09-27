import { env } from "@/config/env";
import { buildUrl, type QueryParams } from "@/services/http/apiClient";
import { ApiError, describeError } from "@/services/http/errors";
import type { DemoVisionResult, FiaScenario, RuleQueryResult, Transcription } from "@/types/fia";

/**
 * Client for the FIA service (FIA/ folder). It is a separate FastAPI app from the insurance
 * backend, so it has its own base URL and FastAPI's `{"detail": "..."}` error shape.
 */
const BASE = env.fiaApiBaseUrl;

interface CallOptions {
  body?: unknown;
  query?: QueryParams;
  timeoutMs?: number;
}

async function call<T>(method: "GET" | "POST", path: string, opts: CallOptions = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query, BASE), {
      method,
      headers: { Accept: "application/json", ...(opts.body !== undefined && { "Content-Type": "application/json" }) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? env.requestTimeoutMs),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") throw ApiError.client("TIMEOUT", `${method} ${path} timed out`);
    throw ApiError.client("NETWORK_ERROR", `${method} ${path} could not reach the FIA service`);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: unknown } | null;
    const detail = typeof body?.detail === "string" ? body.detail : `${method} ${path} failed with ${res.status}`;
    throw new ApiError(res.status, `HTTP_${res.status}`, detail);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export function describeFiaError(error: unknown): string {
  if (error instanceof ApiError && error.isNetwork) {
    return `Can't reach the FIA service at ${BASE}. Start it from the FIA folder with: python -m uvicorn app.main:app --port 8100`;
  }
  return describeError(error);
}

export const fiaService = {
  baseUrl: BASE,
  alertsUrl: (): string => `${BASE.replace(/^http/, "ws")}/ws/alerts`,
  scenario: () => call<FiaScenario>("GET", "/api/v1/demo/scenario"),
  reset: () => call<unknown>("POST", "/api/v1/demo/reset"),
  runTrajectory: (speedup: number) => call<unknown>("POST", "/api/v1/demo/run-trajectory", { query: { speedup } }),
  simulateCrash: () => call<unknown>("POST", "/api/v1/demo/crash"),
  cameraCheck: () => call<DemoVisionResult>("POST", "/api/v1/umap/demo-vision", { timeoutMs: 60_000 }),
  queryRules: (incident: string, topK = 3) =>
    call<RuleQueryResult>("POST", "/api/v1/fia-assistant/query-rules", { body: { incident_description: incident, top_k: topK }, timeoutMs: 30_000 }),
  sampleRadio: () => call<Transcription>("POST", "/api/v1/fia-assistant/demo-transcribe", { timeoutMs: 30_000 }),
};
