"use client";

import { Canvas } from "@react-three/fiber";
import { useCallback, useMemo, useRef, useState } from "react";
import { Vector3 } from "three";
import { ASSET_CATEGORY_LABEL } from "@/lib/assetLabels";
import { buildTrackFrame, outwardSign, unitsPerMetre, WORLD_SCALE, zoneIndexRange } from "@/lib/trackGeometry";
import type { ZoneView } from "@/lib/zoneView";
import type { Asset, AssetMap } from "@/types/assets";
import { CameraRig } from "./CameraRig";
import { CrashEffects } from "./CrashEffects";
import { SceneEnvironment } from "./SceneEnvironment";
import { DRAWN_TRACK_WIDTH_M, VERTICAL_EXAGGERATION, type FlashMap, type SceneData, type SceneTheme } from "./sceneTypes";
import { Structures, type StructureEvents } from "./Structures";
import { Surroundings } from "./Surroundings";
import { Terrain } from "./Terrain";
import { TrackSurface } from "./TrackSurface";
import { Traffic } from "./Traffic";
import { useLabelAnchors, ZoneLabelLayer, ZoneLabelProjector } from "./ZoneLabels";
import { ZoneSafety } from "./ZoneSafety";

export interface TrackSceneProps {
  circuitId: string;
  outline: [number, number][];
  speedKph: number[];
  extentM: number;
  lengthM: number;
  zones: ZoneView[];
  assets: AssetMap | undefined;
  selectedZoneId: string | null;
  onSelectZone: (zoneId: string) => void;
  selectedAssetId: string | null;
  onSelectAsset: (assetId: string) => void;
  riskOverlay: boolean;
  showTraffic: boolean;
  reducedMotion: boolean;
  theme: SceneTheme;
}

/** The 3D digital twin at real scale: track, run-off, barriers, OSM structures, woods and water, live cars. */
export default function TrackScene3D(p: TrackSceneProps) {
  const [hoveredZone, setHoveredZone] = useState<string | null>(null);
  const [hover, setHover] = useState<{ asset: Asset; x: number; y: number } | null>(null);
  const flash = useRef<FlashMap>(new Map());
  const labelNodes = useRef(new Map<string, HTMLDivElement>());

  const frame = useMemo(() => buildTrackFrame(p.outline), [p.outline]);
  const assetList = p.assets?.assets;
  const scene: SceneData = useMemo(() => {
    const n = frame.points.length;
    const u = unitsPerMetre(p.extentM);
    const trackHalf = (DRAWN_TRACK_WIDTH_M / 2) * u;
    // The run-off depth per zone is a placeholder; where a real (OSM) structure stands on the outside of a zone,
    // the barrier is drawn just in front of it instead of through it.
    const nearestOutside = (zoneId: string, side: 1 | -1): number => {
      let best = Infinity;
      for (const a of assetList ?? []) {
        if (a.nearest_zone_id !== zoneId || a.geometry !== "polygon" || a.category === "bridge") continue;
        const i = Math.round(a.nearest_lap_frac * n) % n;
        const pt = frame.points[i]!;
        const nm = frame.normals[i]!;
        const c = a.points.reduce((s, [x, y]) => ({ x: s.x + (x * WORLD_SCALE) / a.points.length, z: s.z - (y * WORLD_SCALE) / a.points.length }), { x: 0, z: 0 });
        if ((c.x - pt.x) * nm.x * side + (c.z - pt.z) * nm.z * side > 0) best = Math.min(best, a.distance_to_track_m);
      }
      return best;
    };
    return {
      frame,
      outline: p.outline,
      speedKph: p.speedKph,
      lengthM: p.lengthM,
      scale: { u, trackHalf, h: (m: number) => m * u * VERTICAL_EXAGGERATION },
      maxPremium: Math.max(0, ...p.zones.map((z) => z.risk?.premium_eur ?? 0)),
      zones: p.zones.map((view) => {
        const range = zoneIndexRange(view.zone.start_frac, view.zone.end_frac, n);
        let apex = range[0];
        for (let i = range[0]; i <= range[1]; i++) if ((p.speedKph[i] ?? 999) < (p.speedKph[apex] ?? 999)) apex = i;
        const side = outwardSign(frame, range[0], range[1]);
        const runoffM = Math.max(3, Math.min(view.zone.runoff_depth_m, nearestOutside(view.zone.zone_id, side) - DRAWN_TRACK_WIDTH_M / 2 - 3));
        return {
          view,
          range,
          apex,
          mid: Math.floor((range[0] + range[1]) / 2),
          side,
          barrierOffset: trackHalf + runoffM * u,
        };
      }),
    };
  }, [frame, p.outline, p.speedKph, p.lengthM, p.extentM, p.zones, assetList]);

  const anchors = useLabelAnchors(scene);
  const focus = useMemo(() => {
    const z = scene.zones.find((q) => q.view.zone.zone_id === p.selectedZoneId);
    if (!z) return null;
    const pt = frame.points[z.mid]!;
    return new Vector3(pt.x, 0, pt.z);
  }, [scene.zones, p.selectedZoneId, frame]);

  const { onSelectAsset } = p;
  const structureEvents: StructureEvents = useMemo(() => ({
    onHover: (asset, x, y) => setHover(asset && x !== undefined && y !== undefined ? { asset, x, y } : null),
    onSelect: (asset) => onSelectAsset(asset.asset_id),
  }), [onSelectAsset]);
  const onZoneHover = useCallback((id: string | null) => setHoveredZone(id), []);

  const cursor = hover || hoveredZone ? "pointer" : "grab";
  const night = p.theme === "night";
  // OSM barrier lines that now fall on the (widened) asphalt would stand in the cars' way; the zone barriers replace them.
  const visibleAssets = useMemo(
    () => p.assets?.assets.filter((a) => a.category !== "barrier" || a.distance_to_track_m > DRAWN_TRACK_WIDTH_M / 2 + 2),
    [p.assets],
  );

  return (
    <div className="absolute inset-0">
      <Canvas
        shadows
        dpr={[1, 2]}
        gl={{ logarithmicDepthBuffer: true, antialias: true }}
        camera={{ fov: 38, near: 0.5, far: 4000, position: [150, 120, 110] }}
        style={{ cursor, touchAction: "none" }}
        aria-label="3D model of the circuit with its structures, coloured by insurance risk"
      >
        <SceneEnvironment theme={p.theme} />
        {p.assets && <Terrain context={p.assets.context} scene={scene} night={night} />}
        {p.assets && <Surroundings context={p.assets.context} scene={scene} night={night} />}
        <TrackSurface scene={scene} context={p.assets?.context} />
        {scene.zones.map((placed) => (
          <ZoneSafety
            key={placed.view.zone.zone_id}
            scene={scene}
            placed={placed}
            selected={placed.view.zone.zone_id === p.selectedZoneId}
            hovered={placed.view.zone.zone_id === hoveredZone}
            night={night}
            riskOverlay={p.riskOverlay}
            flash={flash}
            onSelect={p.onSelectZone}
            onHover={onZoneHover}
          />
        ))}
        {visibleAssets && (
          <Structures
            assets={visibleAssets}
            track={frame.points}
            scale={scene.scale}
            riskOverlay={p.riskOverlay}
            selectedAssetId={p.selectedAssetId}
            hoveredAssetId={hover?.asset.asset_id ?? null}
            events={structureEvents}
          />
        )}
        <Traffic scene={scene} visible={p.showTraffic} night={night} />
        <CrashEffects scene={scene} flash={flash} reducedMotion={p.reducedMotion} night={night} />
        <ZoneLabelProjector anchors={anchors} nodes={labelNodes} />
        <CameraRig focus={focus} resetKey={p.circuitId} reducedMotion={p.reducedMotion} />
      </Canvas>
      {p.riskOverlay && <ZoneLabelLayer scene={scene} nodes={labelNodes} selectedZoneId={p.selectedZoneId} hoveredZoneId={hoveredZone} />}
      {hover && (
        <div
          className="pointer-events-none fixed z-30 -translate-x-1/2 -translate-y-[calc(100%+12px)] whitespace-nowrap rounded-md border border-line bg-bg/90 px-2.5 py-1.5 text-xs backdrop-blur"
          style={{ left: hover.x, top: hover.y }}
        >
          <b className="display block text-[13px] font-semibold">{hover.asset.name ?? ASSET_CATEGORY_LABEL[hover.asset.category]}</b>
          <span className="text-muted">
            {ASSET_CATEGORY_LABEL[hover.asset.category]} · {Math.round(hover.asset.distance_to_track_m)} m from track · exposure {hover.asset.exposure_tier.toLowerCase()}
          </span>
          {hover.asset.position_source === "official_list" && (
            <span className="block text-[11px] text-faint">Corner from the official grandstand list · footprint assumed</span>
          )}
        </div>
      )}
    </div>
  );
}
