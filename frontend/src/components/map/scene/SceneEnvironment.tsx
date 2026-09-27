"use client";

import { Sky, Stars } from "@react-three/drei";
import { SKY_FOG, type SceneTheme } from "./sceneTypes";

const NIGHT_SKY = "#050913";
const NIGHT_FOG = "#0a1122";

const SHADOW = {
  "shadow-mapSize": [2048, 2048] as [number, number],
  "shadow-bias": -0.0004,
  "shadow-normalBias": 0.04,
  "shadow-camera-left": -110,
  "shadow-camera-right": 110,
  "shadow-camera-top": 110,
  "shadow-camera-bottom": -110,
  "shadow-camera-near": 10,
  "shadow-camera-far": 460,
};

/**
 * Day: physical sky, warm sun with soft shadows, sky/ground bounce light, haze.
 * Night: deep blue sky with stars, cool moonlight, dark haze; the risk lights, street lamps, windows and cars glow.
 */
export function SceneEnvironment({ theme }: { theme: SceneTheme }) {
  const night = theme === "night";
  return (
    <>
      {night ? (
        <>
          <color attach="background" args={[NIGHT_SKY]} />
          <Stars radius={1400} depth={300} count={5000} factor={9} saturation={0.1} fade speed={0.4} />
          <fog attach="fog" args={[NIGHT_FOG, 240, 900]} />
          <hemisphereLight args={["#2d3d6b", "#07090f", 0.7]} />
          <directionalLight castShadow position={[-80, 150, 60]} intensity={0.55} color="#a9c1ff" {...SHADOW} />
        </>
      ) : (
        <>
          <Sky distance={4500} sunPosition={[140, 90, 60]} turbidity={5} rayleigh={1.1} mieCoefficient={0.004} mieDirectionalG={0.82} />
          <fog attach="fog" args={[SKY_FOG, 260, 900]} />
          <hemisphereLight args={["#e4eef7", "#56693f", 0.9]} />
          <directionalLight castShadow position={[90, 140, 55]} intensity={2.4} color="#fff4e2" {...SHADOW} />
        </>
      )}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.04, 0]} renderOrder={-2} receiveShadow raycast={() => null}>
        <circleGeometry args={[900, 72]} />
        <meshStandardMaterial color={night ? "#3b4a37" : "#5f7d45"} roughness={1} />
      </mesh>
    </>
  );
}
