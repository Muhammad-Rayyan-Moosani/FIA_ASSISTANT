"use client";

import { useSyncExternalStore } from "react";

let cached: boolean | null = null;

function detect(): boolean {
  if (cached !== null) return cached;
  try {
    const canvas = document.createElement("canvas");
    cached = Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    cached = false;
  }
  return cached;
}

/** true / false on the client; null during server render. */
export function useWebGLSupport(): boolean | null {
  return useSyncExternalStore(
    () => () => {},
    detect,
    () => null,
  );
}
