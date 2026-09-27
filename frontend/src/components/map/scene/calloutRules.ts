import { Vector3 } from "three";
import { toWorld } from "@/lib/trackGeometry";
import type { StoryStage } from "@/store/storyStore";
import type { MastState, StoryInput } from "@/types/raceControl";
import type { CalloutSpec } from "./StoryCallouts";
import { subjectCar } from "./storyAnchors";

const FLAG_WORDS: Record<string, string> = {
  SC: "Safety Car", VSC: "Virtual Safety Car", DOUBLE_YELLOW: "double yellow", YELLOW: "yellow", SLIPPERY: "slippery surface", RED: "red flag", CLEAR: "clear",
};
const MAST_WORDS: Record<MastState, string> = {
  clear: "off", green: "GREEN", yellow: "YELLOW", double_yellow: "DOUBLE YELLOW", slippery: "SLIPPERY SURFACE", vsc: "VSC", sc: "SAFETY CAR", red: "RED",
};
const DEPLOYED: Record<string, string> = { sc: "Safety Car deployed", vsc: "VSC deployed", red: "Red flag shown" };

function driverName(input: StoryInput, n: string | null): string {
  if (!n) return "Car";
  const d = input.replayIncident?.involved.find((x) => x.number === n) ?? input.incident?.involved.find((x) => x.number === n);
  const code = d?.code ?? (input.warning?.driver === n ? input.warning.code : null);
  return code ? `Car ${n} (${code})` : `Car ${n}`;
}

/** What to label at each stage of the replay story. Every value comes from the race-control stream. */
export function storyCallouts(stage: StoryStage, input: StoryInput, tower: Vector3 | null, towerBasis: string | null): CalloutSpec[] {
  const out: CalloutSpec[] = [];
  const inc = input.incident;
  const story = stage !== "idle";

  if (stage === "approach") {
    const n = subjectCar(input);
    const r = input.replayIncident;
    if (n && r) {
      const d = r.involved.find((x) => x.number === n);
      const w = toWorld(r.x, r.y);
      out.push({
        id: "subject", tone: "car", title: driverName(input, n), anchor: { car: n, point: new Vector3(w.x, 0, w.z) }, offset: [-150, -90], liveSpeed: n,
        lines: [d?.team ?? "", `Real OpenF1 position · ${r.session_type} ${r.season}`].filter(Boolean),
      });
    }
  }

  if (inc) {
    const w = toWorld(inc.x, inc.y);
    const c = inc.collision;
    const who = driverName(input, c?.driver ?? inc.involved[0]?.number ?? null);
    out.push({
      id: "crash", tone: "crash", anchor: { car: c?.driver ?? null, point: new Vector3(w.x, 0, w.z) }, offset: story ? [-170, -110] : [-120, -70],
      title: c ? `${c.level === "crash" ? "Crash" : "Impact"} · ${who}` : `Incident · ${inc.zone_name}`,
      lines: c
        ? [`${Math.round(c.impact_speed_kph)} km/h impact · ${c.peak_long_g.toFixed(1)} g`, c.stopped ? "Stopped at the track side" : "Still moving", `Sector ${inc.marshal_sector ?? "?"} · ${inc.zone_name}`]
        : [inc.raw_message, `Sector ${inc.marshal_sector ?? "?"}`],
    });
  }

  const reported = stage === "race_control" || stage === "drivers" || stage === "overview";
  if (inc && tower && reported) {
    const masts = input.masts.filter((m) => m.state !== "clear").slice(0, 2).map((m) => `S${m.sector} ${MAST_WORDS[m.state].toLowerCase()}`);
    out.push({
      id: "rc", tone: "rc", title: "Race control", anchor: { car: null, point: tower }, offset: [60, -130],
      lines: [
        input.deployment !== "green" ? DEPLOYED[input.deployment]! : "Signal received from the track",
        masts.length ? `Masts: ${masts.join(" · ")}` : "",
        input.deployment === "green"
          ? inc.advisory && !inc.advisory.pending
            ? `${inc.advisory.source === "claude" ? "Claude advises" : "Rule engine advises"}: ${inc.advisory.recommended_action.replace("_", " ").toLowerCase()}`
            : `Suggests: ${FLAG_WORDS[inc.advice.flag] ?? inc.advice.flag}`
          : "",
        towerBasis ?? "",
      ].filter(Boolean),
    });
  }

  const warned = input.warning;
  if (warned?.driver && (stage === "drivers" || stage === "overview")) {
    out.push({
      id: "warned", tone: "warn", title: `${driverName(input, warned.driver)} notified`, anchor: { car: warned.driver, point: null }, offset: [60, 70],
      lines: [warned.lines[0] ?? warned.title, warned.distance_m > 0 ? `${warned.distance_m.toLocaleString()} m to the incident` : "", "Cockpit display + marshal lights"].filter(Boolean),
    });
  }

  if (inc && stage === "overview") {
    const mast = input.masts.find((m) => m.sector === inc.marshal_sector);
    if (mast && mast.state !== "clear") {
      const w = toWorld(mast.x, mast.y);
      out.push({ id: "mast", tone: "mast", title: `Marshal post S${mast.sector}`, anchor: { car: null, point: new Vector3(w.x, 0, w.z) }, offset: [-160, 80], lines: [MAST_WORDS[mast.state]] });
    }
  }
  return out;
}
