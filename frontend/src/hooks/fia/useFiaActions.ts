"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { fiaService } from "@/services/fia.service";

export const fiaKeys = { scenario: ["fia", "scenario"] as const };

/** Demo scenario: track geometry, cars, rulebook name and sample incident queries. */
export function useFiaScenario() {
  return useQuery({ queryKey: fiaKeys.scenario, queryFn: fiaService.scenario, staleTime: Infinity });
}

/** Marshal-post camera frame → homography → segmentation (results are also fused into the feed). */
export function useCameraCheck() {
  return useMutation({ mutationFn: fiaService.cameraCheck });
}

/** Plain-English incident → FIA Sporting Regulations article citations. */
export function useRuleSearch() {
  return useMutation({ mutationFn: (incident: string) => fiaService.queryRules(incident) });
}

/** Sample team-radio clip → transcript segments → matching articles. */
export function useSampleRadio() {
  return useMutation({ mutationFn: fiaService.sampleRadio });
}

/** Header actions that drive the server-side scenario; their effects arrive over /ws/alerts. */
export function useRaceControlActions() {
  const run = useMutation({ mutationFn: (speedup: number) => fiaService.runTrajectory(speedup) });
  const crash = useMutation({ mutationFn: fiaService.simulateCrash });
  const reset = useMutation({ mutationFn: fiaService.reset });
  return { run, crash, reset, error: run.error ?? crash.error ?? reset.error };
}
