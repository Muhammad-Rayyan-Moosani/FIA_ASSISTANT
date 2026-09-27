import type { CarsFrame } from "@/types/raceControl";

/**
 * Latest replay frame (real car positions, 4 per replay-second). The 3D scene reads it every animation frame
 * and interpolates, so car movement never goes through React state.
 */
type Listener = (frame: CarsFrame | null) => void;

let latest: CarsFrame | null = null;
const listeners = new Set<Listener>();

export const replayBus = {
  push(frame: CarsFrame | null): void {
    latest = frame;
    for (const l of listeners) l(frame);
  },
  latest: (): CarsFrame | null => latest,
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** Where each replay car is drawn right now (world units), written by the 3D replay layer every frame. */
export interface CarPose {
  x: number;
  z: number;
  yaw: number;
  speed: number;
}
export const replayPositions = new Map<string, CarPose>();
