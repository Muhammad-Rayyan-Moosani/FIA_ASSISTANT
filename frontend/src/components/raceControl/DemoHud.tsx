"use client";

import { cn } from "@/lib/cn";
import type { CarTelemetry } from "@/lib/demoPhysics";
import { DEMO_LABEL, useDemoStore } from "@/store/demoStore";

const SURFACE: Record<CarTelemetry["surface"], string> = { wet: "Wet track", water: "Standing water", runoff: "Run-off" };

function status(c: CarTelemetry): { text: string; tone: string } {
  if (c.inBarrier) return { text: "In the barrier", tone: "text-[#ff5a5a]" };
  if (c.speed < 0.5) return { text: "Stopped", tone: "text-[#ff5a5a]" };
  if (c.spinning) return { text: `Spinning · ${Math.round(Math.abs(c.slide) * 57.3)}° sideways · ${SURFACE[c.surface].toLowerCase()}`, tone: "text-[#ff5a5a]" };
  if (c.frontLocked || c.rearLocked) return { text: `${c.frontLocked ? "Fronts" : "Rears"} locked · ${SURFACE[c.surface].toLowerCase()}`, tone: "text-[#ffd84a]" };
  return { text: SURFACE[c.surface], tone: c.surface === "wet" ? "text-white/70" : "text-[#ffd84a]" };
}

function Row({ id, colour, car, note }: { id: string; colour: string; car: CarTelemetry | null; note?: string }) {
  if (!car) return null;
  const s = status(car);
  const grip = Math.round(Math.min(1.5, car.gripUsed) * 100);
  return (
    <div className="grid grid-cols-[auto_1fr] items-center gap-x-2.5 gap-y-0.5">
      <span className="num row-span-2 grid size-7 place-items-center rounded-md text-[12px] font-bold text-black" style={{ background: colour }}>{id}</span>
      <div className="num flex items-baseline gap-3 text-[12px]">
        <span className="text-[17px] font-semibold leading-none text-white">{Math.round(car.speed * 3.6)}<span className="ml-0.5 text-[10px] text-white/60">km/h</span></span>
        <span className="text-white/70">brake</span>
        <span className="h-1.5 w-12 overflow-hidden rounded-full bg-white/15"><span className="block h-full bg-[#ff2b3e]" style={{ width: `${Math.round(car.brake * 100)}%` }} /></span>
        <span className="text-white/70">{Math.abs(car.latG).toFixed(1)} g lat</span>
        {car.brake > 0.2 && <span className={grip < 60 ? "text-[#ff5a5a]" : "text-white/70"}>grip {grip}%</span>}
      </div>
      <div className={cn("text-[11px]", s.tone)}>{s.text}{note ? <span className="text-white/60"> · {note}</span> : null}</div>
    </div>
  );
}

/** Live telemetry of the two simulated cars, in place of the replay bar while the demo runs. */
export function DemoHud() {
  const phase = useDemoStore((s) => s.phase);
  const cars = useDemoStore((s) => s.cars);
  const t = useDemoStore((s) => s.t);
  const warnedBy = useDemoStore((s) => s.warnedBy);
  if (phase === "idle") return null;
  const note = warnedBy === "race_control" ? "warned by race control" : warnedBy === "fallback" ? "warned (race control offline, local fallback)" : "no warning yet";
  return (
    <div className="pointer-events-none absolute bottom-16 left-4 z-10 grid w-[min(460px,calc(100%-2rem))] gap-2 rounded-xl border border-white/10 bg-black/75 px-3 py-2.5 text-white backdrop-blur">
      <div className="flex items-center justify-between gap-3 text-[11px]">
        <span className="flex items-center gap-1.5 font-semibold uppercase tracking-[0.12em]">
          <span className={phase === "ended" ? "size-2 rounded-full bg-white/40" : "size-2 animate-pulse rounded-full bg-[#27f4d2]"} />
          {DEMO_LABEL}
        </span>
        <span className="num text-white/80">{t.toFixed(1)} s</span>
      </div>
      <Row id="A" colour="#e8002d" car={cars.A} />
      <Row id="B" colour="#27f4d2" car={cars.B} note={note} />
      <p className="text-[10.5px] leading-snug text-white/55">
        Bicycle model at 240 Hz · Pacejka-style tyres on intermediates (μ 1.15 wet, 0.3 standing water) · downforce, drag, weight transfer · tyre barrier. After the Nürburgring 2007 downpour at Turn 1.
      </p>
    </div>
  );
}
