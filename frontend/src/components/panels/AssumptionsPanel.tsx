import { Panel } from "@/components/ui/Panel";
import { ProvenancePill } from "@/components/ui/SourceBadge";
import type { Assumption } from "@/types/risk";

export function AssumptionsPanel({ assumptions, modelVersion }: { assumptions: Assumption[] | undefined; modelVersion: string | undefined }) {
  if (!assumptions || assumptions.length === 0) return null;
  return (
    <Panel>
      <details>
        <summary className="cursor-pointer text-[12.5px] text-muted">
          Model assumptions{modelVersion && <span className="text-faint"> · {modelVersion}</span>}
        </summary>
        <dl className="mt-3 grid gap-2.5">
          {assumptions.map((a) => (
            <div key={a.key} className="grid gap-0.5">
              <dt className="flex items-center gap-2 text-xs text-muted">
                {a.label}
                <ProvenancePill provenance={a.provenance} />
              </dt>
              <dd className="text-[13px]">{a.value}</dd>
            </div>
          ))}
        </dl>
      </details>
    </Panel>
  );
}
