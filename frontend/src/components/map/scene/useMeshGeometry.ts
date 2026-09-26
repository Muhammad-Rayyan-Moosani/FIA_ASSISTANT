import { useEffect, useMemo } from "react";
import { BufferAttribute, BufferGeometry } from "three";
import type { MeshData } from "@/lib/trackGeometry";

/** Turn MeshData into a BufferGeometry, disposed when the data changes or the mesh unmounts. */
export function useMeshGeometry(data: MeshData): BufferGeometry {
  const geometry = useMemo(() => {
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(data.positions, 3));
    g.setIndex(data.indices);
    g.computeVertexNormals();
    return g;
  }, [data]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return geometry;
}
