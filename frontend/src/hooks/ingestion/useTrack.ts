import { useQuery } from "@tanstack/react-query";
import { ingestionService } from "@/services/ingestion.service";
import { queryKeys } from "@/services/queryKeys";

/** Track outline, zones and safety inventory for one circuit (Step 1). */
export function useTrack(circuitId: string | null) {
  return useQuery({
    queryKey: queryKeys.track(circuitId ?? ""),
    queryFn: ({ signal }) => ingestionService.getTrack(circuitId!, signal),
    enabled: circuitId !== null,
    staleTime: 10 * 60_000,
  });
}
