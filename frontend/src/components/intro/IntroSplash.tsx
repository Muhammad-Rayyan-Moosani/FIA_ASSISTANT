"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { INTRO_COOKIE } from "@/lib/intro";
import { CRASH_AT, IntroAudio, WHOOSH_FROM } from "@/lib/introAudio";

// Timeline, seconds after the start press. Five lights, lights out, a lap that writes CIRCUIT, GUARD smashes in.
const LIGHT_STEP = 0.2;
const LIGHTS_OUT = 1.2;
const LAP_END = 3.2;
const GUARD_REST = 3.66;
const TAGLINE_AT = 3.75;
const EXIT_AT = 4.4;
const END_AT = 5.0;
const AUTO_START_MS = 6000;

// The circuit drawn around the name (SVG units): start/finish on the bottom straight, a hairpin on the right,
// a chicane on the back straight, a long left-hander home.
const VIEW_W = 1000;
const VIEW_H = 420;
const TRACK =
  "M 140 340 L 860 340 C 985 340 985 80 860 80 L 575 80 C 545 80 540 52 510 52 L 470 52 C 440 52 435 80 405 80 L 140 80 C 15 80 15 340 140 340 Z";
const BARRIER_X = 950;           // the hairpin's outer edge: where GUARD smashes through
const FONT_PX = 118;
const GAP = 34;
const BASELINE = 256;

const TITLE_FONT = { fontFamily: "var(--font-barlow), 'Arial Narrow', sans-serif", fontStyle: "italic", fontWeight: 800, fontSize: FONT_PX, letterSpacing: "0.01em" } as const;

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const easeIn = (u: number) => u * u * u;
const easeOut = (u: number) => 1 - (1 - u) ** 3;

interface Particle { x: number; y: number; vx: number; vy: number; life: number; max: number; kind: "spark" | "shard"; rot: number; spin: number; len: number }

function setIntroCookie() {
  document.cookie = `${INTRO_COOKIE}=1; path=/; SameSite=Lax`;
}

/** Small header button that plays the intro again (for a pitch). */
export function ReplayIntro() {
  return (
    <button
      type="button"
      onClick={() => {
        document.cookie = `${INTRO_COOKIE}=; Max-Age=0; path=/; SameSite=Lax`;
        window.location.reload();
      }}
      className="hidden h-8 items-center gap-1.5 rounded-md border border-line bg-bg/60 px-2.5 text-[12px] font-medium text-muted transition-colors hover:border-accent hover:text-ink sm:inline-flex"
      title="Play the Circuit Guard intro again"
    >
      <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l12-7.5z" /></svg>
      Intro
    </button>
  );
}

/**
 * The opening title: a start gantry, five red lights, lights out, a car laps a circuit and writes CIRCUIT behind it,
 * then GUARD smashes through the hairpin barrier from the right and lands next to it. About five seconds, with
 * engine and crash sound (the start press is the click browsers require before playing audio).
 */
export function IntroSplash() {
  const [phase, setPhase] = useState<"gate" | "run" | "done">("gate");
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const trail = useRef<SVGPathElement>(null);
  const car = useRef<SVGGElement>(null);
  const circuitText = useRef<SVGTextElement>(null);
  const guardText = useRef<SVGTextElement>(null);
  const guardGroup = useRef<SVGGElement>(null);
  const circuitGroup = useRef<SVGGElement>(null);
  const reveal = useRef<SVGRectElement>(null);
  const hairpinMask = useRef<SVGRectElement>(null);
  const blur = useRef<SVGFEGaussianBlurElement>(null);
  const flash = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const lights = useRef<HTMLDivElement>(null);
  const tagline = useRef<HTMLDivElement>(null);
  const audio = useRef<IntroAudio | null>(null);

  const finish = useCallback(() => {
    setIntroCookie();
    audio.current?.stop();
    audio.current = null;
    setPhase("done");
  }, []);

  const start = useCallback((withSound: boolean) => {
    if (withSound) {
      audio.current = IntroAudio.create();
      audio.current?.play();
    }
    setPhase("run");
  }, []);

  // reduced motion: no intro at all; otherwise start silently if nobody presses start
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const t = setTimeout(finish, 0);
      return () => clearTimeout(t);
    }
    if (phase !== "gate") return;
    // a background tab doesn't draw frames: wait until it is visible
    const go = () => (document.hidden ? document.addEventListener("visibilitychange", go, { once: true }) : start(false));
    const t = setTimeout(go, AUTO_START_MS);
    return () => {
      clearTimeout(t);
      document.removeEventListener("visibilitychange", go);
    };
  }, [phase, start, finish]);

  // keys: Enter / Space start with sound, Escape skips
  useEffect(() => {
    if (phase === "done") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish();
      else if (phase === "gate" && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        start(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, start, finish]);

  // the animation, driven frame by frame from one clock
  useEffect(() => {
    if (phase !== "run") return;
    const s = svg.current, path = trail.current, cText = circuitText.current, gText = guardText.current;
    const cv = canvas.current;
    if (!s || !path || !cText || !gText || !cv) return;
    const ctx = cv.getContext("2d");
    const L = path.getTotalLength();
    path.style.strokeDasharray = `${L}`;

    // lay out CIRCUIT + GUARD centred in the circuit, smaller if the font runs wide
    const k = Math.min(1, 700 / (cText.getComputedTextLength() + GAP + gText.getComputedTextLength()));
    cText.style.fontSize = gText.style.fontSize = `${FONT_PX * k}px`;
    const wC = cText.getComputedTextLength();
    const wG = gText.getComputedTextLength();
    const x0 = VIEW_W / 2 - (wC + GAP * k + wG) / 2;
    const xG = x0 + wC + GAP * k;
    cText.setAttribute("x", `${x0}`);
    gText.setAttribute("x", `${xG}`);
    const dxBarrier = BARRIER_X - xG;
    const dxStart = dxBarrier + 760;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const resize = () => {
      cv.width = window.innerWidth * dpr;
      cv.height = window.innerHeight * dpr;
    };
    resize();
    window.addEventListener("resize", resize);

    const toScreen = (x: number, y: number) => {
      const m = s.getScreenCTM();
      if (!m) return { x, y };
      const p = new DOMPoint(x, y).matrixTransform(m);
      return { x: p.x, y: p.y };
    };
    const particles: Particle[] = [];
    const burst = () => {
      // sparks where GUARD goes through the barrier, and shards of the barrier line itself
      for (let i = 0; i < 26; i++) {
        const along = i / 25;
        const px = BARRIER_X - 8 + Math.sin(along * Math.PI) * 10, py = 90 + along * 240;
        const p = toScreen(px, py);
        particles.push({ x: p.x, y: p.y, vx: -(120 + Math.random() * 520), vy: (Math.random() - 0.5) * 420, life: 0, max: 0.8 + Math.random() * 0.6,
          kind: "shard", rot: Math.random() * 6, spin: (Math.random() - 0.5) * 18, len: 10 + Math.random() * 16 });
      }
      for (let i = 0; i < 140; i++) {
        const p = toScreen(BARRIER_X, 110 + Math.random() * 200);
        const a = Math.PI + (Math.random() - 0.5) * 2.2;
        const v = 250 + Math.random() * 900;
        particles.push({ x: p.x, y: p.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 120, life: 0, max: 0.35 + Math.random() * 0.55,
          kind: "spark", rot: 0, spin: 0, len: 0 });
      }
    };

    let raf = 0;
    let crashed = false;
    const t0 = performance.now();
    let last = t0;
    const frame = (now: number) => {
      const t = (now - t0) / 1000;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      // start lights: one more every 0.2 s, all out together
      lights.current?.querySelectorAll<HTMLElement>("[data-light]").forEach((el, i) => {
        el.dataset.on = String(t >= i * LIGHT_STEP && t < LIGHTS_OUT);
      });
      if (lights.current) lights.current.style.opacity = String(t < LIGHTS_OUT + 0.15 ? 1 : clamp(1 - (t - LIGHTS_OUT - 0.15) / 0.35));

      // the lap: launch, flat out down the straight, brake for the hairpin and chicane, back to the line
      const u = clamp((t - LIGHTS_OUT) / (LAP_END - LIGHTS_OUT));
      const sLap = L * (0.62 * u + 0.38 * u * u);
      path.style.strokeDashoffset = `${L - sLap}`;
      const p = path.getPointAtLength(sLap);
      const q = path.getPointAtLength(Math.min(L, sLap + 2));
      const ang = (Math.atan2(q.y - p.y, q.x - p.x) * 180) / Math.PI;
      // on the grid during the lights, then the lap, then it pulls off as GUARD arrives
      car.current?.setAttribute("transform", `translate(${p.x} ${p.y}) rotate(${u >= 1 ? 0 : ang})`);
      car.current?.setAttribute("opacity", String(clamp(1 - (t - LAP_END - 0.25) / 0.2)));

      // CIRCUIT is written behind the car as it runs down the straight
      const onStraight = sLap <= 720;
      const revealTo = onStraight ? p.x : VIEW_W;
      reveal.current?.setAttribute("width", `${Math.max(0, revealTo - 20)}`);

      // GUARD: flies in from the right, smashes through the hairpin barrier, lands beside CIRCUIT
      let dx = dxStart;
      let skew = -16;
      let blurX = 0;
      if (t >= WHOOSH_FROM && t < CRASH_AT) {
        const a = easeIn((t - WHOOSH_FROM) / (CRASH_AT - WHOOSH_FROM));
        dx = dxStart + (dxBarrier - dxStart) * a;
        blurX = 14 * a;
      } else if (t >= CRASH_AT && t < GUARD_REST) {
        const a = easeOut((t - CRASH_AT) / (GUARD_REST - CRASH_AT));
        dx = dxBarrier + (-14 - dxBarrier) * a;
        skew = -16 * (1 - a);
        blurX = 10 * (1 - a);
      } else if (t >= GUARD_REST) {
        const a = clamp((t - GUARD_REST) / 0.18);
        dx = -14 * (1 - easeOut(a));
        skew = 0;
      }
      guardGroup.current?.setAttribute("transform", `translate(${dx + xG} ${BASELINE}) skewX(${skew}) translate(${-xG} ${-BASELINE})`);
      guardGroup.current?.setAttribute("opacity", t >= WHOOSH_FROM ? "1" : "0");
      blur.current?.setAttribute("stdDeviation", `${blurX} 0`);

      // the hit: barrier gone, sparks, flash, shake; CIRCUIT takes the knock when GUARD lands
      if (!crashed && t >= CRASH_AT) {
        crashed = true;
        burst();
        hairpinMask.current?.setAttribute("opacity", "1");
      }
      const sinceCrash = t - CRASH_AT;
      if (flash.current) flash.current.style.opacity = String(sinceCrash >= 0 ? clamp(0.55 - sinceCrash * 4) : 0);
      if (stage.current) {
        const shake = sinceCrash >= 0 && sinceCrash < 0.45 ? (1 - sinceCrash / 0.45) * 14 : 0;
        stage.current.style.transform = shake
          ? `translate(${(Math.random() - 0.5) * shake}px, ${(Math.random() - 0.5) * shake}px)`
          : t >= EXIT_AT ? `scale(${1 + (t - EXIT_AT) * 0.08})` : "";
      }
      const knock = t >= GUARD_REST - 0.02 && t < GUARD_REST + 0.2 ? Math.sin(((t - GUARD_REST + 0.02) / 0.22) * Math.PI) * -10 : 0;
      circuitGroup.current?.setAttribute("transform", `translate(${knock} 0)`);

      if (tagline.current) tagline.current.style.opacity = String(clamp((t - TAGLINE_AT) / 0.35));
      if (root.current) root.current.style.opacity = String(t < EXIT_AT ? 1 : clamp(1 - (t - EXIT_AT) / (END_AT - EXIT_AT)));

      // particles
      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cv.width, cv.height);
        for (const pt of particles) {
          pt.life += dt;
          if (pt.life > pt.max) continue;
          pt.vy += (pt.kind === "spark" ? 900 : 700) * dt;
          pt.vx *= 1 - 1.6 * dt;
          pt.x += pt.vx * dt;
          pt.y += pt.vy * dt;
          const fade = 1 - pt.life / pt.max;
          if (pt.kind === "spark") {
            ctx.strokeStyle = `rgba(255, ${190 + Math.round(60 * fade)}, ${90 * fade}, ${fade})`;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(pt.x, pt.y);
            ctx.lineTo(pt.x - pt.vx * 0.03, pt.y - pt.vy * 0.03);
            ctx.stroke();
          } else {
            pt.rot += pt.spin * dt;
            ctx.save();
            ctx.translate(pt.x, pt.y);
            ctx.rotate(pt.rot);
            ctx.strokeStyle = `rgba(225, 6, 0, ${fade})`;
            ctx.lineWidth = 4;
            ctx.beginPath();
            ctx.moveTo(-pt.len / 2, 0);
            ctx.lineTo(pt.len / 2, 0);
            ctx.stroke();
            ctx.restore();
          }
        }
      }

      if (t >= END_AT) {
        finish();
        return;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [phase, finish]);

  if (phase === "done") return null;
  const running = phase === "run";

  return (
    <div ref={root} className="fixed inset-0 z-[200] overflow-hidden bg-[#07080a] text-white" role="dialog" aria-label="Circuit Guard intro">
      <div className="carbon absolute inset-0" aria-hidden="true" />
      <div
        className="absolute inset-0"
        aria-hidden="true"
        style={{ background: "radial-gradient(1100px 520px at 50% 55%, rgba(225,6,0,0.16), transparent 70%), radial-gradient(1400px 900px at 50% 50%, transparent 55%, rgba(0,0,0,0.85))" }}
      />

      <div ref={stage} className="relative flex h-full flex-col items-center justify-center gap-[3vh] px-4">
        {/* start gantry */}
        <div ref={lights} className="flex gap-[1.4vw] rounded-lg border border-white/10 bg-[#101216] px-[1.6vw] py-[1.1vw] shadow-[0_20px_60px_-20px_#000]" aria-hidden="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="grid gap-[0.6vw] rounded-md bg-black px-[0.5vw] py-[0.6vw]">
              {[0, 1].map((j) => (
                <span
                  key={j}
                  data-light={j === 1 ? "" : undefined}
                  data-on="false"
                  className={
                    j === 1
                      ? "block size-[clamp(18px,3.2vw,40px)] rounded-full bg-[#2a0605] transition-[background-color,box-shadow] duration-75 data-[on=true]:bg-[#ff1a0e] data-[on=true]:shadow-[0_0_28px_6px_rgba(255,26,14,0.75)]"
                      : "block size-[clamp(18px,3.2vw,40px)] rounded-full bg-[#1a1c20]"
                  }
                />
              ))}
            </div>
          ))}
        </div>

        {/* the circuit and the name */}
        <div className="relative">
        <svg ref={svg} viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="w-[min(94vw,1100px)] overflow-visible" aria-label="Circuit Guard">
          <defs>
            <filter id="cg-glow" x="-20%" y="-40%" width="140%" height="180%">
              <feGaussianBlur stdDeviation="6" result="b" />
              <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
            <filter id="cg-motion" x="-30%" y="-10%" width="160%" height="120%">
              <feGaussianBlur ref={blur} stdDeviation="0 0" />
            </filter>
            <clipPath id="cg-reveal"><rect ref={reveal} x="0" y="0" width="0" height={VIEW_H} /></clipPath>
            <mask id="cg-barrier">
              <rect x="0" y="0" width={VIEW_W} height={VIEW_H} fill="#fff" />
              <rect ref={hairpinMask} x={BARRIER_X - 70} y="0" width="140" height={VIEW_H} fill="#000" opacity="0" />
            </mask>
            <linearGradient id="cg-red" x1="0" x2="1">
              <stop offset="0" stopColor="#e10600" />
              <stop offset="1" stopColor="#ff5a1f" />
            </linearGradient>
          </defs>

          <g mask="url(#cg-barrier)">
            {/* unlit track, kerb-dashed */}
            <path d={TRACK} fill="none" stroke="#2a2e36" strokeWidth="14" strokeLinejoin="round" />
            <path d={TRACK} fill="none" stroke="#3a3f49" strokeWidth="14" strokeDasharray="10 14" strokeLinejoin="round" opacity="0.6" />
            {/* the lap, lit behind the car */}
            <path ref={trail} d={TRACK} fill="none" stroke="url(#cg-red)" strokeWidth="6" strokeLinejoin="round" strokeLinecap="round" filter="url(#cg-glow)"
              style={{ strokeDasharray: 5000, strokeDashoffset: 5000 }} />
          </g>
          {/* start / finish line */}
          <g transform="translate(140 326)">
            {[0, 1, 2, 3].map((r) => [0, 1].map((c) => (
              <rect key={`${r}${c}`} x={c * 7} y={r * 7} width="7" height="7" fill={(r + c) % 2 ? "#0b0c0f" : "#f2f3f5"} />
            )))}
          </g>

          <g ref={circuitGroup}>
            <text ref={circuitText} x="140" y={BASELINE} clipPath="url(#cg-reveal)" fill="#f2f3f5" filter="url(#cg-glow)" style={TITLE_FONT}>
              CIRCUIT
            </text>
          </g>
          <g ref={guardGroup} opacity="0" filter="url(#cg-motion)">
            <text ref={guardText} x="600" y={BASELINE} fill="url(#cg-red)" style={TITLE_FONT}>
              GUARD
            </text>
          </g>

          {/* the car: top view, nose to +x */}
          <g ref={car} opacity="0">
            <g transform="scale(1.8) translate(-19 -8)">
              <rect x="0" y="-1" width="6" height="18" rx="1" fill="#e10600" />
              <rect x="31" y="0" width="5" height="16" rx="1" fill="#e10600" />
              <rect x="3" y="-3" width="8" height="5" rx="1.5" fill="#111" />
              <rect x="3" y="14" width="8" height="5" rx="1.5" fill="#111" />
              <rect x="25" y="-2" width="7" height="4.5" rx="1.5" fill="#111" />
              <rect x="25" y="13.5" width="7" height="4.5" rx="1.5" fill="#111" />
              <path d="M5 4 L26 5.5 L38 7 L38 9 L26 10.5 L5 12 Z" fill="#e10600" />
              <circle cx="18" cy="8" r="2.6" fill="#ffd400" />
              <rect x="-10" y="6.5" width="10" height="3" fill="url(#cg-red)" opacity="0.7" />
            </g>
          </g>
        </svg>
        {!running && (
          <div className="absolute inset-0 grid place-items-center">
            <div className="grid justify-items-center gap-3">
              <button
                type="button"
                onClick={() => start(true)}
                autoFocus
                className="race-title grid size-[clamp(84px,11vw,120px)] place-items-center rounded-full border-4 border-[#ff1a0e] bg-[radial-gradient(circle_at_35%_30%,#ff4a3a,#b30500_70%)] text-[clamp(13px,1.5vw,17px)] leading-tight text-white shadow-[0_0_0_8px_rgba(225,6,0,0.18),0_0_50px_rgba(225,6,0,0.55)] transition-transform hover:scale-105 active:scale-95"
              >
                Start<br />engine
              </button>
              <p className="flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-white/55">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor" stroke="none" /><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" strokeLinecap="round" />
                </svg>
                Sound on · press Enter
              </p>
            </div>
          </div>
        )}
        </div>

        <div ref={tagline} className="grid justify-items-center gap-3 opacity-0">
          <span className="checker h-3 w-[min(60vw,420px)] opacity-80" aria-hidden="true" />
          <p className="race-title text-center text-[clamp(14px,2vw,22px)] tracking-[0.18em] text-white/85">Race control · Insurance · One live map</p>
        </div>

      </div>

      <canvas ref={canvas} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true" />
      <div ref={flash} className="pointer-events-none absolute inset-0 bg-white opacity-0" aria-hidden="true" />
      <button type="button" onClick={finish} className="absolute bottom-5 right-5 rounded-md border border-white/15 px-3 py-1.5 text-[12px] uppercase tracking-[0.14em] text-white/60 transition-colors hover:border-white/40 hover:text-white">
        Skip intro
      </button>
    </div>
  );
}
