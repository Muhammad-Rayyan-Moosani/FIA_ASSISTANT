import { cn } from "@/lib/cn";
import { useStoryStore } from "@/store/storyStore";
import type { DriverWarning } from "@/types/raceControl";

const TONE: Record<DriverWarning["tone"], { led: string; text: string; ring: string }> = {
  yellow: { led: "bg-[#ffcc12]", text: "text-[#ffd84a]", ring: "shadow-[0_0_40px_-8px_#ffcc12]" },
  double_yellow: { led: "bg-[#ffcc12]", text: "text-[#ffd84a]", ring: "shadow-[0_0_48px_-6px_#ffcc12]" },
  sc: { led: "bg-[#ffb000]", text: "text-[#ffc233]", ring: "shadow-[0_0_48px_-6px_#ffb000]" },
  vsc: { led: "bg-[#ffb000]", text: "text-[#ffc233]", ring: "shadow-[0_0_40px_-8px_#ffb000]" },
  red: { led: "bg-[#ff2a2a]", text: "text-[#ff5a5a]", ring: "shadow-[0_0_48px_-6px_#ff2a2a]" },
  green: { led: "bg-[#1ee36b]", text: "text-[#4cf08c]", ring: "shadow-[0_0_40px_-8px_#1ee36b]" },
};
const LEDS = 15;

/**
 * The cockpit / steering-wheel display of the car closest behind the incident: what the FIA's marshalling
 * system would flash to that driver. Car and distance come from the real replay positions.
 */
export function DriverHud({ warning }: { warning: DriverWarning | null }) {
  // during the cinematic replay the display appears with the "cars behind are warned" shot, not over the crash
  const stage = useStoryStore((s) => s.stage);
  if (!warning || stage === "approach" || stage === "impact" || stage === "race_control") return null;
  const tone = TONE[warning.tone];
  const blink = warning.tone === "double_yellow" || warning.tone === "sc" || warning.tone === "red";
  return (
    <div className="pointer-events-none absolute left-1/2 top-24 z-20 -translate-x-1/2 animate-fade-in max-sm:top-28" role="status" aria-live="assertive">
      <div className={cn("w-[min(360px,86vw)] rounded-[22px] border border-white/10 bg-[#07090d]/95 p-3 text-white backdrop-blur", tone.ring)}>
        <div className="flex justify-center gap-[3px]" aria-hidden="true">
          {Array.from({ length: LEDS }, (_, i) => (
            <span key={i} className={cn("h-2 flex-1 rounded-full", tone.led, blink && (i % 2 ? "animate-pulse" : "animate-pulse [animation-delay:500ms]"))} />
          ))}
        </div>
        <div className="mt-2.5 grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-xl bg-black/60 px-3 py-2.5 ring-1 ring-white/5">
          <span className="num rounded-md px-1.5 py-0.5 text-[11px] font-bold" style={{ background: warning.colour ? `#${warning.colour}` : "#333", color: "#000" }}>
            {warning.code ?? (warning.driver ? `#${warning.driver}` : "ALL")}
          </span>
          <div className="min-w-0 text-center">
            <div className={cn("display text-[26px] font-bold uppercase leading-none tracking-[0.04em]", tone.text)}>{warning.title}</div>
            {warning.lines.map((l) => (
              <div key={l} className="num mt-1 text-[12.5px] font-semibold uppercase tracking-[0.06em] text-white/90">{l}</div>
            ))}
          </div>
          <span className="num text-right text-[11px] leading-tight text-white/70">
            {warning.distance_m > 0 ? <>{warning.distance_m.toLocaleString()} m<br />to incident</> : warning.sector ? <>S{warning.sector}</> : null}
          </span>
        </div>
        <p className="mt-1.5 text-center text-[10px] uppercase tracking-[0.14em] text-white/40">{warning.demo ? "Driver display · demo, simulated physics" : "Driver display · simulated from real positions"}</p>
      </div>
    </div>
  );
}
