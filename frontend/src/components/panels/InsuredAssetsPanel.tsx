import { Panel } from "@/components/ui/Panel";
import { PanelSkeleton } from "@/components/ui/Skeleton";
import { SourceBadge } from "@/components/ui/SourceBadge";
import { ASSET_CATEGORY_LABEL, COVERAGE_SHORT } from "@/lib/assetLabels";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import { riskHex, riskRgba } from "@/lib/riskColor";
import type { Asset, AssetMap } from "@/types/assets";

const NEARBY_M = 200;
const NEARBY_LIMIT = 8;

interface InsuredAssetsPanelProps {
  assets: AssetMap | undefined;
  selectedZoneId: string | null;
  zoneName: string | undefined;
  selectedAssetId: string | null;
  onSelectAsset: (assetId: string | null) => void;
}

function ExposurePill({ asset }: { asset: Asset }) {
  return (
    <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide" style={{ background: riskRgba(asset.exposure_score, 0.16), color: riskHex(asset.exposure_score) }}>
      {asset.exposure_tier}
    </span>
  );
}

/** What the circuit's insurance programme covers, built from the real structures around the track. */
export function InsuredAssetsPanel({ assets, selectedZoneId, zoneName, selectedAssetId, onSelectAsset }: InsuredAssetsPanelProps) {
  if (!assets) return <PanelSkeleton rows={5} />;
  const s = assets.sources;
  const selected = assets.assets.find((a) => a.asset_id === selectedAssetId);
  const nearby = assets.assets
    .filter((a) => a.nearest_zone_id === selectedZoneId && a.distance_to_track_m <= NEARBY_M && a.category !== "barrier")
    .sort((a, b) => b.exposure_score - a.exposure_score || a.distance_to_track_m - b.distance_to_track_m)
    .slice(0, NEARBY_LIMIT);

  return (
    <Panel title="What insurance covers" source={s.structures} description={`${formatNumber(assets.assets.length)} real structures around the track, grouped by the insurance line that covers them.`}>
      <ul className="grid gap-2">
        {assets.coverage.map((c) => (
          <li key={c.line} className="grid grid-cols-[1fr_auto] items-baseline gap-x-3 gap-y-0.5 rounded-lg border border-line-soft bg-bg px-3 py-2">
            <span className="text-[13px] font-medium">{c.label}</span>
            <span className="num text-[13px]">
              {formatNumber(c.count)}
              {c.high_exposure > 0 && <span className="ml-2 text-[11px] text-risk-crit">{c.high_exposure} high</span>}
            </span>
            <span className="col-span-2 text-[11.5px] leading-snug text-muted">{c.description}</span>
          </li>
        ))}
      </ul>
      <p className="-mt-1 text-[11px] text-faint">
        Coverage mapping<SourceBadge source={s.coverage} /> · exposure<SourceBadge source={s.exposure} /> · participant accident includes {assets.marshal_posts} marshal posts
      </p>

      {selected && (
        <div className="grid gap-1.5 rounded-xl border border-accent/50 bg-bg p-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <b className="display text-lg font-semibold leading-tight">{selected.name ?? ASSET_CATEGORY_LABEL[selected.category]}</b>
              <div className="text-xs text-muted">{ASSET_CATEGORY_LABEL[selected.category]} · OSM {selected.osm_tag}</div>
            </div>
            <ExposurePill asset={selected} />
          </div>
          <div className="flex flex-wrap gap-1">
            {selected.coverage.map((c) => (
              <span key={c} className="rounded-full border border-line px-2 py-0.5 text-[11px] text-muted">{COVERAGE_SHORT[c]}</span>
            ))}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12.5px]">
            <dt className="text-muted">From the track</dt><dd className="num">{formatNumber(selected.distance_to_track_m)} m</dd>
            <dt className="text-muted">Height</dt>
            <dd className="num">{formatNumber(selected.height_m, 1)} m <span className="font-sans text-[11px] text-faint">{selected.height_source === "assumed" ? "(assumed by type)" : "(OpenStreetMap)"}</span></dd>
            <dt className="text-muted">Faces zone</dt><dd>{selected.nearest_zone_id === selectedZoneId ? zoneName : selected.nearest_zone_id}</dd>
            <dt className="text-muted">Exposure score</dt><dd className="num">{selected.exposure_score}</dd>
          </dl>
          <button type="button" onClick={() => onSelectAsset(null)} className="justify-self-start text-xs text-accent hover:underline">Clear selection</button>
        </div>
      )}

      <div className="grid gap-1.5">
        <p className="text-[12px] text-muted">Structures facing {zoneName ?? "the selected zone"}</p>
        {nearby.length === 0 && <p className="text-[12px] text-faint">No mapped structures within {NEARBY_M} m of this zone.</p>}
        {nearby.map((a) => (
          <button
            key={a.asset_id}
            type="button"
            onClick={() => onSelectAsset(a.asset_id)}
            className={cn(
              "grid grid-cols-[1fr_auto_auto] items-center gap-2 rounded-md px-2 py-1 text-left text-[12.5px] hover:bg-panel-2",
              a.asset_id === selectedAssetId && "bg-panel-2",
            )}
          >
            <span className="truncate">{a.name ?? ASSET_CATEGORY_LABEL[a.category]}<span className="text-faint"> · {ASSET_CATEGORY_LABEL[a.category].toLowerCase()}</span></span>
            <span className="num text-[11.5px] text-muted">{formatNumber(a.distance_to_track_m)} m</span>
            <ExposurePill asset={a} />
          </button>
        ))}
      </div>
    </Panel>
  );
}
