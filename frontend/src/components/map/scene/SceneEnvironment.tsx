"use client";

import { Sky } from "@react-three/drei";
import { SKY_FOG } from "./sceneTypes";

/** Daylight: physical sky, sun with soft shadows, sky/ground bounce light, grass ground and haze. */
export function SceneEnvironment() {
  return (
    <>
      <Sky distance={4500} sunPosition={[140, 90, 60]} turbidity={5} rayleigh={1.1} mieCoefficient={0.004} mieDirectionalG={0.82} />
      <fog attach="fog" args={[SKY_FOG, 260, 760]} />
      <hemisphereLight args={["#e4eef7", "#56693f", 0.9]} />
      <directionalLight
        castShadow
        position={[90, 140, 55]}
        intensity={2.4}
        color="#fff4e2"
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0004}
        shadow-camera-left={-90}
        shadow-camera-right={90}
        shadow-camera-top={90}
        shadow-camera-bottom={-90}
        shadow-camera-near={10}
        shadow-camera-far={400}
      />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.04, 0]} renderOrder={-2} receiveShadow raycast={() => null}>
        <circleGeometry args={[900, 72]} />
        <meshStandardMaterial color="#5f7d45" roughness={1} />
      </mesh>
    </>
  );
}
