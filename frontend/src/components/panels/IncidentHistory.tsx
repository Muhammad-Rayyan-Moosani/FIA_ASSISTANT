"use client";

import { Skeleton } from "@/components/ui/Skeleton";
import { SourceBadge } from "@/components/ui/SourceBadge";
import { useIncidents } from "@/hooks/ingestion/useIncidents";
import { describeError } from "@/services/http/errors";
import type { SourceInfo } from "@/types/api";

const SESSION_SHORT: Record<string, string> = {
  "Practice 1": "FP1", "Practice 2": "FP2", "Practice 3": "FP3", Qualifying: "Quali",
  "Sprint Qualifying": "SQ", "Sprint Shootout": "SQ", Sprint: "Sprint", Race: "Race",
};

export function IncidentHistory({ circuitId, zoneId, source }: { circuitId: string; zoneId: string; source: SourceInfo | undefined }) {
  const { data, isPending, error } = useIncidents(circuitId, zoneId);
  const count = data?.length;

  return (
    <details className="group">
      <summary className="cursor-pointer text-[12.5px] text-muted">
        Incident history{count !== undefined && ` · ${count}`}
        {data && ` (${data.filter((i) => i.counts_as_crash).length} counted as crashes)`}
        <SourceBadge source={source} />
      </summary>
      <div className="mt-2.5 grid max-h-52 gap-1.5 overflow-y-auto scrollbar-thin">
        {isPending && [0, 1, 2].map((i) => <Skeleton key={i} className="h-4 w-full" />)}
        {error && <p className="text-[12.5px] text-risk-crit">{describeError(error)}</p>}
        {data?.length === 0 && <p className="text-[12.5px] text-faint">No incidents recorded here. The model still gives this zone a small crash rate, borrowed from similar zones.</p>}
        {data?.map((i) => (
          <div key={i.incident_id} className="grid grid-cols-[104px_1fr] gap-2 font-mono text-xs leading-snug">
            <span className="text-faint">
              {i.season} {SESSION_SHORT[i.session_type] ?? i.session_type}
              {i.lap !== null && ` L${i.lap}`}
            </span>
            <span title={`${i.incident_type.replaceAll("_", " ")} · placed by ${i.geo_method.replaceAll("_", " ")} (${i.geo_confidence} confidence)`} className={i.counts_as_crash ? "" : "text-muted"}>
              {i.counts_as_crash && <span className="mr-1.5 rounded bg-risk-crit/15 px-1 py-px font-sans text-[10px] font-semibold uppercase tracking-wide text-risk-crit">Crash</span>}
              {i.raw_message}
            </span>
          </div>
        ))}
      </div>
    </details>
  );
}
