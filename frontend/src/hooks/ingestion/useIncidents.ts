import { useQuery } from "@tanstack/react-query";
import { ingestionService } from "@/services/ingestion.service";
import { queryKeys } from "@/services/queryKeys";

/** Processed incidents for a circuit, optionally one zone (Step 1). */
export function useIncidents(circuitId: string | null, zoneId?: string | null) {
  const query = { circuit: circuitId ?? "", ...(zoneId ? { zone_id: zoneId } : {}) };
  return useQuery({
    queryKey: queryKeys.incidents(query),
    queryFn: ({ signal }) => ingestionService.listIncidents(query, signal),
    enabled: circuitId !== null && zoneId !== null,
    staleTime: 5 * 60_000,
  });
}
