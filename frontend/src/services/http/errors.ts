import type { ApiErrorBody } from "@/types/api";

export type ClientErrorCode = "NETWORK_ERROR" | "TIMEOUT" | "ABORTED" | "INVALID_RESPONSE" | "STREAM_ERROR";

/** Every failure from the service layer is an ApiError, so the UI handles one error shape. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: Record<string, unknown> | undefined;

  constructor(status: number, code: string, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }

  /** 0 = the request never got an HTTP response (offline, CORS, timeout). */
  get isNetwork(): boolean {
    return this.status === 0;
  }

  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500;
  }

  static client(code: ClientErrorCode, message: string): ApiError {
    return new ApiError(0, code, message);
  }
}

export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== "object" || value === null || !("error" in value)) return false;
  const err = (value as { error: unknown }).error;
  return typeof err === "object" && err !== null && "code" in err && "message" in err;
}

export function toApiError(status: number, body: unknown, fallback: string): ApiError {
  if (isApiErrorBody(body)) return new ApiError(status, body.error.code, body.error.message, body.error.detail);
  return new ApiError(status, `HTTP_${status}`, fallback);
}

export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.isNetwork) return "Can't reach the backend. Check that the API is running and NEXT_PUBLIC_API_URL is correct.";
    return error.message;
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}
