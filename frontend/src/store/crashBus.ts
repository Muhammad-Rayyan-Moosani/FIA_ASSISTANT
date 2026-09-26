import type { SimulationCrash } from "@/types/risk";
import type { Incident } from "@/types/track";

/**
 * Fire-and-forget channel for high-frequency map effects (simulated crashes, freshly ingested incidents).
 * The 3D scene animates these imperatively, so they bypass React state and never trigger re-renders.
 */
export type MapEffect = { kind: "crash"; crash: SimulationCrash } | { kind: "incident"; incident: Incident };

type Listener = (effect: MapEffect) => void;

const listeners = new Set<Listener>();

export const mapEffects = {
  emit(effect: MapEffect): void {
    for (const l of listeners) l(effect);
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
