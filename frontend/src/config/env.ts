const DEFAULT_API_URL = "http://localhost:8000";

export const env = {
  /** FastAPI base URL (insurance + race control). Set NEXT_PUBLIC_API_URL in frontend/.env.local. */
  apiBaseUrl: (process.env.NEXT_PUBLIC_API_URL ?? DEFAULT_API_URL).replace(/\/+$/, ""),
  requestTimeoutMs: 15_000,
} as const;
