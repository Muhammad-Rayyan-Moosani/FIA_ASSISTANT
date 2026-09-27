import { create } from "zustand";

/**
 * Where the cinematic replay is: set by the camera director inside the 3D scene (on stage changes only),
 * read by the callout and caption overlays outside it.
 */
export type StoryStage = "idle" | "approach" | "impact" | "race_control" | "drivers" | "overview";

interface StoryState {
  stage: StoryStage;
  setStage: (stage: StoryStage) => void;
  /** Bumped by the overlay's Skip button; the director hands the camera back. */
  skipSeq: number;
  skip: () => void;
}

export const useStoryStore = create<StoryState>()((set) => ({
  stage: "idle",
  setStage: (stage) => set((s) => (s.stage === stage ? s : { stage })),
  skipSeq: 0,
  skip: () => set((s) => ({ skipSeq: s.skipSeq + 1, stage: "idle" })),
}));

export const STAGE_CAPTION: Record<Exclude<StoryStage, "idle">, { step: string; title: string }> = {
  approach: { step: "1", title: "Following the car on its real telemetry" },
  impact: { step: "2", title: "The incident" },
  race_control: { step: "3", title: "Race control receives the signal" },
  drivers: { step: "4", title: "Cars behind are warned" },
  overview: { step: "5", title: "Race control view" },
};

/** Captions for the wet-hairpin demo (simulated physics), in its shot order. */
export const DEMO_STAGE_CAPTION: Record<Exclude<StoryStage, "idle">, { step: string; title: string }> = {
  approach: { step: "1", title: "Car A braking into standing water" },
  impact: { step: "2", title: "Aquaplaning: sideways into the fence" },
  drivers: { step: "3", title: "Car B warned: slows, passes the wreck" },
  race_control: { step: "4", title: "Race control: the full picture" },
  overview: { step: "5", title: "Race control view" },
};
