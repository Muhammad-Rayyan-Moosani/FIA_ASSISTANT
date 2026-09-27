"use client";

import { useState } from "react";
import { AlertFeed } from "@/components/fia/AlertFeed";
import { CarStrip } from "@/components/fia/CarStrip";
import { FiaHeader, type PlaybackSpeed } from "@/components/fia/FiaHeader";
import { MapLegend, RaceControlMap } from "@/components/fia/RaceControlMap";
import { RaceDirectorPanel } from "@/components/fia/RaceDirectorPanel";
import { RadioPanel } from "@/components/fia/RadioPanel";
import { RulebookPanel } from "@/components/fia/RulebookPanel";
import { VisionPanel } from "@/components/fia/VisionPanel";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { StateMessage } from "@/components/ui/StateMessage";
import { useCameraCheck, useFiaScenario, useRaceControlActions, useRuleSearch, useSampleRadio } from "@/hooks/fia/useFiaActions";
import { useFiaFeed } from "@/hooks/fia/useFiaFeed";
import { describeFiaError } from "@/services/fia.service";

const errorText = (e: unknown) => (e ? describeFiaError(e) : null);

/** FIA page: μMap race control (live map, race director, alert feed), camera check, rulebook and radio. */
export function FiaWorkspace() {
  const scenario = useFiaScenario();
  const { state, connection } = useFiaFeed();
  const actions = useRaceControlActions();
  const camera = useCameraCheck();
  const rules = useRuleSearch();
  const radio = useSampleRadio();
  const [speed, setSpeed] = useState<PlaybackSpeed>("1");
  const [visionMs, setVisionMs] = useState<number | null>(null);

  const runCamera = () => {
    const t0 = performance.now();
    camera.mutate(undefined, { onSuccess: () => setVisionMs(performance.now() - t0) });
  };

  return (
    <div className="grid h-full grid-rows-[auto_1fr] max-lg:h-auto">
      <FiaHeader
        connection={connection}
        speed={speed}
        onSpeed={setSpeed}
        onRun={() => actions.run.mutate(Number(speed))}
        onCrash={() => actions.crash.mutate()}
        onReset={() => actions.reset.mutate()}
        busy={actions.run.isPending}
        disabled={!scenario.data}
      />

      {scenario.error ? (
        <main className="grid min-h-full place-items-center p-6">
          <StateMessage tone="error" title="Can't connect to the FIA service" action={<Button onClick={() => scenario.refetch()}>Try again</Button>}>
            {describeFiaError(scenario.error)}
          </StateMessage>
        </main>
      ) : (
        <main className="grid min-h-0 grid-cols-[minmax(0,1fr)_400px] max-lg:grid-cols-1">
          <section className="grid min-h-0 content-start gap-4 overflow-y-auto p-4 scrollbar-thin lg:p-5 max-lg:overflow-visible" aria-label="Race control">
            <div className="grid gap-3 rounded-xl border border-line bg-panel p-4">
              <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h2 className="eyebrow">
                  <span className="normal-case">μ</span>Map · live grip map
                </h2>
                <span className="text-xs text-faint">{scenario.data ? `${scenario.data.track} · synthetic telemetry` : "Loading scenario…"}</span>
              </header>
              {scenario.data ? <RaceControlMap scenario={scenario.data} feed={state} /> : <Skeleton className="aspect-[2.8/1] w-full" />}
              <MapLegend />
              <CarStrip cars={state.cars} threshold={scenario.data?.residual_threshold ?? 0.75} />
              <p className="border-l-2 border-accent pl-3 text-[13px] text-muted" aria-live="polite">
                {errorText(actions.error) ?? state.narration ?? "Press Run trajectory: three cars brake for Turn 1 and two of them hit an oil slick."}
              </p>
            </div>
            <VisionPanel result={camera.data} isPending={camera.isPending} error={errorText(camera.error)} onRun={runCamera} elapsedMs={visionMs} />
          </section>

          <aside className="min-h-0 overflow-y-auto border-l border-line bg-panel scrollbar-thin max-lg:overflow-visible max-lg:border-l-0 max-lg:border-t" aria-label="Race director and stewards">
            <RaceDirectorPanel message={state.director} />
            <AlertFeed entries={state.feed} />
            <RulebookPanel
              documents={scenario.data?.rulebook ?? []}
              samples={scenario.data?.sample_queries ?? []}
              citations={rules.data?.citations}
              isPending={rules.isPending}
              error={errorText(rules.error)}
              onSearch={(q) => rules.mutate(q)}
            />
            <RadioPanel result={radio.data} isPending={radio.isPending} error={errorText(radio.error)} onRun={() => radio.mutate()} />
          </aside>
        </main>
      )}
    </div>
  );
}
