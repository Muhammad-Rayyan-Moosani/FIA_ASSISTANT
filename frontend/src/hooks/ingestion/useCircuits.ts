import { useQuery } from "@tanstack/react-query";
import { ingestionService } from "@/services/ingestion.service";
import { queryKeys } from "@/services/queryKeys";

/** All circuits with their data coverage (Step 1). */
export function useCircuits() {
  return useQuery({
    queryKey: queryKeys.circuits(),
    queryFn: ({ signal }) => ingestionService.listCircuits(signal),
    staleTime: 5 * 60_000,
  });
}
