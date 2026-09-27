import { useQuery } from "@tanstack/react-query";
import { insuranceService } from "@/services/insurance.service";
import { queryKeys } from "@/services/queryKeys";

/** Third-party exposure for one circuit: counted from the ingested data, so it only changes after re-ingestion. */
export function useExposure(circuitId: string | null) {
  const query = useQuery({
    queryKey: queryKeys.exposure(circuitId ?? ""),
    queryFn: ({ signal }) => insuranceService.getExposure(circuitId!, signal),
    enabled: circuitId !== null,
    staleTime: 5 * 60_000,
  });
  const data = query.data?.circuit === circuitId ? query.data : undefined;
  return { ...query, data };
}
