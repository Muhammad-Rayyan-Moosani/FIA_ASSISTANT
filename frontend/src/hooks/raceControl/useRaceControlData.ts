"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { raceControlService } from "@/services/raceControl.service";
import type { DeployAction } from "@/types/raceControl";

export const raceControlKeys = {
  incidents: (circuit: string) => ["race-control", "incidents", circuit] as const,
};

/** Real incidents (OpenF1 packs) that can be replayed at this circuit. */
export function useReplayableIncidents(circuitId: string | null) {
  const query = useQuery({
    queryKey: raceControlKeys.incidents(circuitId ?? ""),
    queryFn: ({ signal }) => raceControlService.incidents(circuitId!, signal),
    enabled: circuitId !== null,
    staleTime: Infinity,
  });
  const data = query.data?.circuit === circuitId ? query.data : undefined;
  return { ...query, data };
}

/** Replay / evaluate / deploy / reset: effects arrive over the SSE stream, these only start them. */
export function useRaceControlActions(circuitId: string | null) {
  const replay = useMutation({
    mutationFn: ({ incidentId, speed }: { incidentId: string; speed: number }) => raceControlService.replay(circuitId!, incidentId, speed),
  });
  const evaluate = useMutation({
    mutationFn: ({ target, speed }: { target: { marshal_sector?: number; zone_id?: string }; speed: number }) =>
      raceControlService.evaluate(circuitId!, target, speed),
  });
  const deploy = useMutation({ mutationFn: (action: DeployAction) => raceControlService.deploy(circuitId!, action) });
  const reset = useMutation({ mutationFn: () => raceControlService.reset(circuitId!) });
  return { replay, evaluate, deploy, reset, error: replay.error ?? evaluate.error ?? deploy.error ?? reset.error };
}

/** Free-text incident -> FIA Sporting Regulations articles. */
export function useRuleSearch() {
  return useMutation({ mutationFn: (query: string) => raceControlService.queryRules(query) });
}
