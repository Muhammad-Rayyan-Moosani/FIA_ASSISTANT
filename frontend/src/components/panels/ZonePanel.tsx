import { RangeBar } from "@/components/ui/charts";
import { Panel } from "@/components/ui/Panel";
import { PanelSkeleton } from "@/components/ui/Skeleton";
import { SourceBadge } from "@/components/ui/SourceBadge";
import { Stat } from "@/components/ui/Stat";
import { TierBadge } from "@/components/ui/TierBadge";
import { formatEur, formatFraction, formatNumber, formatPercent } from "@/lib/format";
import { ZONE_TYPE_LABEL } from "@/lib/labels";
import { riskHex } from "@/lib/riskColor";
import type { ZoneView } from "@/lib/zoneView";
import type { RiskMap, ZoneChanges } from "@/types/risk";
import type { TrackGeometry } from "@/types/track";
import { IncidentHistory } from "./IncidentHistory";
import { SafetyInventory } from "./SafetyInventory";

interface ZonePanelProps {
  circuitId: string;
  view: ZoneView | undefined;
  track: TrackGeometry | undefined;
  riskMap: RiskMap | undefined;
  upgrade: ZoneChanges | undefined;
}

export function ZonePanel({ circuitId, view, track, riskMap, upgrade }: ZonePanelProps) {
  if (!view || !track) return <PanelSkeleton rows={6} />;
  const { zone, risk } = view;
  const rs = riskMap?.sources ?? {};
  const maxHi = Math.max(0, ...(riskMap?.zones.map((z) => z.crash_rate.hi90) ?? [0]));

  return (
    <Panel>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="display text-[26px] font-semibold leading-[1.05]">{zone.name}</h3>
          <p className="mt-1 text-xs text-muted">
            {ZONE_TYPE_LABEL[zone.zone_type]}
            {zone.turn_number !== null && ` · Turn ${zone.turn_number}`} · entry {zone.v_entry_kph} km/h
            {zone.zone_type === "braking" && ` → apex ${zone.v_apex_kph}`}
            <SourceBadge source={track.sources.speeds} />
          </p>
        </div>
        {risk && (
          <div className="grid justify-items-center gap-1.5">
            <TierBadge score={risk.risk_score} tier={risk.risk_tier} />
            <SourceBadge source={rs.score} className="ml-0" />
          </div>
        )}
      </div>

      {risk ? (
        <>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <div className="col-span-2">
              <Stat
                label="Crashes per weekend (best estimate, 90% range)"
                source={rs.crash_rate}
                value={
                  <>
                    {risk.crash_rate.mean.toFixed(2)}{" "}
                    <small className="text-[11.5px] text-muted">
                      ({risk.crash_rate.lo90.toFixed(2)}–{risk.crash_rate.hi90.toFixed(2)})
                    </small>
                  </>
                }
                hint={`${risk.crash_rate.n_incidents} counted crashes over ${formatNumber(risk.crash_rate.exposure)} race weekends`}
              />
              <RangeBar lo={risk.crash_rate.lo90} hi={risk.crash_rate.hi90} mean={risk.crash_rate.mean} max={maxHi} color={riskHex(risk.risk_score)} />
            </div>
            <Stat label="Chance of a crash this weekend" value={formatFraction(risk.crash_prob_season, 1)} source={rs.crash_prob} />
            <Stat label="Mean impact energy" value={<>{formatNumber(risk.energy_kj_mean)} <small className="text-[11.5px] text-muted">kJ</small></>} source={rs.energy} />
            <Stat label="Average cost per crash" value={formatEur(risk.mean_cost_per_crash_eur)} source={rs.energy} />
            <Stat label="Recorded incidents" value={formatNumber(zone.n_incidents)} hint={`${zone.n_loss_relevant} loss-relevant`} source={track.sources.incidents} />
            <Stat label="Expected loss (EAL)" value={formatEur(risk.eal_eur)} source={rs.eal} />
            <Stat label="1-in-100 worst case" value={formatEur(risk.var99_eur)} source={rs.var99} />
            <Stat label="Zone premium" value={formatEur(risk.premium_eur)} source={rs.zone_premium} />
            <Stat label="Recommended cover limit" value={formatEur(risk.recommended_limit_eur)} source={rs.limit} />
          </div>
          <div>
            <p className="text-[11.5px] text-faint">{formatPercent(risk.share_of_loss_pct)} of this circuit&apos;s expected loss</p>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded bg-bg">
              <div className="h-full bg-accent transition-[width] duration-500" style={{ width: `${Math.min(100, risk.share_of_loss_pct)}%` }} />
            </div>
          </div>
        </>
      ) : (
        <p className="text-[12.5px] text-faint">Risk figures appear once the risk map has loaded.</p>
      )}

      <SafetyInventory zone={zone} upgrade={upgrade} source={track.sources.safety_inventory} />
      <IncidentHistory circuitId={circuitId} zoneId={zone.zone_id} source={track.sources.incidents} />
    </Panel>
  );
}
