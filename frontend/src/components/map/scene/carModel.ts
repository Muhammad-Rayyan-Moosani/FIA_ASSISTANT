import { BoxGeometry, CircleGeometry, CylinderGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, SphereGeometry, TorusGeometry, type BufferGeometry, type Material } from "three";

/**
 * Low-poly F1 car from real proportions (metres): 5.6 m long, 2.0 m wide, 0.95 m tall.
 * Local frame: +z forward, +x left, y up, origin at road level under the car's centre.
 *
 * Hierarchy: root → body (rolls and pitches on its suspension) and four wheel pivots (spin about x, the front
 * pair also steers about y). Handles are in `car.userData` as CarParts.
 */
const TYRE_R = 0.36;
const G = {
  tyre: new CylinderGeometry(TYRE_R, TYRE_R, 0.38, 18).rotateZ(Math.PI / 2),
  rim: new CylinderGeometry(0.22, 0.22, 0.4, 10).rotateZ(Math.PI / 2),
  spoke: new BoxGeometry(0.41, 0.34, 0.05),
  floor: new BoxGeometry(1.5, 0.06, 3.9),
  tub: new BoxGeometry(0.72, 0.5, 2.6),
  nose: new CylinderGeometry(0.12, 0.3, 1.5, 8).rotateX(Math.PI / 2),
  pod: new BoxGeometry(0.5, 0.42, 1.7),
  cover: new BoxGeometry(0.55, 0.55, 1.5),
  fin: new BoxGeometry(0.04, 0.35, 1.1),
  intake: new BoxGeometry(0.34, 0.28, 0.4),
  frontWing: new BoxGeometry(1.95, 0.05, 0.55),
  endplate: new BoxGeometry(0.04, 0.26, 0.6),
  rearWing: new BoxGeometry(1.0, 0.05, 0.36),
  rearPlate: new BoxGeometry(0.04, 0.62, 0.5),
  halo: new TorusGeometry(0.34, 0.035, 6, 16, Math.PI).rotateX(-Math.PI / 2),
  helmet: new SphereGeometry(0.16, 12, 10),
  light: new BoxGeometry(0.16, 0.08, 0.04),
  shadow: new CircleGeometry(1, 20).rotateX(-Math.PI / 2).scale(1.25, 1, 3.2),
};
const TYRE_MAT = new MeshStandardMaterial({ color: "#141414", roughness: 0.92 });
const RIM_MAT = new MeshStandardMaterial({ color: "#b9bec4", roughness: 0.35, metalness: 0.8 });
const CARBON_MAT = new MeshStandardMaterial({ color: "#1b1d21", roughness: 0.45, metalness: 0.35 });
const SHADOW_MAT = new MeshBasicMaterial({ color: "#000000", transparent: true, opacity: 0.32, depthWrite: false });
const SHARED: Material[] = [TYRE_MAT, RIM_MAT, CARBON_MAT, SHADOW_MAT];

export const LIVERIES = ["#c8102e", "#e8e8e8", "#ff8000", "#1e41ff", "#00a19b", "#f6c700", "#6c2bd9", "#0b3d91", "#52e252", "#ff87bc"] as const;

export interface CarParts {
  body: Group;
  wheels: Group[];
  front: Group[];
  paint: MeshStandardMaterial;
  rainLight: MeshBasicMaterial;
}

export const carParts = (car: Group): CarParts => car.userData as CarParts;

export function createCar(livery: string, metresToUnits: number): Group {
  const paint = new MeshStandardMaterial({ color: livery, roughness: 0.3, metalness: 0.45, emissive: livery, emissiveIntensity: 0 });
  const helmetMat = new MeshStandardMaterial({ color: "#f2d23c", roughness: 0.3 });
  const rainLight = new MeshBasicMaterial({ color: "#ff2030", toneMapped: false });
  const car = new Group();
  const body = new Group();
  car.add(body);
  const add = (parent: Group, geo: BufferGeometry, mat: Material, x: number, y: number, z: number, cast = true) => {
    const m = new Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = cast;
    parent.add(m);
    return m;
  };
  add(car, G.shadow, SHADOW_MAT, 0, 0.015, 0, false);
  add(body, G.floor, CARBON_MAT, 0, 0.1, -0.1);
  add(body, G.tub, paint, 0, 0.42, 0.55);
  add(body, G.nose, paint, 0, 0.3, 2.45);
  for (const x of [0.62, -0.62]) add(body, G.pod, paint, x, 0.36, -0.2);
  add(body, G.cover, paint, 0, 0.55, -1.2);
  add(body, G.fin, paint, 0, 0.88, -1.45);
  add(body, G.intake, CARBON_MAT, 0, 0.9, -0.2);
  add(body, G.frontWing, CARBON_MAT, 0, 0.1, 3.0);
  for (const x of [0.97, -0.97]) add(body, G.endplate, paint, x, 0.18, 3.0);
  add(body, G.rearWing, paint, 0, 0.98, -2.45);
  for (const x of [0.5, -0.5]) add(body, G.rearPlate, CARBON_MAT, x, 0.72, -2.45);
  add(body, G.halo, CARBON_MAT, 0, 0.78, 0.35);
  add(body, G.helmet, helmetMat, 0, 0.78, 0.1);
  add(body, G.light, rainLight, 0, 0.42, -2.72, false);

  const wheels: Group[] = [];
  const front: Group[] = [];
  for (const [x, z] of [[0.82, 1.75], [-0.82, 1.75], [0.82, -1.65], [-0.82, -1.65]] as const) {
    const pivot = new Group();
    pivot.rotation.order = "YXZ";
    pivot.position.set(x, TYRE_R, z);
    add(pivot, G.tyre, TYRE_MAT, 0, 0, 0);
    add(pivot, G.rim, RIM_MAT, 0, 0, 0, false);
    add(pivot, G.spoke, CARBON_MAT, 0, 0, 0, false);
    car.add(pivot);
    wheels.push(pivot);
    if (z > 0) front.push(pivot);
  }
  car.userData = { body, wheels, front, paint, rainLight } satisfies CarParts;
  car.scale.setScalar(metresToUnits);
  return car;
}

/** Wheel radius in metres (for spin rate = speed / radius). */
export const WHEEL_RADIUS_M = TYRE_R;

/** Dispose per-car materials (shared geometry and materials stay alive for reuse). */
export function disposeCar(car: Group): void {
  const seen = new Set<Material>();
  car.traverse((o) => {
    if (o instanceof Mesh && !SHARED.includes(o.material as Material) && !seen.has(o.material as Material)) {
      seen.add(o.material as Material);
      (o.material as Material).dispose();
    }
  });
}
