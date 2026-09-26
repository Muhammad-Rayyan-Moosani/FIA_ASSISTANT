import { BoxGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial } from "three";

/**
 * Low-poly F1 car built from real proportions (metres): 5.6 m long, 2.0 m wide, 0.95 m tall.
 * Local frame: +z forward, +x left, y up, origin at road level under the car's centre.
 */
const WHEEL = new CylinderGeometry(0.36, 0.36, 0.38, 14).rotateZ(Math.PI / 2);
const TUB = new BoxGeometry(0.9, 0.55, 4.6);
const NOSE = new BoxGeometry(0.4, 0.3, 1.0);
const PODS = new BoxGeometry(1.7, 0.45, 1.9);
const FRONT_WING = new BoxGeometry(1.9, 0.08, 0.5);
const REAR_WING = new BoxGeometry(1.0, 0.35, 0.3);
const HALO = new BoxGeometry(0.5, 0.25, 0.7);
const TYRE_MAT = new MeshStandardMaterial({ color: "#151515", roughness: 0.9 });
const CARBON_MAT = new MeshStandardMaterial({ color: "#1d1f23", roughness: 0.5, metalness: 0.3 });

export const LIVERIES = ["#c8102e", "#e8e8e8", "#ff8000", "#1e41ff", "#00a19b", "#f6c700"] as const;

export function createCar(livery: string, metresToUnits: number): Group {
  const paint = new MeshStandardMaterial({ color: livery, roughness: 0.35, metalness: 0.4 });
  const car = new Group();
  const add = (geo: BoxGeometry | CylinderGeometry, mat: MeshStandardMaterial, x: number, y: number, z: number) => {
    const m = new Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    car.add(m);
    return m;
  };
  add(TUB, paint, 0, 0.42, 0);
  add(NOSE, paint, 0, 0.3, 2.75);
  add(PODS, paint, 0, 0.4, -0.3);
  add(FRONT_WING, CARBON_MAT, 0, 0.12, 3.05);
  add(REAR_WING, CARBON_MAT, 0, 0.95, -2.4);
  add(HALO, CARBON_MAT, 0, 0.8, 0.5);
  for (const [x, z] of [[0.82, 1.75], [-0.82, 1.75], [0.82, -1.7], [-0.82, -1.7]] as const) add(WHEEL, TYRE_MAT, x, 0.36, z);
  car.scale.setScalar(metresToUnits);
  return car;
}

/** Dispose per-car materials (shared geometry and tyre/carbon materials stay alive for reuse). */
export function disposeCar(car: Group): void {
  car.traverse((o) => {
    if (o instanceof Mesh && o.material !== TYRE_MAT && o.material !== CARBON_MAT) (o.material as MeshStandardMaterial).dispose();
  });
}
