import { AdditiveBlending, Color, DoubleSide, ShaderMaterial } from "three";

/**
 * Light rising out of the track edge: brightest at the asphalt, falling off with height, with pulses of light
 * travelling along the zone in the race direction.
 * Includes the logarithmic-depth chunks so it sorts correctly with the rest of the scene.
 */
export function createZoneLightMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uColor: { value: new Color("#ffffff") },
      uTime: { value: 0 },
      uOpacity: { value: 0 },
      uFlow: { value: 1 },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      attribute float aH;
      attribute float aT;
      attribute float aS;
      varying float vH;
      varying float vT;
      varying float vS;
      void main() {
        vH = aH; vT = aT; vS = aS;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform vec3 uColor;
      uniform float uTime;
      uniform float uOpacity;
      uniform float uFlow;
      varying float vH;
      varying float vT;
      varying float vS;
      void main() {
        #include <logdepthbuf_fragment>
        float fall = pow(1.0 - vH, 2.4);
        float core = pow(1.0 - vH, 12.0);
        float flow = mix(1.0, 0.62 + 0.38 * sin(vS * 1.1 - uTime * 5.5), uFlow);
        float ends = smoothstep(0.0, 0.1, vT) * smoothstep(1.0, 0.9, vT);
        float a = (fall * flow + core) * ends * uOpacity;
        gl_FragColor = vec4(uColor * (1.0 + 0.9 * core), a);
      }`,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
  });
}
