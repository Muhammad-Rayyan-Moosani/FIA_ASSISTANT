/**
 * The circuit upload: which files a club provides, and a quick check of each one in the browser
 * (right columns present, sensible values) with a one-line summary of what was found.
 */

export type UploadKey = "track" | "corners" | "incidents" | "spectators" | "marshals";

export interface UploadSpec {
  key: UploadKey;
  title: string;
  hint: string;
  required: boolean;
  /** Columns that must be present. */
  columns: string[];
  template: string;
  demo: string;
}

export const UPLOADS: UploadSpec[] = [
  { key: "track", title: "Track layout", required: true, columns: ["x_m", "y_m"],
    hint: "One GPS lap, x/y in metres.",
    template: "/templates/1_track_layout.csv", demo: "/demo/monza/1_track_layout.csv" },
  { key: "corners", title: "Corners", required: true, columns: ["number", "name", "distance_m"],
    hint: "Number, name, distance from start.",
    template: "/templates/2_corners.csv", demo: "/demo/monza/2_corners.csv" },
  { key: "incidents", title: "Incident log", required: true, columns: ["date", "corner", "type"],
    hint: "Date, corner, what happened.",
    template: "/templates/3_incident_log.csv", demo: "/demo/monza/3_incident_log.csv" },
  { key: "spectators", title: "Spectator areas", required: false, columns: ["name", "corners"],
    hint: "Stands and the corners they face.",
    template: "/templates/4_spectator_areas.csv", demo: "/demo/monza/4_spectator_areas.csv" },
  { key: "marshals", title: "Marshal posts", required: false, columns: ["post", "distance_m"],
    hint: "Post number, distance from start.",
    template: "/templates/5_marshal_posts.csv", demo: "/demo/monza/5_marshal_posts.csv" },
];

export interface CheckResult {
  ok: boolean;
  summary: string;
  rows: number;
  /** Track layout only: lap length in metres, used to recognise the circuit. */
  lengthM?: number;
}

/** Minimal CSV parser: commas, quoted fields with commas or doubled quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString("en")} ${word}${n === 1 ? "" : "s"}`;
}

/** Check one uploaded file against its spec and summarise it. */
export function checkUpload(spec: UploadSpec, text: string): CheckResult {
  const [header, ...body] = parseCsv(text);
  if (!header || body.length === 0) return { ok: false, summary: "The file is empty.", rows: 0 };
  const cols = header.map((h) => h.trim().toLowerCase());
  const missing = spec.columns.filter((c) => !cols.includes(c));
  if (missing.length) return { ok: false, summary: `Missing column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`, rows: body.length };
  const col = (name: string) => cols.indexOf(name);
  const values = (name: string) => body.map((r) => (r[col(name)] ?? "").trim());
  const numbers = (name: string) => values(name).map(Number).filter(Number.isFinite);

  switch (spec.key) {
    case "track": {
      if (numbers("x_m").length < body.length || numbers("y_m").length < body.length)
        return { ok: false, summary: "x_m and y_m must be numbers on every row.", rows: body.length };
      const d = cols.includes("distance_m") ? numbers("distance_m") : [];
      const x = numbers("x_m");
      const y = numbers("y_m");
      // Lap length: the last distance if given, otherwise the length of the drawn line.
      const lengthM = d.length ? Math.max(...d) : x.slice(1).reduce((sum, xi, i) => sum + Math.hypot(xi - x[i]!, y[i + 1]! - y[i]!), 0);
      const km = ` · ${(lengthM / 1000).toFixed(2)} km lap`;
      const speed = cols.includes("speed_kph") ? " · speed trace included" : "";
      const ok = body.length >= 20;
      return { ok, summary: ok ? `${plural(body.length, "point")}${km}${speed}` : "Need at least 20 points for a lap.", rows: body.length, lengthM };
    }
    case "corners":
      return { ok: true, summary: `${plural(body.length, "corner")}`, rows: body.length };
    case "incidents": {
      const years = new Set(values("date").map((d) => d.slice(0, 4)).filter(Boolean));
      const events = cols.includes("event") ? new Set(values("event").filter(Boolean)).size : 0;
      const serious = values("type").filter((t) => ["collision", "car_stopped", "yellow_flag", "debris"].includes(t)).length;
      return {
        ok: true,
        summary: `${plural(body.length, "incident")} · ${serious.toLocaleString("en")} serious · ${plural(years.size, "season")}${events ? ` · ${plural(events, "event")}` : ""}`,
        rows: body.length,
      };
    }
    case "spectators":
      return { ok: true, summary: `${plural(body.length, "spectator area")}`, rows: body.length };
    case "marshals":
      return { ok: true, summary: `${plural(body.length, "marshal post")}`, rows: body.length };
  }
}
