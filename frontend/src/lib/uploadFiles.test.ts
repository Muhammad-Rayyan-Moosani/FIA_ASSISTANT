import { describe, expect, it } from "vitest";
import { UPLOADS, checkUpload, parseCsv, sortUploads } from "./uploadFiles";

const spec = (key: string) => UPLOADS.find((u) => u.key === key)!;

describe("parseCsv", () => {
  it("handles quoted commas, doubled quotes and CRLF", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n')).toEqual([["a", "b"], ["x, y", 'say "hi"']]);
  });
});

describe("checkUpload", () => {
  it("summarises an incident log", () => {
    const csv = "date,event,session,corner,type\n2024-09-01,GP,Race,1,collision\n2025-09-07,GP2,Race,4,track_limits\n";
    const r = checkUpload(spec("incidents"), csv);
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("2 incidents · 1 serious · 2 seasons · 2 events");
  });

  it("rejects a file with missing columns", () => {
    const r = checkUpload(spec("corners"), "number,label\n1,Hairpin\n");
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/Missing columns: name, distance_m/);
  });

  it("needs a full lap of numeric points for the track", () => {
    const rows = Array.from({ length: 25 }, (_, i) => `${i * 10},${i},${i * 2},200`).join("\n");
    const r = checkUpload(spec("track"), `distance_m,x_m,y_m,speed_kph\n${rows}\n`);
    expect(r.ok).toBe(true);
    expect(r.summary).toContain("25 points");
    expect(r.summary).toContain("speed trace included");
    expect(r.lengthM).toBe(240);
    expect(checkUpload(spec("track"), "x_m,y_m\n1,2\n").ok).toBe(false);
  });
});

describe("sortUploads", () => {
  it("puts each file in the right slot by its columns, then by its name", () => {
    const { matched, unmatched } = sortUploads([
      { name: "a.csv", text: "post,distance_m\n1,100\n" },
      { name: "b.csv", text: "number,name,distance_m\n1,Hairpin,300\n" },
      { name: "my_incident_log.csv", text: "when,where\nx,y\n" },
      { name: "notes.csv", text: "foo\nbar\n" },
    ]);
    expect(matched.marshals?.fileName).toBe("a.csv");
    expect(matched.corners?.fileName).toBe("b.csv");
    expect(matched.incidents?.fileName).toBe("my_incident_log.csv");
    expect(matched.incidents?.result.ok).toBe(false);
    expect(unmatched).toEqual(["notes.csv"]);
  });
});
