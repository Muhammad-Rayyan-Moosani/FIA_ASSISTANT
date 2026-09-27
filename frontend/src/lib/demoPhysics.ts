/**
 * Wet-hairpin demo physics (simulated, clearly labelled as such in the UI).
 *
 * Two F1 cars on the real track centre line. A planar dynamic bicycle model per car:
 *   - tyres: Pacejka-style lateral force Fy = μ·Fz·sin(C·atan(B·α)); friction ellipse against braking;
 *     an axle whose brake demand exceeds μ·Fz locks and just slides (force opposite its velocity, 0.85 μ)
 *   - loads: static split + aerodynamic downforce (ClA) + longitudinal weight transfer
 *   - aero drag, rolling resistance, engine power limit
 *   - surfaces: wet track (intermediates), standing water across the outer part of the braking zone (aquaplaning, as
 *     at the Nürburgring's Turn 1 in 2007), wet run-off, and a tyre barrier modelled as a spring-damper
 *   - per side of the car: grip and water drag, so a car with one side in the water gets a yaw moment (split-μ
 *     braking plus drag) — the way aquaplaning cars snap sideways
 * A driver model steers by pure pursuit on a racing line and drives to a speed plan computed from what the driver
 * *believes* the grip is; it backs off the brake when the fronts lock, and past ~20° of slide it is a passenger
 * (both feet in). Car A believes the whole corner is ordinary wet track. Car B does too, until race control's
 * warning reaches it; after its reaction time it re-plans for standing water and takes the dry strip on the inside.
 *
 * Everything is in metres and seconds, integrated at 240 Hz. The renderer maps lateral offsets onto the 3D track,
 * which is drawn wider than real (see `visualLateral`).
 */

export interface Pt { x: number; z: number }

const G = 9.81;
const RHO = 1.2;
export const CAR = {
  m: 800, iz: 1150, a: 1.62, b: 1.98, h: 0.3,           // mass, yaw inertia, CG to axles, CG height
  clA: 3.6, aeroFront: 0.43, cdA: 1.1, crr: 0.015,        // downforce and drag areas, rolling resistance
  power: 750e3, brakeFront: 0.62, maxSteer: 0.4, steerRate: 1.6,
  B: 16, C: 1.4, kinetic: 0.85,                            // tyre shape; sliding / peak friction
};
const L = CAR.a + CAR.b;
const K_AERO = (0.5 * RHO * CAR.clA) / CAR.m;              // downforce per unit mass per v² (1/m)

export const SURFACE = { wet: 1.15, water: 0.3, runoffAsphalt: 0.85, runoffGravel: 0.55, runoffGrass: 0.35 };
export const TRACK_HALF_M = 7;
const CAR_HALF_W = 1.0;
// tyre barrier: soft and well damped (energy-absorbing, restitution ~0.1), steel-on-rubber friction along it
const BARRIER_K = 1.6e5, BARRIER_C = 1.0e4, BARRIER_MU = 0.35;
const DT = 1 / 240;
const REACTION_S = 0.6;
const SPIN_BETA = 0.35;                                    // rad (20°) of body slip past which the driver cannot catch it
// Standing water lies across the outer part of the track, stopping WATER_INNER_M short of the centre line on the inside
// (water runs to the low side). Wheels in it aquaplane (μ 0.3) and are dragged back by the water they push aside
// (≈ ρ·depth·tyre width·v², ~15 mm deep: ~4.8 kN per side at 250 km/h). One side in, one side out = a yaw moment,
// and under braking the dry side brakes up to four times harder than the aquaplaning side (split-μ) = a bigger one.
export const WATER_INNER_M = 1.0;
const WATER_DRAG = 1.0;                                    // N per (m/s)² per side (two tyres, ~15 mm deep)
const HALF_TRACK_W = 0.8;                                  // wheel centre to car centre line                                     // rad of body slip past which a car is spinning

export type Runoff = "asphalt" | "gravel" | "grass";

export interface DemoSetup {
  /** Closed track centre line in metres (race direction). */
  centre: Pt[];
  /** Apex of the demo corner, as an index into `centre`. */
  apexIndex: number;
  /** Outside of the corner: +1 along the left normal, −1 opposite. */
  side: 1 | -1;
  /** The barrier's distance from the centre line on the outside, in real metres. */
  barrierM: number;
  /** Barrier extent along the lap (indices into `centre`). */
  barrierRange: [number, number];
  runoff: Runoff;
}

export interface CarTelemetry {
  id: "A" | "B";
  s: number;
  lateral: number;       // metres from the centre line (left +)
  x: number; z: number;
  yaw: number;           // heading angle, atan2(fx, fz) convention
  speed: number;         // m/s
  steer: number;         // rad, road wheel
  brake: number;         // 0..1
  longG: number;         // + accelerating
  latG: number;
  gripUsed: number;      // measured decel / what the tyres should give on wet (1 = normal)
  frontLocked: boolean;
  rearLocked: boolean;
  surface: "wet" | "water" | "runoff";
  inBarrier: boolean;
  wheelSpin: number;
  /** Body slip angle: the angle between where the car points and where it goes (rad). */
  slide: number;
  /** Past the point of no return: spinning, brakes locked. */
  spinning: boolean;
}

export type DemoEvent =
  | { kind: "slip"; car: "A" | "B"; t: number; telemetry: CarTelemetry; expectedDecelG: number; measuredDecelG: number }
  | { kind: "spin"; car: "A" | "B"; t: number; telemetry: CarTelemetry }
  | { kind: "off"; car: "A" | "B"; t: number; telemetry: CarTelemetry }
  | { kind: "impact"; car: "A" | "B"; t: number; telemetry: CarTelemetry; impactSpeed: number; energyMJ: number }
  | { kind: "stopped"; car: "A" | "B"; t: number; telemetry: CarTelemetry; peakG: number }
  | { kind: "reacted"; car: "B"; t: number; telemetry: CarTelemetry }
  | { kind: "passed"; car: "B"; t: number; telemetry: CarTelemetry; minSpeed: number };

// ----------------------------------------------------------------------------- track
class Track {
  readonly p: Pt[];
  readonly t: Pt[];          // unit tangents
  readonly n: Pt[];          // left normals (−tz, tx), as the 3D frame
  readonly k: number[];      // signed curvature, + = turning left
  readonly ds: number;
  readonly length: number;

  constructor(raw: Pt[], step = 1) {
    // resample the closed polyline every `step` metres (Catmull-Rom), then smooth
    const n = raw.length;
    const seg: number[] = [];
    for (let i = 0; i < n; i++) seg.push(Math.hypot(raw[(i + 1) % n]!.x - raw[i]!.x, raw[(i + 1) % n]!.z - raw[i]!.z));
    const total = seg.reduce((s, v) => s + v, 0);
    const out: Pt[] = [];
    let i = 0, acc = 0;
    for (let s = 0; s < total; s += step) {
      while (acc + seg[i]! < s) { acc += seg[i]!; i = (i + 1) % n; }
      const u = (s - acc) / seg[i]!;
      const p0 = raw[(i - 1 + n) % n]!, p1 = raw[i]!, p2 = raw[(i + 1) % n]!, p3 = raw[(i + 2) % n]!;
      const cr = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u * u + (-a + 3 * b - 3 * c + d) * u * u * u);
      out.push({ x: cr(p0.x, p1.x, p2.x, p3.x), z: cr(p0.z, p1.z, p2.z, p3.z) });
    }
    const m = out.length;
    const smooth = (arr: Pt[], w: number) => arr.map((_, j) => {
      let sx = 0, sz = 0;
      for (let q = -w; q <= w; q++) { sx += arr[(j + q + m) % m]!.x; sz += arr[(j + q + m) % m]!.z; }
      return { x: sx / (2 * w + 1), z: sz / (2 * w + 1) };
    });
    this.p = smooth(out, 3);
    this.ds = step;
    this.length = m * step;
    this.t = this.p.map((_, j) => {
      const a = this.p[(j - 1 + m) % m]!, b = this.p[(j + 1) % m]!;
      const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      return { x: (b.x - a.x) / l, z: (b.z - a.z) / l };
    });
    this.n = this.t.map((t) => ({ x: -t.z, z: t.x }));
    const raw_k = this.t.map((_, j) => {
      const a = this.t[(j - 2 + m) % m]!, b = this.t[(j + 2) % m]!;
      return (a.x * b.z - a.z * b.x) / (4 * step);
    });
    const w = 6;
    this.k = raw_k.map((_, j) => {
      let s = 0;
      for (let q = -w; q <= w; q++) s += raw_k[(j + q + m) % m]!;
      return s / (2 * w + 1);
    });
  }

  idx(s: number): number {
    const m = this.p.length;
    return ((Math.round(s / this.ds) % m) + m) % m;
  }

  wrap(s: number): number {
    return ((s % this.length) + this.length) % this.length;
  }

  /** Nearest centre-line station to (x, z), searched around a previous station so parallel legs never swap. */
  project(x: number, z: number, near: number): { s: number; lateral: number } {
    let best = near, bestD = Infinity;
    for (let d = -25; d <= 70; d += 1) {
      const s = this.wrap(near + d);
      const p = this.p[this.idx(s)]!;
      const dd = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (dd < bestD) { bestD = dd; best = s; }
    }
    const i = this.idx(best);
    const lateral = (x - this.p[i]!.x) * this.n[i]!.x + (z - this.p[i]!.z) * this.n[i]!.z;
    return { s: best, lateral };
  }
}

// ----------------------------------------------------------------------------- driver plan
interface Belief {
  mu: (s: number) => number;         // grip the driver expects at s
  margin: number;                    // fraction of that grip the driver plans to use
  lineShift: (s: number) => number;  // extra lateral offset (towards the inside when avoiding)
}

function racingLine(track: Track): number[] {
  const m = track.k.length;
  const ref = [...track.k].map(Math.abs).sort((a, b) => a - b)[Math.floor(m * 0.93)] || 1e-3;
  const g = track.k.map((k) => Math.max(-1, Math.min(1, k / ref)));
  const smooth = (v: number[], w: number) => v.map((_, i) => {
    let s = 0;
    for (let q = -w; q <= w; q++) s += v[(i + q + m) % m]!;
    return s / (2 * w + 1);
  });
  const gs = smooth(g, 25);
  const look = 90;
  const line = gs.map((gi, i) => {
    const around = (gs[(i + look) % m]! + gs[(i - look + m) % m]!) * (1 - Math.abs(gi));
    return Math.max(-4.5, Math.min(4.5, 4.2 * gi - 3.2 * around));
  });
  return smooth(line, 15);
}

function speedPlan(track: Track, line: number[], belief: Belief): number[] {
  const m = track.k.length;
  const v = new Array<number>(m);
  for (let i = 0; i < m; i++) {
    const mu = belief.mu(i * track.ds) * belief.margin;
    const k = Math.abs(track.k[i]!) * 0.94;               // the line opens the corner slightly
    v[i] = Math.min(92, Math.sqrt((mu * G) / Math.max(k - mu * K_AERO, 1e-5)));
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 2 * m - 1; j >= 0; j--) {                  // braking: backwards from every corner
      const i = j % m, nx = (i + 1) % m;
      const mu = belief.mu(i * track.ds) * belief.margin;
      const a = mu * (G + K_AERO * v[nx]! * v[nx]!) + (0.5 * RHO * CAR.cdA * v[nx]! * v[nx]!) / CAR.m;
      v[i] = Math.min(v[i]!, Math.sqrt(v[nx]! * v[nx]! + 2 * a * track.ds));
    }
    for (let j = 0; j < 2 * m; j++) {                       // traction and power: forwards
      const i = j % m, pv = (i - 1 + m) % m;
      const mu = belief.mu(i * track.ds) * belief.margin;
      const a = Math.min(CAR.power / (CAR.m * Math.max(v[pv]!, 5)), 0.7 * mu * (G * (CAR.a / L) + K_AERO * v[pv]! * v[pv]! * 0.57));
      v[i] = Math.min(v[i]!, Math.sqrt(v[pv]! * v[pv]! + 2 * a * track.ds));
    }
  }
  void line;
  return v;
}

// ----------------------------------------------------------------------------- car
class Car {
  x: number; z: number; yaw: number;   // yaw: heading angle with forward = (sin yaw, cos yaw)
  vx: number; vy = 0; r = 0;          // body-frame velocities; r > 0 turns left
  steer = 0; brake = 0; throttle = 0; s: number; lateral = 0;
  ax = 0; ay = 0; axS = 0;             // axS: longitudinal accel smoothed over ~0.15 s (what a logger shows)
  waterL = false; waterR = false; muL = 1; muR = 1;
  frontLocked = false; rearLocked = false;
  surface: CarTelemetry["surface"] = "wet";
  inBarrier = false; wheelSpin = 0; crashed = false;
  plan: number[]; belief: Belief;
  stopped = false;
  /** Brake pedal limit: a driver who feels the fronts lock backs off to get the steering back, then squeezes on again. */
  pedalCap = 0.95;
  /** Past ~20° of slide on water the driver is a passenger: both feet in, wheels locked (the FIA spin drill). */
  spun = false;

  constructor(readonly id: "A" | "B", readonly track: Track, readonly line: number[], s: number, belief: Belief) {
    this.belief = belief;
    this.plan = speedPlan(track, line, belief);
    this.s = s;
    const i = track.idx(s);
    const off = line[i]! + belief.lineShift(s);
    this.x = track.p[i]!.x + track.n[i]!.x * off;
    this.z = track.p[i]!.z + track.n[i]!.z * off;
    this.yaw = Math.atan2(track.t[i]!.x, track.t[i]!.z);
    this.vx = this.plan[i]!;
  }

  replan(belief: Belief): void {
    this.belief = belief;
    this.plan = speedPlan(this.track, this.line, belief);
  }

  get speed(): number { return Math.hypot(this.vx, this.vy); }

  telemetry(expectedDecel: number): CarTelemetry {
    const measured = Math.max(0, -this.ax);
    return {
      id: this.id, s: this.s, lateral: this.lateral, x: this.x, z: this.z, yaw: this.yaw, speed: this.speed, steer: this.steer,
      brake: this.brake, longG: this.ax / G, latG: this.ay / G,
      gripUsed: this.brake > 0.2 && expectedDecel > 1 ? measured / expectedDecel : 1,
      frontLocked: this.frontLocked, rearLocked: this.rearLocked, surface: this.surface, inBarrier: this.inBarrier,
      wheelSpin: this.wheelSpin, slide: this.speed > 1 ? Math.atan2(this.vy, this.vx) : 0, spinning: this.spun,
    };
  }
}

// ----------------------------------------------------------------------------- simulation
export class WetHairpinSim {
  readonly track: Track;
  readonly line: number[];
  readonly setup: DemoSetup;
  readonly waterRange: [number, number];      // metres along the lap
  readonly apexS: number;
  readonly cars: { A: Car; B: Car };
  t = 0;
  private acc = 0;
  private warnedAt: number | null = null;
  private reacted = false;
  private flags = { slipA: false, spinA: false, offA: false, impactA: false, stoppedA: false, passedB: false };
  private peakG = 0;
  private minSpeedB = Infinity;
  private impactSpeed = 0;

  constructor(setup: DemoSetup, opts: { gapM?: number; startBeforeApexM?: number; water?: [number, number] } = {}) {
    this.setup = setup;
    this.track = new Track(setup.centre);
    this.line = racingLine(this.track);
    // the apex index is on the input polyline; move it to the resampled one by arc length
    const rawLen = setup.centre.reduce((s, p, i) => s + (i ? Math.hypot(p.x - setup.centre[i - 1]!.x, p.z - setup.centre[i - 1]!.z) : 0), 0);
    let upto = 0;
    for (let i = 1; i <= setup.apexIndex; i++) upto += Math.hypot(setup.centre[i]!.x - setup.centre[i - 1]!.x, setup.centre[i]!.z - setup.centre[i - 1]!.z);
    this.apexS = (upto / rawLen) * this.track.length;
    const [w0, w1] = opts.water ?? [230, 110];
    this.waterRange = [this.track.wrap(this.apexS - w0), this.track.wrap(this.apexS - w1)];
    const start = opts.startBeforeApexM ?? 500;
    const gap = opts.gapM ?? 190;
    const wet = () => SURFACE.wet;
    const believeWet: Belief = { mu: wet, margin: 0.97, lineShift: () => 0 };
    this.cars = {
      A: new Car("A", this.track, this.line, this.track.wrap(this.apexS - start), believeWet),
      B: new Car("B", this.track, this.line, this.track.wrap(this.apexS - start - gap), { ...believeWet, margin: 0.93 }),
    };
  }

  // -------------------------------------------------------------- queries
  inWater(s: number): boolean {
    const [a, b] = this.waterRange;
    return a <= b ? s >= a && s <= b : s >= a || s <= b;
  }

  /** How far (m, along the lap) `s` is before the apex; negative once past it. */
  toApex(s: number): number {
    let d = this.apexS - s;
    if (d < -this.track.length / 2) d += this.track.length;
    if (d > this.track.length / 2) d -= this.track.length;
    return d;
  }

  private inBarrierRange(s: number): boolean {
    const [a, b] = this.setup.barrierRange.map((i) => (i / this.setup.centre.length) * this.track.length);
    return a! <= b! ? s >= a! - 20 && s <= b! + 20 : s >= a! - 20 || s <= b! + 20;
  }

  /** Is there standing water at this lateral offset (at station s)? */
  waterAt(s: number, lateral: number): boolean {
    return this.inWater(s) && Math.abs(lateral) <= TRACK_HALF_M && lateral * this.setup.side >= -WATER_INNER_M;
  }

  private mu(car: Car): number {
    car.waterL = car.waterR = false;
    if (Math.abs(car.lateral) <= TRACK_HALF_M) {
      // each side of the car: the body's left axis projected on the track normal
      const i = this.track.idx(car.s);
      const across = -Math.cos(car.yaw) * this.track.n[i]!.x + Math.sin(car.yaw) * this.track.n[i]!.z;
      car.waterL = this.waterAt(car.s, car.lateral + HALF_TRACK_W * across);
      car.waterR = this.waterAt(car.s, car.lateral - HALF_TRACK_W * across);
      car.surface = car.waterL || car.waterR ? "water" : "wet";
      car.muL = car.waterL ? SURFACE.water : SURFACE.wet;
      car.muR = car.waterR ? SURFACE.water : SURFACE.wet;
      return (car.muL + car.muR) / 2;
    }
    car.surface = "runoff";
    car.muL = car.muR = this.setup.runoff === "gravel" ? SURFACE.runoffGravel : this.setup.runoff === "grass" ? SURFACE.runoffGrass : SURFACE.runoffAsphalt;
    return car.muL;
  }

  /** Race control's warning has reached car B's cockpit. */
  warn(): void {
    if (this.warnedAt === null) this.warnedAt = this.t;
  }

  get warned(): boolean {
    return this.warnedAt !== null;
  }

  /** Advance by `dt` seconds of real time (fixed 240 Hz substeps). */
  step(dt: number): DemoEvent[] {
    const events: DemoEvent[] = [];
    this.acc += Math.min(dt, 0.1);
    while (this.acc >= DT) {
      this.acc -= DT;
      this.t += DT;
      this.substep(events);
    }
    return events;
  }

  /** Centre-line point, unit tangent and left normal at `s` (metres along the lap). */
  station(s: number): { p: Pt; t: Pt; n: Pt } {
    const i = this.track.idx(s);
    return { p: this.track.p[i]!, t: this.track.t[i]!, n: this.track.n[i]! };
  }

  get lapLength(): number {
    return this.track.length;
  }

  telemetry(id: "A" | "B"): CarTelemetry {
    const c = this.cars[id];
    this.mu(c);                                                  // refresh the surface
    return c.telemetry(SURFACE.wet * (G + K_AERO * c.speed * c.speed));   // grip used vs what wet tyres should give
  }

  // -------------------------------------------------------------- one physics step
  private substep(events: DemoEvent[]): void {
    const B = this.cars.B;
    if (this.warnedAt !== null && !this.reacted && this.t - this.warnedAt >= REACTION_S) {
      this.reacted = true;
      const water = (s: number) => (this.inWater(s) || this.inWater(this.track.wrap(s + 12)) ? SURFACE.water * 0.95 : SURFACE.wet * 0.97);
      const inside = -this.setup.side;
      B.replan({
        mu: water, margin: 0.9,
        // keep 3 m to the inside through the corner, easing in and out over 80 m (no step in the line)
        // keep to the dry strip on the inside through the corner (4 m inside the centre line), easing in and out
        lineShift: (s) => {
          const d = this.toApex(s);
          const w = Math.max(0, Math.min(1, (340 - d) / 80, (d + 160) / 80));
          return (inside * 4 - this.line[this.track.idx(s)]!) * w * w * (3 - 2 * w);
        },
      });
      events.push({ kind: "reacted", car: "B", t: this.t, telemetry: this.telemetry("B") });
    }
    for (const car of [this.cars.A, B]) this.drive(car);
    for (const car of [this.cars.A, B]) {
      this.integrate(car);
      if (!car.spun && car.speed > 10 && Math.abs(Math.atan2(car.vy, car.vx)) > SPIN_BETA) car.spun = true;
    }
    this.detect(events);
  }

  private drive(car: Car): void {
    if (car.stopped || car.inBarrier || car.crashed || car.spun) {
      car.brake = 1;
      return;
    }
    const tr = this.track;
    const v = car.speed;
    const ld = 7 + 0.28 * v;
    const ts = tr.wrap(car.s + ld);
    const ti = tr.idx(ts);
    const off = this.line[ti]! + car.belief.lineShift(ts);
    const tx = tr.p[ti]!.x + tr.n[ti]!.x * off - car.x;
    const tz = tr.p[ti]!.z + tr.n[ti]!.z * off - car.z;
    const fx = Math.sin(car.yaw), fz = Math.cos(car.yaw);
    const lx = -fz, lz = fx;                                   // body left
    const alpha = Math.atan2(tx * lx + tz * lz, tx * fx + tz * fz);
    const want = Math.max(-CAR.maxSteer, Math.min(CAR.maxSteer, Math.atan((2 * L * Math.sin(alpha)) / ld)));
    const dmax = CAR.steerRate * DT;
    car.steer += Math.max(-dmax, Math.min(dmax, want - car.steer));

    const target = car.plan[tr.idx(tr.wrap(car.s + Math.max(4, v * 0.12)))]!;
    const err = target - v;
    // brake pedal as a fraction of what the driver expects the tyres to take; throttle otherwise
    const expected = car.belief.mu(car.s) * (G + K_AERO * v * v);
    car.pedalCap = car.frontLocked ? Math.max(0.2, car.pedalCap - 4 * DT) : Math.min(0.95, car.pedalCap + 1.2 * DT);
    car.brake = err < 0 ? Math.min(car.pedalCap, (-err * 1.6) / Math.max(expected, 1)) : 0;   // keeps a small margin
    // throttle comes in as the steering unwinds (no full power on full lock), like a real driver on a wet exit
    const unwind = 1 - 0.85 * Math.min(1, Math.abs(car.steer) / CAR.maxSteer);
    car.throttle = err > 0 ? Math.min(unwind, err * 0.5) : 0;
  }

  private integrate(car: Car): void {
    const m = CAR.m, a = CAR.a, b = CAR.b;
    const mu = this.mu(car);
    const v2 = car.vx * car.vx + car.vy * car.vy;
    const speed = Math.sqrt(v2);
    if (car.stopped) return;

    // normal loads: static + downforce + weight transfer (from last step's longitudinal accel)
    const down = 0.5 * RHO * CAR.clA * v2;
    const transfer = (m * car.ax * CAR.h) / L;
    const fzF = Math.max(200, m * G * (b / L) + down * CAR.aeroFront - transfer);
    const fzR = Math.max(200, m * G * (a / L) + down * (1 - CAR.aeroFront) + transfer);

    // brakes (what the driver asks: pedal × the grip he expects) and drive
    const expected = car.belief.mu(car.s) * (G + K_AERO * v2);
    const brakeForce = car.brake * expected * m;
    // the driver meters the throttle to ~75% of rear grip (traction management), keeping lateral grip in reserve
    const drive = car.throttle > 0 ? Math.min(CAR.power / Math.max(speed, 5), 0.75 * mu * fzR) * car.throttle : 0;
    const fxReqF = -brakeForce * CAR.brakeFront;
    const fxReqR = -brakeForce * (1 - CAR.brakeFront) + drive;

    // axle forces in the body frame
    const axle = (fz: number, fxReq: number, vLong: number, vLat: number, steer: number) => {
      const cap = mu * fz;
      // slip angle of this axle's tyres, relative to where the wheel points
      const cs = Math.cos(steer), sn = Math.sin(steer);
      const wl = vLong * cs + vLat * sn;                       // velocity in the wheel frame
      const wt = -vLong * sn + vLat * cs;
      if (Math.abs(fxReq) > cap && speed > 1) {                 // locked (or spinning): slides opposite its velocity
        const vm = Math.hypot(vLong, vLat) || 1;
        return { fx: (-CAR.kinetic * cap * vLong) / vm, fy: (-CAR.kinetic * cap * vLat) / vm, locked: true };
      }
      const alpha = speed > 1 ? -Math.atan2(wt, Math.abs(wl)) : 0;
      const fyPure = cap * Math.sin(CAR.C * Math.atan(CAR.B * alpha));
      const fyW = fyPure * Math.sqrt(Math.max(0, 1 - (fxReq / cap) ** 2));
      const fxW = speed > 0.3 || fxReq > 0 ? fxReq : 0;
      return { fx: fxW * cs - fyW * sn, fy: fxW * sn + fyW * cs, locked: false };
    };
    const front = axle(fzF, fxReqF, car.vx, car.vy + a * car.r, car.steer);
    const rear = axle(fzR, fxReqR, car.vx, car.vy - b * car.r, 0);
    car.frontLocked = front.locked;
    car.rearLocked = rear.locked;

    // resistances along the velocity
    const drag = 0.5 * RHO * CAR.cdA * v2 + CAR.crr * m * G + (car.surface === "runoff" && this.setup.runoff === "gravel" ? 0.45 * m * G : 0);
    let dragX = speed > 0.1 ? (-drag * car.vx) / speed : 0;
    let dragY = speed > 0.1 ? (-drag * car.vy) / speed : 0;
    // water drag per side, applied at the wheels: left side at +HALF_TRACK_W, right at −HALF_TRACK_W (body y)
    let mzWater = 0;
    if (speed > 1) {
      for (const [inWater, y] of [[car.waterL, HALF_TRACK_W], [car.waterR, -HALF_TRACK_W]] as const) {
        if (!inWater) continue;
        const fx = (-WATER_DRAG * v2 * car.vx) / speed, fy = (-WATER_DRAG * v2 * car.vy) / speed;
        dragX += fx;
        dragY += fy;
        mzWater += -y * fx;
      }
    }

    // barrier: spring-damper along the outward normal, friction along it
    let bx = 0, by = 0, bm = 0;
    car.inBarrier = false;
    if (this.inBarrierRange(car.s)) {
      const out = car.lateral * this.setup.side;
      const pen = out - (this.setup.barrierM - CAR_HALF_W);
      if (pen > 0) {
        car.inBarrier = true;
        const i = this.track.idx(car.s);
        const nx = this.track.n[i]!.x * this.setup.side, nz = this.track.n[i]!.z * this.setup.side;
        const fxw = Math.sin(car.yaw), fzw = Math.cos(car.yaw);
        const vwx = car.vx * fxw + car.vy * -fzw, vwz = car.vx * fzw + car.vy * fxw;   // world velocity
        const vn = vwx * nx + vwz * nz;
        const fn = Math.max(0, BARRIER_K * pen + BARRIER_C * vn);
        const tx = vwx - vn * nx, tz = vwz - vn * nz;
        const tv = Math.hypot(tx, tz) || 1;
        const wx = -fn * nx - (BARRIER_MU * fn * tx) / tv, wz = -fn * nz - (BARRIER_MU * fn * tz) / tv;
        bx = wx * fxw + wz * fzw;                               // back into the body frame
        by = wx * -fzw + wz * fxw;
        bm = -car.r * 3000;                                     // contact damps the spin
      }
    }

    const fxT = front.fx + rear.fx + dragX + bx;
    const fyT = front.fy + rear.fy + dragY + by;
    // split-μ braking: each axle's brake demand shared by its two sides, each side limited by its own grip
    let mzSplit = 0;
    if (car.muL !== car.muR && speed > 1) {
      for (const [fz, fxReq] of [[fzF, fxReqF], [fzR, fxReqR]] as const) {
        if (fxReq >= 0) continue;
        const side = (muSide: number) => Math.min(-fxReq / 2, (fz / 2) * muSide * (Math.abs(fxReq) > mu * fz ? CAR.kinetic : 1));
        mzSplit += HALF_TRACK_W * (side(car.muL) - side(car.muR));        // more braking on the left yaws left
      }
    }
    const mz = a * front.fy - b * rear.fy + bm + mzWater + mzSplit;
    car.ax = fxT / m;
    car.axS += (car.ax - car.axS) * Math.min(1, DT / 0.15);
    car.ay = fyT / m;

    if (speed < 2.5) {
      // low speed: kinematic, and come to rest under braking
      car.vx += car.ax * DT;
      car.vy *= 0.9;
      car.r = (car.vx * Math.tan(car.steer)) / L;
      if (car.brake > 0.05 && car.vx < 0.4) {
        car.vx = 0; car.vy = 0; car.r = 0;
        car.stopped = true;
      }
    } else {
      car.vx += (car.ax + car.vy * car.r) * DT;
      car.vy += (car.ay - car.vx * car.r) * DT;
      car.r += (mz / CAR.iz) * DT;
    }
    car.yaw -= car.r * DT;                                       // r > 0 turns left, yaw grows to the right
    const fxw = Math.sin(car.yaw), fzw = Math.cos(car.yaw);
    car.x += (car.vx * fxw + car.vy * -fzw) * DT;
    car.z += (car.vx * fzw + car.vy * fxw) * DT;
    car.wheelSpin = (car.wheelSpin + (car.frontLocked ? 0 : car.vx / 0.36) * DT) % (Math.PI * 2);
    const pr = this.track.project(car.x, car.z, car.s);
    car.s = pr.s;
    car.lateral = pr.lateral;
  }

  private detect(events: DemoEvent[]): void {
    const A = this.cars.A, B = this.cars.B;
    const f = this.flags;
    // Slip, as the car's own sensors see it: a wheel locking under braking, braking hard but decelerating far below
    // what wet tyres give, or the car sliding sideways
    if (!f.slipA && A.speed > 20 && Math.abs(A.lateral) <= TRACK_HALF_M) {
      const expected = SURFACE.wet * (G + K_AERO * A.speed * A.speed);
      const measured = Math.max(0, -A.axS);
      const locked = A.brake > 0.1 && (A.frontLocked || A.rearLocked);
      const weak = A.brake > 0.5 && measured < 0.5 * expected;
      if (locked || weak || Math.abs(Math.atan2(A.vy, A.vx)) > 0.12) {
        f.slipA = true;
        events.push({ kind: "slip", car: "A", t: this.t, telemetry: this.telemetry("A"), expectedDecelG: expected / G, measuredDecelG: measured / G });
      }
    }
    if (!f.spinA && A.spun) {
      f.spinA = true;
      events.push({ kind: "spin", car: "A", t: this.t, telemetry: this.telemetry("A") });
    }
    if (!f.offA && Math.abs(A.lateral) > TRACK_HALF_M + CAR_HALF_W) {
      f.offA = true;
      events.push({ kind: "off", car: "A", t: this.t, telemetry: this.telemetry("A") });
    }
    if (!f.impactA && A.inBarrier) {
      f.impactA = true;
      A.crashed = true;                                          // driver out of it: brakes locked, no steering
      this.impactSpeed = A.speed;
      events.push({ kind: "impact", car: "A", t: this.t, telemetry: this.telemetry("A"), impactSpeed: A.speed,
        energyMJ: (0.5 * CAR.m * A.speed * A.speed) / 1e6 });
    }
    if (f.impactA && !f.stoppedA) this.peakG = Math.max(this.peakG, Math.hypot(A.ax, A.ay) / G);
    if (f.impactA && !f.stoppedA && A.speed < 0.5) {
      f.stoppedA = true;
      A.stopped = true;
      events.push({ kind: "stopped", car: "A", t: this.t, telemetry: this.telemetry("A"), peakG: this.peakG });
    }
    if (this.toApex(B.s) < 120) this.minSpeedB = Math.min(this.minSpeedB, B.speed);
    if (!f.passedB && this.toApex(B.s) < -60 && this.toApex(B.s) > -300) {
      f.passedB = true;
      events.push({ kind: "passed", car: "B", t: this.t, telemetry: this.telemetry("B"), minSpeed: this.minSpeedB });
    }
  }

  get impactSpeedMs(): number {
    return this.impactSpeed;
  }
}

/** Where to draw a lateral offset on the 3D track, which is drawn wider than real: ×(drawnHalf/7) on the asphalt,
 * true scale beyond its edge (the run-off and barriers are drawn at real distances from the drawn edge). */
export function visualLateral(lateral: number, drawnHalfM: number): number {
  const a = Math.abs(lateral);
  const v = a <= TRACK_HALF_M ? a * (drawnHalfM / TRACK_HALF_M) : drawnHalfM + (a - TRACK_HALF_M);
  return Math.sign(lateral) * v;
}
