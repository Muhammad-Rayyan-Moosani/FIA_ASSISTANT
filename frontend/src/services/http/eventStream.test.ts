import { afterEach, describe, expect, it, vi } from "vitest";
import { openEventStream, parseStreamMessage } from "./eventStream";

type TestEvent = { type: "progress"; done: number } | { type: "done"; total: number };

/** Minimal EventSource stand-in that lets a test push named events. */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  readonly url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, ((m: { data: string }) => void)[]>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.last = this;
  }
  addEventListener(type: string, fn: (m: { data: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data: typeof data === "string" ? data : JSON.stringify(data) });
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("parseStreamMessage", () => {
  it("merges the event name into the payload", () => {
    expect(parseStreamMessage<TestEvent>("progress", '{"done":3}')).toEqual({ type: "progress", done: 3 });
  });
  it("rejects malformed JSON", () => {
    expect(() => parseStreamMessage<TestEvent>("progress", "{nope")).toThrow(/invalid JSON/);
  });
});

describe("openEventStream", () => {
  it("delivers typed events and closes after a terminal event", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const onEvent = vi.fn();
    openEventStream<TestEvent>("/stream", { eventTypes: ["progress", "done"], terminal: ["done"], query: { job: "j1" } }, { onEvent });
    const es = FakeEventSource.last!;
    expect(es.url).toContain("/stream?job=j1");
    es.emit("progress", { done: 1 });
    es.emit("done", { total: 1 });
    es.emit("progress", { done: 2 });
    expect(onEvent.mock.calls.map((c) => c[0])).toEqual([
      { type: "progress", done: 1 },
      { type: "done", total: 1 },
    ]);
    expect(es.closed).toBe(true);
  });

  it("closes and reports once on a transport error instead of reconnecting", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const onError = vi.fn();
    openEventStream<TestEvent>("/stream", { eventTypes: ["progress"], terminal: [] }, { onEvent: vi.fn(), onError });
    const es = FakeEventSource.last!;
    es.onerror?.();
    es.onerror?.();
    expect(es.closed).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toMatchObject({ code: "STREAM_ERROR" });
  });
});
