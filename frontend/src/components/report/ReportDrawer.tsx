"use client";

import { useState } from "react";
import { IconClose, IconCopy, IconDownload } from "@/assets/icons";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { Skeleton } from "@/components/ui/Skeleton";
import { SourceBadge } from "@/components/ui/SourceBadge";
import { StateMessage } from "@/components/ui/StateMessage";
import { useReport, useReportPdf } from "@/hooks/insurance/useReport";
import { formatEur } from "@/lib/format";
import { SERIES_LABEL } from "@/lib/labels";
import { riskHex } from "@/lib/riskColor";
import { describeError } from "@/services/http/errors";
import type { SourceInfo, Series } from "@/types/api";
import type { Recommendation, UpgradeSet } from "@/types/risk";
import type { TrackGeometry } from "@/types/track";

interface ReportDrawerProps {
  open: boolean;
  onClose: () => void;
  circuitId: string | null;
  series: Series;
  upgrades: UpgradeSet;
  track: TrackGeometry | undefined;
  source: SourceInfo | undefined;
}

export function ReportDrawer({ open, onClose, circuitId, series, upgrades, track, source }: ReportDrawerProps) {
  const report = useReport(circuitId, series, upgrades, open);
  const pdf = useReportPdf();
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const names = new Map(track?.zones.map((z) => [z.zone_id, z.name]) ?? []);
  const zoneName = (id: string) => names.get(id) ?? id;
  const r = report.data;

  const copy = async () => {
    if (!r) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(r, null, 2));
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
    setTimeout(() => setCopied("idle"), 2000);
  };

  return (
    <Drawer open={open} onClose={onClose} label="Underwriter report">
      <div className="flex items-center justify-between gap-3">
        <span className="eyebrow flex items-center">
          Underwriter assessment · {SERIES_LABEL[series]}
          <SourceBadge source={source} />
        </span>
        <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close report">
          <IconClose />
        </Button>
      </div>
      <h2 className="display text-[32px] font-semibold leading-[1.05]">{track?.name ?? "Report"}</h2>

      {report.isPending && (
        <div className="grid gap-3" aria-busy="true">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}
      {report.error && (
        <StateMessage tone="error" title="Couldn't generate the report" action={<Button size="sm" onClick={() => report.refetch()}>Try again</Button>}>
          {describeError(report.error)}
        </StateMessage>
      )}

      {r && (
        <>
          <div className="grid gap-2">
            <p className="max-w-[64ch] text-[14.5px] leading-relaxed">{r.executive_summary}</p>
            <p className="text-[11.5px] text-faint">
              {r.narrative_source === "llm" ? `Written by ${r.model ?? "Claude"} from the model's numbers; every figure is checked against the model output.` : "Template narrative (LLM unavailable)."}
            </p>
          </div>

          <section className="grid gap-2">
            <h3 className="eyebrow">Zone pricing</h3>
            <div className="overflow-x-auto rounded-xl border border-line">
              <table className="w-full border-collapse text-[12.5px]">
                <thead>
                  <tr className="text-[11.5px] text-muted">
                    {["Zone", "Score", "EAL", "VaR99", "Premium", "Limit"].map((h, i) => (
                      <th key={h} className={`border-b border-line-soft px-2.5 py-2 font-medium ${i ? "text-right" : "text-left"}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="num">
                  {[...r.zones].sort((a, b) => b.premium_eur - a.premium_eur).map((z) => (
                    <tr key={z.zone_id}>
                      <td className="whitespace-nowrap border-b border-line-soft px-2.5 py-2 text-left font-sans">
                        <span className="mr-1.5 inline-block size-2 rounded-full align-[1px]" style={{ background: riskHex(z.risk_score) }} />
                        {zoneName(z.zone_id)}
                      </td>
                      <td className="border-b border-line-soft px-2.5 py-2 text-right">{z.risk_score}</td>
                      <td className="border-b border-line-soft px-2.5 py-2 text-right">{formatEur(z.eal_eur)}</td>
                      <td className="border-b border-line-soft px-2.5 py-2 text-right">{formatEur(z.var99_eur)}</td>
                      <td className="border-b border-line-soft px-2.5 py-2 text-right">{formatEur(z.premium_eur)}</td>
                      <td className="border-b border-line-soft px-2.5 py-2 text-right">{formatEur(z.recommended_limit_eur)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td className="px-2.5 py-2 text-left font-sans font-semibold">Circuit total</td>
                    <td />
                    <td className="px-2.5 py-2 text-right">{formatEur(r.totals.eal_eur)}</td>
                    <td className="px-2.5 py-2 text-right">{formatEur(r.totals.var99_eur)}</td>
                    <td className="px-2.5 py-2 text-right">{formatEur(r.totals.segmented_premium_eur)}</td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          {r.risk_concentrations.length > 0 && (
            <section className="grid gap-2">
              <h3 className="eyebrow">Where the risk sits</h3>
              <ul className="grid gap-2 pl-4 text-[13.5px]">
                {r.risk_concentrations.map((f) => (
                  <li key={f.zone_id} className="list-disc">
                    <b>{zoneName(f.zone_id)}</b> ({f.share_of_loss_pct.toFixed(0)}% of expected loss): {f.headline}
                    {f.drivers.length > 0 && <span className="text-muted"> Drivers: {f.drivers.join(", ")}.</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <RecommendationList title="Safety upgrades worth pricing" items={r.safety_recommendations} zoneName={zoneName} />
          <RecommendationList title="Premium and cover changes" items={r.premium_recommendations} zoneName={zoneName} />

          {r.caveats.length > 0 && (
            <section className="grid gap-2">
              <h3 className="eyebrow">Caveats</h3>
              <ul className="grid gap-1.5 pl-4 text-[13px] text-muted">
                {r.caveats.map((c) => (
                  <li key={c} className="list-disc">{c}</li>
                ))}
              </ul>
            </section>
          )}

          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => circuitId && pdf.mutate({ circuit: circuitId, series, upgrades })} disabled={pdf.isPending}>
              <IconDownload /> {pdf.isPending ? "Preparing PDF…" : "Download PDF"}
            </Button>
            <Button onClick={copy}>
              <IconCopy /> {copied === "copied" ? "Copied" : copied === "failed" ? "Copy blocked" : "Copy JSON"}
            </Button>
          </div>
          {pdf.error && <p className="text-[12.5px] text-risk-crit">{describeError(pdf.error)}</p>}
        </>
      )}
    </Drawer>
  );
}

function RecommendationList({ title, items, zoneName }: { title: string; items: Recommendation[]; zoneName: (id: string) => string }) {
  if (items.length === 0) return null;
  return (
    <section className="grid gap-2">
      <h3 className="eyebrow">{title}</h3>
      <ul className="grid gap-2 pl-4 text-[13.5px]">
        {items.map((x) => (
          <li key={`${x.zone_id}-${x.action}`} className="list-disc">
            <b>{zoneName(x.zone_id)}:</b> {x.action}. <span className="text-muted">{x.rationale}</span>
            {x.est_saving_eur !== null && <span className="num block text-xs text-muted">saves {formatEur(x.est_saving_eur)} per weekend</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
