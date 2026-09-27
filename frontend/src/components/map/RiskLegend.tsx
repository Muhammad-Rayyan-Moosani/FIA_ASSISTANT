export function RiskLegend() {
  return (
    <div className="pointer-events-none absolute bottom-3.5 left-4 w-40 sm:w-56 lg:left-5" aria-hidden="true">
      <div className="mb-1.5 text-[11px] text-muted">Serious incidents per race weekend</div>
      <div className="h-1.5 rounded bg-[linear-gradient(90deg,var(--color-risk-low),var(--color-risk-med)_45%,var(--color-risk-high)_75%,var(--color-risk-crit))]" />
      <div className="mt-1 flex justify-between text-[10.5px] uppercase tracking-[0.06em] text-muted">
        <span>Few</span>
        <span>Most</span>
      </div>
    </div>
  );
}
