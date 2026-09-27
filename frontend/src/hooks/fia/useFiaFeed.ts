"use client";

import { useEffect, useReducer, useState } from "react";
import { feedReducer, initialFeedState } from "@/lib/fiaFeed";
import { fiaService } from "@/services/fia.service";
import type { FeedMessage } from "@/types/fia";

export type FeedConnection = "connecting" | "live" | "offline";

const RETRY_MS = 1_500;

/** Follows the FIA service's /ws/alerts stream (hazards, crashes, car positions) and reconnects if it drops. */
export function useFiaFeed() {
  const [state, dispatch] = useReducer(feedReducer, initialFeedState);
  const [connection, setConnection] = useState<FeedConnection>("connecting");

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const connect = () => {
      socket = new WebSocket(fiaService.alertsUrl());
      socket.onopen = () => setConnection("live");
      socket.onmessage = (event: MessageEvent<string>) => {
        try {
          dispatch(JSON.parse(event.data) as FeedMessage);
        } catch {
          // ignore malformed frames
        }
      };
      socket.onclose = () => {
        if (closed) return;
        setConnection("offline");
        retry = setTimeout(connect, RETRY_MS);
      };
    };
    connect();

    return () => {
      closed = true;
      clearTimeout(retry);
      socket?.close();
    };
  }, []);

  return { state, connection };
}
