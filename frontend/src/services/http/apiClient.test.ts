import { afterEach, describe, expect, it, vi } from "vitest";
import { apiClient, buildUrl } from "./apiClient";
import { ApiError } from "./errors";

afterEach(() => vi.unstubAllGlobals());

describe("buildUrl", () => {
  it("joins base and path and drops empty query values", () => {
    expect(buildUrl("/api/insurance/risk-map", { circuit: "monza", series: "f2", upgrades: undefined, x: "" }, "http://api:8000")).toBe(
      "http://api:8000/api/insurance/risk-map?circuit=monza&series=f2",
    );
  });
  it("encodes JSON query values", () => {
    const url = new URL(buildUrl("/x", { upgrades: '{"z":{"fence_height_m":5}}' }, "http://api"));
    expect(url.searchParams.get("upgrades")).toBe('{"z":{"fence_height_m":5}}');
  });
});

describe("apiClient", () => {
  it("returns parsed JSON on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify([{ id: "monza" }]), { status: 200 })));
    await expect(apiClient.get("/api/insurance/circuits")).resolves.toEqual([{ id: "monza" }]);
  });

  it("maps the backend error envelope to ApiError", async () => {
    const body = { error: { code: "UNKNOWN_CIRCUIT", message: "No circuit called imola" } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 404 })));
    const err = await apiClient.get("/api/insurance/tracks/imola").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 404, code: "UNKNOWN_CIRCUIT", message: "No circuit called imola", isClientError: true });
  });

  it("reports network failures with status 0", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const err = await apiClient.get("/api/health").catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 0, code: "NETWORK_ERROR", isNetwork: true });
  });

  it("sends JSON bodies on POST", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await apiClient.post("/api/insurance/what-if", { zone_id: "z" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"zone_id":"z"}');
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });
});
