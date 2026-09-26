import { env } from "@/config/env";
import { ApiError, toApiError } from "./errors";

export type QueryValue = string | number | boolean | null | undefined;
export type QueryParams = Record<string, QueryValue>;

export interface RequestOptions {
  query?: QueryParams;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Build an absolute API URL. Null/undefined/empty query values are omitted. */
export function buildUrl(path: string, query?: QueryParams, base: string = env.apiBaseUrl): string {
  const url = new URL(path.startsWith("/") ? path : `/${path}`, `${base}/`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/** Combine the caller's signal with a timeout so either can cancel the request. */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    didTimeOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

async function send(method: Method, path: string, opts: RequestOptions, accept: string): Promise<Response> {
  const t = withTimeout(opts.signal, opts.timeoutMs ?? env.requestTimeoutMs);
  const headers: Record<string, string> = { Accept: accept };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  try {
    const res = await fetch(buildUrl(path, opts.query), {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: t.signal,
    });
    if (!res.ok) {
      const body: unknown = await res.json().catch(() => null);
      throw toApiError(res.status, body, `${method} ${path} failed with ${res.status}`);
    }
    return res;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (t.didTimeOut()) throw ApiError.client("TIMEOUT", `${method} ${path} timed out`);
    if (opts.signal?.aborted) throw ApiError.client("ABORTED", `${method} ${path} was cancelled`);
    throw ApiError.client("NETWORK_ERROR", `${method} ${path} could not reach the server`);
  } finally {
    t.dispose();
  }
}

async function requestJson<T>(method: Method, path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await send(method, path, opts, "application/json");
  if (res.status === 204) return undefined as T;
  try {
    return (await res.json()) as T;
  } catch {
    throw ApiError.client("INVALID_RESPONSE", `${method} ${path} returned invalid JSON`);
  }
}

export const apiClient = {
  get: <T>(path: string, opts?: Omit<RequestOptions, "body">) => requestJson<T>("GET", path, opts),
  post: <T>(path: string, body: unknown, opts?: Omit<RequestOptions, "body">) =>
    requestJson<T>("POST", path, { ...opts, body }),
  getBlob: async (path: string, opts?: Omit<RequestOptions, "body">): Promise<Blob> =>
    (await send("GET", path, opts ?? {}, "*/*")).blob(),
};
