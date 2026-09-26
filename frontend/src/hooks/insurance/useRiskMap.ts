import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { insuranceService } from "@/services/insurance.service";
import { queryKeys } from "@/services/queryKeys";
import type { Series } from "@/types/api";
import type { UpgradeSet } from "@/types/risk";

/**
 * Zone risk and premiums for the active scenario (Step 3).
 * While a new series or scenario loads, the previous result for the same circuit stays on screen.
 */
export function useRiskMap(circuitId: string | null, series: Series, upgrades: UpgradeSet) {
  const query = useQuery({
    queryKey: queryKeys.riskMap(circuitId ?? "", series, upgrades),
    queryFn: ({ signal }) => insuranceService.getRiskMap({ circuit: circuitId!, series, upgrades }, signal),
    enabled: circuitId !== null,
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  });
  const data = query.data?.circuit === circuitId ? query.data : undefined;
  return { ...query, data, isUpdating: query.isFetching && data !== undefined };
}
