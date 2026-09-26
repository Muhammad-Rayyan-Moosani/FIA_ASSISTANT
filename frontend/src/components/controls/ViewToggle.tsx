"use client";

import { SegmentedControl } from "@/components/ui/SegmentedControl";
import type { MapView } from "@/store/uiStore";

export function ViewToggle({ value, onChange, webgl }: { value: MapView; onChange: (v: MapView) => void; webgl: boolean | null }) {
  return (
    <SegmentedControl
      label="Map view"
      value={value}
      onChange={onChange}
      options={[
        { value: "3d", label: "3D", disabled: webgl === false, title: webgl === false ? "3D needs WebGL, which this browser doesn't provide" : "3D digital twin" },
        { value: "2d", label: "2D", title: "Flat map" },
      ]}
    />
  );
}
