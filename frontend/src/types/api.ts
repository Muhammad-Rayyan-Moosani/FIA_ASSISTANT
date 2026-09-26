/**
 * Types shared by every backend endpoint.
 * Mirrors backend/api/schemas.py — see ARCHITECTURE.md §7.
 */

export type Series = "f1" | "f2" | "f3";

/**
 * Where a value comes from, so the UI can label it honestly:
 * - measured: observed data (e.g. OpenF1 telemetry)
 * - assumed:  a configured assumption or placeholder input
 * - modelled: produced by the actuarial engine from other inputs
 */
export type Provenance = "measured" | "assumed" | "modelled";

export interface SourceInfo {
  provenance: Provenance;
  title: string;
  /** Plain text; paragraphs separated by a blank line. */
  detail: string;
}

export type SourceMap<K extends string> = Partial<Record<K, SourceInfo>>;

/** Error envelope returned with every 4xx/5xx (ARCHITECTURE.md §7.4). */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    detail?: Record<string, unknown>;
  };
}
