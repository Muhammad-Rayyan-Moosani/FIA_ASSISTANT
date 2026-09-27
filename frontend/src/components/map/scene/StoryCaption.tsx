"use client";

import { cn } from "@/lib/cn";
import { useDemoStore } from "@/store/demoStore";
import { DEMO_STAGE_CAPTION, STAGE_CAPTION, useStoryStore } from "@/store/storyStore";

const ORDER = ["approach", "impact", "race_control", "drivers", "overview"] as const;
const DEMO_ORDER = ["approach", "impact", "drivers", "race_control", "overview"] as const;

/** Broadcast-style caption for the cinematic replay, with a Skip button that hands the camera back. */
export function StoryCaption() {
  const stage = useStoryStore((s) => s.stage);
  const skip = useStoryStore((s) => s.skip);
  const demo = useDemoStore((s) => s.phase !== "idle");
  if (stage === "idle") return null;
  const cap = (demo ? DEMO_STAGE_CAPTION : STAGE_CAPTION)[stage];
  return (
    <div className="absolute right-4 top-4 z-20 w-[min(320px,calc(100%-2rem))] animate-fade-in rounded-xl border border-white/10 bg-[#07090d]/85 px-3.5 py-2.5 text-white backdrop-blur">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-white/60">{demo ? "Demo" : "Replay"} · step {cap.step} of 5</span>
        <button type="button" onClick={skip} className="rounded-md border border-white/20 px-2 py-0.5 text-[11px] text-white/80 hover:bg-white/10">Skip</button>
      </div>
      <div className="display mt-1 text-[18px] font-bold uppercase leading-tight tracking-[0.03em]">{cap.title}</div>
      <div className="mt-2 flex gap-1" aria-hidden="true">
        {(demo ? DEMO_ORDER : ORDER).map((s, i, order) => (
          <span key={s} className={cn("h-1 flex-1 rounded-full", i <= order.indexOf(stage) ? "bg-[#ffb000]" : "bg-white/15")} />
        ))}
      </div>
    </div>
  );
}
