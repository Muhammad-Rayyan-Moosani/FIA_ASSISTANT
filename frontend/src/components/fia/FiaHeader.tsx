"use client";

import { IconPlay, IconRefresh } from "@/assets/icons";
import { PageTabs } from "@/components/layout/PageTabs";
import { Button } from "@/components/ui/Button";
import { SegmentedControl, type SegmentOption } from "@/components/ui/SegmentedControl";
import type { FeedConnection } from "@/hooks/fia/useFiaFeed";
import { cn } from "@/lib/cn";

export type PlaybackSpeed = "0.5" | "1" | "3";

const SPEEDS: readonly SegmentOption<PlaybackSpeed>[] = [
  { value: "0.5", label: "0.5×", title: "Half speed" },
  { value: "1", label: "1×", title: "Real time (10 Hz telemetry)" },
  { value: "3", label: "3×", title: "Three times faster" },
];

const CONNECTION: Record<FeedConnection, { label: string; dot: string }> = {
  connecting: { label: "Connecting…", dot: "bg-risk-med" },
  live: { label: "Live · /ws/alerts", dot: "bg-risk-low shadow-[0_0_6px_var(--color-risk-low)]" },
  offline: { label: "Offline — retrying", dot: "bg-risk-crit" },
};

interface FiaHeaderProps {
  connection: FeedConnection;
  speed: PlaybackSpeed;
  onSpeed: (s: PlaybackSpeed) => void;
  onRun: () => void;
  onCrash: () => void;
  onReset: () => void;
  busy: boolean;
  disabled: boolean;
}

export function FiaHeader(p: FiaHeaderProps) {
  const conn = CONNECTION[p.connection];
  return (
    <header className="flex flex-wrap items-center gap-x-5 gap-y-3 border-b border-line bg-panel px-4 py-3 lg:px-5">
      <PageTabs active="fia" />
      <div className="mr-auto flex min-w-0 flex-col max-lg:w-full">
        <span className="display text-[22px] font-bold uppercase leading-none tracking-[0.06em]">FIA</span>
        <span className="text-xs text-muted">Race control assistant · μMap grip alerts · camera checks · Sporting Regulations</span>
      </div>
      <nav className="flex flex-wrap items-center gap-2.5" aria-label="Race control">
        <span className="inline-flex items-center gap-2 text-xs text-muted" role="status">
          <span className={cn("size-2 rounded-full", conn.dot)} aria-hidden="true" />
          {conn.label}
        </span>
        <Button onClick={p.onReset} disabled={p.disabled} title="Clear the μMap state and alert feed">
          <IconRefresh size={14} /> Reset
        </Button>
        <SegmentedControl label="Playback speed" options={SPEEDS} value={p.speed} onChange={p.onSpeed} />
        <Button variant="primary" onClick={p.onRun} disabled={p.disabled || p.busy}>
          <IconPlay size={14} /> Run trajectory
        </Button>
        <Button onClick={p.onCrash} disabled={p.disabled} title="Simulated impact in the OpenF1 impact-detector format">
          Simulate crash
        </Button>
      </nav>
    </header>
  );
}
