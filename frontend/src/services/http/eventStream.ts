import { buildUrl, type QueryParams } from "./apiClient";
import { ApiError } from "./errors";

/** A stream event: the SSE `event:` name becomes `type`, the JSON `data:` becomes the other fields. */
export interface StreamEvent {
  type: string;
}

export interface StreamOptions<E extends StreamEvent> {
  query?: QueryParams;
  /** Every SSE event name the server may send. */
  eventTypes: readonly E["type"][];
  /** Events after which the server is finished; the stream closes itself. */
  terminal: readonly E["type"][];
}

export interface StreamHandlers<E extends StreamEvent> {
  onEvent: (event: E) => void;
  onError?: (error: ApiError) => void;
  onOpen?: () => void;
}

export interface StreamSubscription {
  close: () => void;
}

/** Parse one SSE message into a typed event. Throws ApiError on malformed JSON. */
export function parseStreamMessage<E extends StreamEvent>(type: E["type"], raw: string): E {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw ApiError.client("INVALID_RESPONSE", `Stream event "${type}" had invalid JSON`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw ApiError.client("INVALID_RESPONSE", `Stream event "${type}" must be a JSON object`);
  }
  return { ...(data as object), type } as E;
}

/**
 * Open a finite Server-Sent Events stream.
 *
 * Browsers reconnect EventSource automatically, which would restart a finished job from scratch,
 * so any transport error closes the stream and is reported once through onError.
 */
export function openEventStream<E extends StreamEvent>(
  path: string,
  options: StreamOptions<E>,
  handlers: StreamHandlers<E>,
): StreamSubscription {
  const source = new EventSource(buildUrl(path, options.query));
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    source.close();
  };

  source.onopen = () => handlers.onOpen?.();
  source.onerror = () => {
    if (closed) return;
    close();
    handlers.onError?.(ApiError.client("STREAM_ERROR", `The stream from ${path} was interrupted`));
  };

  for (const type of options.eventTypes) {
    source.addEventListener(type, (message) => {
      if (closed) return;
      try {
        handlers.onEvent(parseStreamMessage<E>(type, (message as MessageEvent<string>).data));
      } catch (err) {
        close();
        handlers.onError?.(err instanceof ApiError ? err : ApiError.client("STREAM_ERROR", String(err)));
        return;
      }
      if (options.terminal.includes(type)) close();
    });
  }

  return { close };
}
