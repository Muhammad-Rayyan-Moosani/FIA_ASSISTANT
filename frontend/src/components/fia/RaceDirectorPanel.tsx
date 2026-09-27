"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/Panel";
import { cn } from "@/lib/cn";
import type { PlainAlert } from "@/types/fia";
import { FlagChip, LEVEL_BORDER } from "./badges";

const TINT: Record<PlainAlert["level"], string> = {
  ALERT: "bg-[linear-gradient(90deg,color-mix(in_srgb,var(--color-risk-crit)_16%,transparent),transparent_70%)]",
  WATCH: "bg-[linear-gradient(90deg,color-mix(in_srgb,var(--color-risk-med)_14%,transparent),transparent_70%)]",
  NONE: "",
};

/** The one message race control needs right now, in plain words, with an optional voice read-out. */
export function RaceDirectorPanel({ message }: { message: PlainAlert | null }) {
  const [voice, setVoice] = useState(false);
  const spoken = useRef<PlainAlert | null>(null);

  useEffect(() => {
    if (!voice || !message || message === spoken.current || message.level !== "ALERT") return;
    spoken.current = message;
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(message.say));
  }, [message, voice]);

  return (
    <Panel
      title="Race director"
      actions={
        <Button size="sm" variant="ghost" onClick={() => setVoice((v) => !v)} aria-pressed={voice} title="Read ALERTs aloud">
          {voice ? "🔊 Voice on" : "🔇 Voice off"}
        </Button>
      }
    >
      {message ? (
        <div className={cn("rounded-lg border border-line border-l-4 px-3.5 py-3 animate-fade-in", LEVEL_BORDER[message.level], TINT[message.level])} aria-live="assertive">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
            {message.level === "NONE" ? "Clear" : message.level} · suggested flag <FlagChip flag={message.flag} />
          </div>
          <div className="display mt-1.5 text-[24px] font-bold uppercase leading-tight tracking-[0.02em]">{message.headline}</div>
          <p className="mt-1 text-[13.5px]">{message.why}</p>
          <p className="mt-2 text-[14px] font-semibold">→ {message.action}</p>
          <p className="mt-2 text-[11.5px] text-faint">{message.note}</p>
        </div>
      ) : (
        <p className="text-[13px] text-muted">No active hazard. Plain-language suggestions appear here the moment the feed raises one. Race control decides.</p>
      )}
    </Panel>
  );
}
