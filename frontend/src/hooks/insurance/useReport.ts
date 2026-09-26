"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { insuranceService } from "@/services/insurance.service";
import { queryKeys } from "@/services/queryKeys";
import type { Series } from "@/types/api";
import type { ReportQuery, UpgradeSet } from "@/types/risk";

/** Underwriter report for the active scenario; only fetched while the drawer is open (Step 3). */
export function useReport(circuitId: string | null, series: Series, upgrades: UpgradeSet, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.report(circuitId ?? "", series, upgrades),
    queryFn: ({ signal }) => insuranceService.getReport({ circuit: circuitId!, series, upgrades }, signal),
    enabled: enabled && circuitId !== null,
    staleTime: 10 * 60_000,
  });
}

/** Download the PDF version of the report. */
export function useReportPdf() {
  return useMutation({
    mutationFn: (query: ReportQuery) => insuranceService.downloadReportPdf(query),
    onSuccess: (blob, { circuit, series }) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `underwriter-report-${circuit}-${series}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    },
  });
}
