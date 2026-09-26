"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { serializeUpgrades } from "@/lib/upgrades";
import { insuranceService } from "@/services/insurance.service";
import { queryKeys } from "@/services/queryKeys";
import { useUiStore } from "@/store/uiStore";
import type { Series } from "@/types/api";
import type { UpgradeSet, WhatIfRequest, WhatIfResponse, ZoneChanges } from "@/types/risk";

export function scenarioKey(circuit: string, series: Series, zoneId: string, upgrades: UpgradeSet): string {
  return `${circuit}|${series}|${zoneId}|${serializeUpgrades(upgrades) ?? ""}`;
}

/**
 * Step 3 what-if: price a zone upgrade on top of the other active upgrades.
 * On success the repriced risk map is written straight into the cache, then the upgrade is
 * committed to the store — so the map, strip and summary switch to the new scenario without a refetch.
 * Responses from superseded requests (fast slider moves) are ignored.
 */
export function useWhatIf() {
  const queryClient = useQueryClient();
  const setUpgrade = useUiStore((s) => s.setUpgrade);
  const latest = useRef(0);
  const [result, setResult] = useState<{ key: string; data: WhatIfResponse } | null>(null);

  const mutation = useMutation({ mutationFn: (request: WhatIfRequest) => insuranceService.runWhatIf(request) });

  const run = useCallback(
    (circuit: string, series: Series, zoneId: string, changes: ZoneChanges, otherUpgrades: UpgradeSet) => {
      const seq = ++latest.current;
      const scenario: UpgradeSet = { ...otherUpgrades, [zoneId]: changes };
      mutation.mutate(
        { circuit, series, zone_id: zoneId, changes, upgrades: otherUpgrades },
        {
          onSuccess: (data) => {
            if (seq !== latest.current) return;
            queryClient.setQueryData(queryKeys.riskMap(circuit, series, scenario), data.risk_map);
            setUpgrade(circuit, zoneId, changes);
            setResult({ key: scenarioKey(circuit, series, zoneId, scenario), data });
          },
        },
      );
    },
    [mutation, queryClient, setUpgrade],
  );

  const invalidate = useCallback(() => {
    latest.current++;
    mutation.reset();
  }, [mutation]);

  return { run, invalidate, result, isPending: mutation.isPending, error: mutation.error };
}
