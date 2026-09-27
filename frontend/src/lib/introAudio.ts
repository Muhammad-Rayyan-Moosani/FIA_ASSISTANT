/**
 * Sound for the Circuit Guard intro, synthesised with Web Audio (no audio files): an engine that revs on the grid,
 * launches at lights out and shifts up through the gears, a whoosh as GUARD flies in, and the crash when it lands.
 * Browsers only allow sound after a click or key press, so `IntroAudio.create()` must run inside that handler.
 */

type Point = [t: number, hz: number];

/** Engine pitch over the intro (seconds after the start press, fundamental in Hz). */
const ENGINE_PITCH: Point[] = [
  [0, 58], [0.12, 150], [0.3, 92], [0.45, 175], [0.62, 104], [0.8, 205], [1.0, 188], [1.18, 196],   // revs on the grid
  [1.24, 120], [1.7, 330], [1.74, 215], [2.2, 360], [2.24, 240], [2.7, 385],                          // lights out: gears 1-3
  [2.86, 230], [2.95, 285], [3.05, 245], [3.4, 370],                                                  // hairpin: blips, then out
];
const ENGINE_OFF_AT = 3.5;           // cut when GUARD smashes in
export const CRASH_AT = 3.45;
export const WHOOSH_FROM = 3.12;

function noiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
  const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

/** Soft clipping: turns clean saw waves into a raspy engine note. */
function distortion(ctx: AudioContext, amount: number): WaveShaperNode {
  const shaper = ctx.createWaveShaper();
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = ((1 + amount) * x) / (1 + amount * Math.abs(x));
  }
  shaper.curve = curve;
  return shaper;
}

export class IntroAudio {
  private readonly master: GainNode;

  private constructor(private readonly ctx: AudioContext) {
    this.master = ctx.createGain();
    this.master.gain.value = 0.55;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.ratio.value = 12;
    this.master.connect(limiter).connect(ctx.destination);
  }

  /** Call from a click / key handler. Returns null when the browser has no Web Audio. */
  static create(): IntroAudio | null {
    const Ctor = typeof window !== "undefined" ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) : undefined;
    if (!Ctor) return null;
    try {
      const ctx = new Ctor();
      void ctx.resume();
      return new IntroAudio(ctx);
    } catch {
      return null;
    }
  }

  /** Schedule the whole soundtrack relative to now (the start press). */
  play(): void {
    const t0 = this.ctx.currentTime + 0.02;
    this.engine(t0);
    this.whoosh(t0 + WHOOSH_FROM);
    this.crash(t0 + CRASH_AT);
  }

  stop(): void {
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(0, now, 0.05);
    setTimeout(() => void this.ctx.close().catch(() => undefined), 400);
  }

  private engine(t0: number): void {
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, t0);
    out.gain.linearRampToValueAtTime(0.32, t0 + 0.08);
    out.gain.setValueAtTime(0.32, t0 + ENGINE_OFF_AT - 0.05);
    out.gain.exponentialRampToValueAtTime(0.0001, t0 + ENGINE_OFF_AT + 0.35);

    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.Q.value = 4;
    tone.frequency.setValueAtTime(900, t0);
    const shaper = distortion(ctx, 18);
    shaper.connect(tone).connect(out).connect(this.master);

    // three detuned saw/square layers at the firing frequency and its octave below
    const layers: [OscillatorType, number, number][] = [["sawtooth", 1, 0.5], ["sawtooth", 1.005, 0.35], ["square", 0.5, 0.3]];
    for (const [type, mult, level] of layers) {
      const osc = ctx.createOscillator();
      osc.type = type;
      const g = ctx.createGain();
      g.gain.value = level;
      osc.connect(g).connect(shaper);
      osc.frequency.setValueAtTime(ENGINE_PITCH[0]![1] * mult, t0);
      for (const [t, hz] of ENGINE_PITCH.slice(1)) osc.frequency.linearRampToValueAtTime(hz * mult, t0 + t);
      osc.start(t0);
      osc.stop(t0 + ENGINE_OFF_AT + 0.5);
    }
    // the filter opens with the revs: brighter at high rpm
    for (const [t, hz] of ENGINE_PITCH) tone.frequency.linearRampToValueAtTime(600 + hz * 7, t0 + t);

    // intake / exhaust roar: band-passed noise that tracks the pitch
    const roar = ctx.createBufferSource();
    roar.buffer = noiseBuffer(ctx, ENGINE_OFF_AT + 0.5);
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.Q.value = 1.2;
    const rg = ctx.createGain();
    rg.gain.value = 0.18;
    roar.connect(band).connect(rg).connect(out);
    for (const [t, hz] of ENGINE_PITCH) band.frequency.linearRampToValueAtTime(hz * 4, t0 + t);
    roar.start(t0);
  }

  private whoosh(at: number): void {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx, 0.5);
    const hp = ctx.createBiquadFilter();
    hp.type = "bandpass";
    hp.Q.value = 0.8;
    hp.frequency.setValueAtTime(400, at);
    hp.frequency.exponentialRampToValueAtTime(5200, at + 0.33);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.7, at + 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.42);
    src.connect(hp).connect(g).connect(this.master);
    src.start(at);
  }

  private crash(at: number): void {
    const ctx = this.ctx;
    // the hit: a noise burst that darkens as it decays
    const burst = ctx.createBufferSource();
    burst.buffer = noiseBuffer(ctx, 1.2);
    const bp = ctx.createBiquadFilter();
    bp.type = "lowpass";
    bp.frequency.setValueAtTime(7000, at);
    bp.frequency.exponentialRampToValueAtTime(300, at + 0.9);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(1.0, at);
    bg.gain.exponentialRampToValueAtTime(0.0001, at + 1.1);
    burst.connect(bp).connect(bg).connect(this.master);
    burst.start(at);

    // the thump you feel in the chest
    const thump = ctx.createOscillator();
    thump.type = "sine";
    thump.frequency.setValueAtTime(110, at);
    thump.frequency.exponentialRampToValueAtTime(32, at + 0.45);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(1.0, at);
    tg.gain.exponentialRampToValueAtTime(0.0001, at + 0.55);
    thump.connect(tg).connect(this.master);
    thump.start(at);
    thump.stop(at + 0.6);

    // carbon and metal ringing
    for (const [hz, level] of [[830, 0.12], [1245, 0.09], [1760, 0.07], [2630, 0.05]] as const) {
      const ring = ctx.createOscillator();
      ring.type = "triangle";
      ring.frequency.value = hz;
      const g = ctx.createGain();
      g.gain.setValueAtTime(level, at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.9);
      ring.connect(g).connect(this.master);
      ring.start(at);
      ring.stop(at + 1);
    }
  }
}
