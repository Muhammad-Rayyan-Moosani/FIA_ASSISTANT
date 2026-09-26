"use client";

import { Canvas } from "@react-three/fiber";
import { useMemo, useRef, useState } from "react";
import { Vector3 } from "three";
import { buildTrackFrame, outwardSign, zoneIndexRange } from "@/lib/trackGeometry";
import type { ZoneView } from "@/lib/zoneView";
import { CameraRig } from "./CameraRig";
import { MapEffectsLayer } from "./MapEffectsLayer";
import { SCENE_BG, type FlashMap, type SceneData } from "./sceneTypes";
import { TrackRibbon } from "./TrackRibbon";
import { useLabelAnchors, ZoneLabelLayer, ZoneLabelProjector } from "./ZoneLabels";
import { ZoneVisual } from "./ZoneVisual";

export interface TrackSceneProps {
  circuitId: string;
  outline: [number, number][];
  zones: ZoneView[];
  selectedZoneId: string | null;
  onSelectZone: (zoneId: string) => void;
  reducedMotion: boolean;
}

/** The 3D digital twin. Loaded client-side only (see InsuranceMap). */
export default function TrackScene3D({ circuitId, outline, zones, selectedZoneId, onSelectZone, reducedMotion }: TrackSceneProps) {
  const [hovered, setHovered] = useState<string | null>(null);
  const flash = useRef<FlashMap>(new Map());

  const frame = useMemo(() => buildTrackFrame(outline), [outline]);
  const scene: SceneData = useMemo(() => {
    const n = frame.points.length;
    return {
      frame,
      outline,
      maxPremium: Math.max(0, ...zones.map((z) => z.risk?.premium_eur ?? 0)),
      zones: zones.map((view) => {
        const range = zoneIndexRange(view.zone.start_frac, view.zone.end_frac, n);
        return { view, range, mid: Math.floor((range[0] + range[1]) / 2), side: outwardSign(frame, range[0], range[1]) };
      }),
    };
  }, [frame, outline, zones]);

  const labelNodes = useRef(new Map<string, HTMLDivElement>());
  const anchors = useLabelAnchors(scene);

  const focus = useMemo(() => {
    const z = scene.zones.find((p) => p.view.zone.zone_id === selectedZoneId);
    if (!z) return null;
    const p = frame.points[z.mid]!;
    return new Vector3(p.x, 0, p.z);
  }, [scene.zones, selectedZoneId, frame]);

  return (
    <div className="absolute inset-0">
      <Canvas
        dpr={[1, 2]}
        camera={{ fov: 38, near: 0.5, far: 900, position: [150, 120, 110] }}
        style={{ cursor: hovered ? "pointer" : "grab", touchAction: "none" }}
        aria-label="3D model of the circuit coloured by insurance risk"
      >
        <color attach="background" args={[SCENE_BG]} />
        <fog attach="fog" args={[SCENE_BG, 220, 420]} />
        <hemisphereLight args={["#c6dcff", SCENE_BG, 1.1]} />
        <directionalLight position={[60, 120, 40]} intensity={1.2} />

        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} raycast={() => null}>
          <circleGeometry args={[260, 64]} />
          <meshStandardMaterial color="#0e151c" roughness={1} />
        </mesh>
        <gridHelper args={[360, 72, "#1a2530", "#141d26"]} position={[0, -0.01, 0]} />

        <TrackRibbon frame={frame} />
        {scene.zones.map((placed) => (
          <ZoneVisual
            key={placed.view.zone.zone_id}
            frame={frame}
            placed={placed}
            maxPremium={scene.maxPremium}
            selected={placed.view.zone.zone_id === selectedZoneId}
            flash={flash}
            reducedMotion={reducedMotion}
            onSelect={onSelectZone}
            onHover={setHovered}
          />
        ))}
        <MapEffectsLayer scene={scene} flash={flash} reducedMotion={reducedMotion} />
        <ZoneLabelProjector anchors={anchors} nodes={labelNodes} />
        <CameraRig focus={focus} resetKey={circuitId} reducedMotion={reducedMotion} />
      </Canvas>
      <ZoneLabelLayer scene={scene} nodes={labelNodes} selectedZoneId={selectedZoneId} hoveredZoneId={hovered} />
    </div>
  );
}
