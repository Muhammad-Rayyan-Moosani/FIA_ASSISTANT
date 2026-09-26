const MINUS = "−";

/** €1.24M · €245k · €8.4k · €950 */
export function formatEur(value: number): string {
  if (!Number.isFinite(value)) return "–";
  const a = Math.abs(value);
  const sign = value < 0 ? MINUS : "";
  if (a >= 1e6) return `${sign}€${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e5) return `${sign}€${Math.round(a / 1e3)}k`;
  if (a >= 1e3) return `${sign}€${(a / 1e3).toFixed(1)}k`;
  return `${sign}€${Math.round(a)}`;
}

/** Signed money delta: +€1.2k / −€3.4k / "no change". */
export function formatEurDelta(delta: number): string {
  if (Math.abs(delta) < 0.5) return "no change";
  return `${delta > 0 ? "+" : MINUS}${formatEur(Math.abs(delta))}`;
}

/** 0.371 → "37%" (fraction input). */
export function formatFraction(value: number, digits = 0): string {
  return Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : "–";
}

/** 37.1 → "37%" (percentage input). */
export function formatPercent(value: number, digits = 0): string {
  return Number.isFinite(value) ? `${value.toFixed(digits)}%` : "–";
}

export function formatNumber(value: number, digits = 0): string {
  return Number.isFinite(value)
    ? value.toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : "–";
}

/** 84.916 → "1:24.916" */
export function formatLapTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return `${m}:${(seconds - m * 60).toFixed(3).padStart(6, "0")}`;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "–"
    : d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
