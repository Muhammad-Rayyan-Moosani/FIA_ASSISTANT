const DEFAULT_API_URL = "http://localhost:8000";
const DEFAULT_FIA_API_URL = "http://localhost:8100";

export const env = {
  /** FastAPI base URL. Set NEXT_PUBLIC_API_URL in frontend/.env.local. */
  apiBaseUrl: (process.env.NEXT_PUBLIC_API_URL ?? DEFAULT_API_URL).replace(/\/+$/, ""),
  /** FIA service (FIA/ folder: μMap race control, rulebook, radio). Set NEXT_PUBLIC_FIA_API_URL. */
  fiaApiBaseUrl: (process.env.NEXT_PUBLIC_FIA_API_URL ?? DEFAULT_FIA_API_URL).replace(/\/+$/, ""),
  requestTimeoutMs: 15_000,
} as const;
