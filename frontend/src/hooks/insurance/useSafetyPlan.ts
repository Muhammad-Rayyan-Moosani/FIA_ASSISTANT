import { useQuery } from "@tanstack/react-query";
import { insuranceService } from "@/services/insurance.service";
import { queryKeys } from "@/services/queryKeys";

/** The safety plan for one circuit. Only fetched once the plan is opened. */
export function useSafetyPlan(circuitId: string | null, enabled: boolean) {
  const query = useQuery({
    queryKey: queryKeys.safetyPlan(circuitId ?? ""),
    queryFn: ({ signal }) => insuranceService.getSafetyPlan(circuitId!, signal),
    enabled: enabled && circuitId !== null,
    staleTime: 5 * 60_000,
  });
  const data = query.data?.circuit === circuitId ? query.data : undefined;
  return { ...query, data };
}
