import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { insuranceService } from "@/services/insurance.service";
import { queryKeys } from "@/services/queryKeys";
import type { Series } from "@/types/api";
import type { UpgradeSet } from "@/types/risk";

/** Insured structures with exposure for the active scenario (Step 1 geometry + Step 3 risk). */
export function useAssets(circuitId: string | null, series: Series, upgrades: UpgradeSet) {
  const query = useQuery({
    queryKey: queryKeys.assets(circuitId ?? "", series, upgrades),
    queryFn: ({ signal }) => insuranceService.getAssets({ circuit: circuitId!, series, upgrades }, signal),
    enabled: circuitId !== null,
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  });
  const data = query.data?.circuit === circuitId ? query.data : undefined;
  return { ...query, data };
}
