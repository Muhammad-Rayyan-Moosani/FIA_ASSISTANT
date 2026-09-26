"use client";

import { OrbitControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef, type ComponentRef } from "react";
import { Vector3 } from "three";

/** Camera distance when flying to a selected zone: close enough to see barriers, run-off and grandstands. */
const FOCUS_DISTANCE = 62;

interface CameraRigProps {
  /** World-space point to ease towards (the selected zone), or null to stay put. */
  focus: Vector3 | null;
  /** Changes when the circuit changes; resets the camera. */
  resetKey: string;
  reducedMotion: boolean;
}

/** Orbit camera: slow auto-rotation until the user takes over, and a smooth fly-in to the selected zone. */
export function CameraRig({ focus, resetKey, reducedMotion }: CameraRigProps) {
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const goal = useRef<Vector3 | null>(null);

  useEffect(() => {
    const r = size.width < size.height ? 270 : 195;
    const theta = 0.6;
    const phi = 0.9;
    camera.position.set(r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta));
    controls.current?.target.set(0, 0, 0);
    controls.current?.update();
    goal.current = null;
    // Size is read once per circuit on purpose; resizing shouldn't reset the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey, camera]);

  useEffect(() => {
    goal.current = focus ? focus.clone() : null;
  }, [focus]);

  useFrame(() => {
    const c = controls.current;
    if (!c || !goal.current) return;
    const k = reducedMotion ? 1 : 0.06;
    const offset = camera.position.clone().sub(c.target);
    const dist = offset.length();
    c.target.lerp(goal.current, k);
    offset.setLength(dist + (FOCUS_DISTANCE - dist) * k);
    camera.position.copy(c.target).add(offset);
    if (c.target.distanceTo(goal.current) < 0.05 && Math.abs(dist - FOCUS_DISTANCE) < 0.5) goal.current = null;
    c.update();
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      dampingFactor={0.08}
      autoRotate={!reducedMotion}
      autoRotateSpeed={0.35}
      minDistance={8}
      maxDistance={320}
      minPolarAngle={0.28}
      maxPolarAngle={1.38}
      onStart={() => {
        goal.current = null;
        if (controls.current) controls.current.autoRotate = false;
      }}
    />
  );
}
