"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { DeltaChip } from "@/components/ui/charts";
import { Panel } from "@/components/ui/Panel";
import { scenarioKey, useWhatIf } from "@/hooks/insurance/useWhatIf";
import { useDebouncedCallback } from "@/hooks/ui/useDebouncedCallback";
import { formatEur } from "@/lib/format";
import { BARRIER_LABEL } from "@/lib/labels";
import { diffChanges, isEmptyChanges, withoutZone } from "@/lib/upgrades";
import { describeError } from "@/services/http/errors";
import { useUiStore } from "@/store/uiStore";
import type { Series } from "@/types/api";
import type { RiskMap, UpgradeSet } from "@/types/risk";
import type { BarrierType, TrackZone } from "@/types/track";

/** Slider ranges for the model's levers (factor 1 = today). */
const SPEED = { min: 0.6, max: 1, step: 0.05 } as const;
const FREQUENCY = { min: 0.4, max: 1, step: 0.05 } as const;
const DEBOUNCE_MS = 250;

interface Draft {
  barrier_type: BarrierType;
  speed_factor: number;
  frequency_multiplier: number;
}

const reduction = (factor: number) => (factor >= 1 ? "no change" : `−${Math.round((1 - factor) * 100)}%`);

interface WhatIfPanelProps {
  circuitId: string;
  series: Series;
  zone: TrackZone;
  upgrades: UpgradeSet;
  riskMap: RiskMap | undefined;
}

/** Price a safety upgrade for the selected zone. Mount with key={zone_id} so the form resets per zone. */
export function WhatIfPanel({ circuitId, series, zone, upgrades, riskMap }: WhatIfPanelProps) {
  const clearUpgrade = useUiStore((s) => s.clearUpgrade);
  const clearAll = useUiStore((s) => s.clearAllUpgrades);
  const whatIf = useWhatIf();
  const active = upgrades[zone.zone_id];
  const [draft, setDraft] = useState<Draft>(() => ({
    barrier_type: active?.barrier_type ?? zone.barrier_type,
    speed_factor: active?.speed_factor ?? 1,
    frequency_multiplier: active?.frequency_multiplier ?? 1,
  }));

  const submit = useDebouncedCallback((next: Draft) => {
    const changes = diffChanges(zone, next);
    if (isEmptyChanges(changes)) {
      whatIf.invalidate();
      clearUpgrade(circuitId, zone.zone_id);
      return;
    }
    whatIf.run(circuitId, series, zone.zone_id, changes, withoutZone(upgrades, zone.zone_id));
  }, DEBOUNCE_MS);

  const update = (patch: Partial<Draft>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    submit(next);
  };

  const currentKey = scenarioKey(circuitId, series, zone.zone_id, upgrades);
  const result = whatIf.result?.key === currentKey ? whatIf.result.data : null;

  // Coming back to an upgraded zone (or switching series) re-prices the upgrade so the comparison is current.
  const { run, isPending, error } = whatIf;
  useEffect(() => {
    if (active && !isEmptyChanges(active) && !result && !isPending && !error) run(circuitId, series, zone.zone_id, active, withoutZone(upgrades, zone.zone_id));
  }, [active, result, isPending, error, run, circuitId, series, zone.zone_id, upgrades]);

  const reset = () => {
    whatIf.invalidate();
    setDraft({ barrier_type: zone.barrier_type, speed_factor: 1, frequency_multiplier: 1 });
    clearUpgrade(circuitId, zone.zone_id);
  };

  const upgradeCount = Object.values(upgrades).filter((u) => !isEmptyChanges(u)).length;
  const s = riskMap?.sources ?? {};

  return (
    <Panel title="Safety what-if" source={s.what_if} description={`${zone.short_name}: change the barrier, or cut impact speed or crash frequency (for example with deeper run-off or better kerbs), and see the new price.`}>
      <div className="grid gap-3">
        <label className="grid gap-1.5 text-xs text-muted">
          Barrier
          <select
            value={draft.barrier_type}
            onChange={(e) => update({ barrier_type: e.target.value as BarrierType })}
            className="h-9 rounded-lg border border-line bg-bg px-2.5 text-sm text-ink"
          >
            {(Object.keys(BARRIER_LABEL) as BarrierType[]).map((b) => (
              <option key={b} value={b}>
                {BARRIER_LABEL[b]}
                {b === zone.barrier_type ? " (current)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1.5 text-xs text-muted">
          <span className="flex justify-between">
            Impact speed <span className="num text-ink">{reduction(draft.speed_factor)}</span>
          </span>
          <input type="range" min={SPEED.min} max={SPEED.max} step={SPEED.step} value={draft.speed_factor} onChange={(e) => update({ speed_factor: Number(e.target.value) })} />
        </label>
        <label className="grid gap-1.5 text-xs text-muted">
          <span className="flex justify-between">
            Crash frequency <span className="num text-ink">{reduction(draft.frequency_multiplier)}</span>
          </span>
          <input type="range" min={FREQUENCY.min} max={FREQUENCY.max} step={FREQUENCY.step} value={draft.frequency_multiplier} onChange={(e) => update({ frequency_multiplier: Number(e.target.value) })} />
        </label>
      </div>

      <div className="grid gap-2 rounded-xl border border-line-soft bg-bg p-3" aria-live="polite" aria-busy={whatIf.isPending}>
        {result ? (
          <>
            <CompareRow label="Zone expected loss" before={result.before.eal_eur} after={result.after.eal_eur} format={formatEur} />
            <CompareRow label="Zone premium" before={result.before.premium_eur} after={result.after.premium_eur} format={formatEur} />
            <CompareRow label="Circuit premium" before={result.circuit_premium_before_eur} after={result.circuit_premium_after_eur} format={formatEur} />
            <CompareRow label="Risk score" before={result.before.risk_score} after={result.after.risk_score} format={(v) => String(Math.round(v))} />
          </>
        ) : (
          <p className="text-[12.5px] text-faint">{whatIf.isPending ? "Pricing the upgrade…" : "Change a control above to price an upgrade."}</p>
        )}
      </div>

      {whatIf.error && <p className="text-[12.5px] text-risk-crit">{describeError(whatIf.error)}</p>}

      {result && (
        <p className="text-[13px]">
          {result.circuit_premium_before_eur > result.circuit_premium_after_eur ? (
            <>
              Premium saving <b className="display text-xl">{formatEur(result.circuit_premium_before_eur - result.circuit_premium_after_eur)}</b> per race weekend
            </>
          ) : (
            "No premium saving at this setting."
          )}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={reset} disabled={!active}>
          Reset zone
        </Button>
        {upgradeCount > 1 && (
          <Button size="sm" variant="ghost" onClick={() => clearAll(circuitId)}>
            Reset all {upgradeCount} upgrades
          </Button>
        )}
      </div>
    </Panel>
  );
}

function CompareRow({ label, before, after, format }: { label: string; before: number; after: number; format: (v: number) => string }) {
  return (
    <div className="grid grid-cols-[1fr_auto_auto_auto] items-baseline gap-2.5 text-[13px]">
      <span>{label}</span>
      <span className="num text-right text-muted">{format(before)}</span>
      <span className="text-faint" aria-hidden="true">→</span>
      <span className="num flex items-center justify-end gap-2">
        {format(after)}
        <DeltaChip delta={after - before} format={format} />
      </span>
    </div>
  );
}
