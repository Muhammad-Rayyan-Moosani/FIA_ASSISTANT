import Image from "next/image";
import { Button } from "@/components/ui/Button";
import { formatNumber } from "@/lib/format";
import type { DemoVisionResult, HazardType } from "@/types/fia";

const HAZARD_TEXT: Partial<Record<HazardType, string>> = {
  water_sheen: "text-src-measured",
  oil_streak: "text-src-assumed",
  debris: "text-risk-high",
};

interface VisionPanelProps {
  result: DemoVisionResult | undefined;
  isPending: boolean;
  error: string | null;
  onRun: () => void;
  elapsedMs: number | null;
}

/** Camera frame flattened by a homography, surface hazards segmented and mapped to track metres. */
export function VisionPanel({ result, isPending, error, onRun, elapsedMs }: VisionPanelProps) {
  return (
    <section className="grid gap-3 rounded-xl border border-line bg-panel p-4" aria-labelledby="vision-title">
      <header className="flex flex-wrap items-center gap-3">
        <h2 id="vision-title" className="eyebrow mr-auto">Camera check · homography → segmentation</h2>
        {result && (
          <span className="num text-[11.5px] text-muted">
            {result.detector} · {result.camera_size_px.join("×")} → {result.overhead_size_px.join("×")} px
            {elapsedMs !== null && ` · ${formatNumber(elapsedMs)} ms`}
          </span>
        )}
        <Button variant="primary" size="sm" onClick={onRun} disabled={isPending}>
          {isPending ? "Checking…" : "Run camera check"}
        </Button>
      </header>
      <p className="-mt-1.5 text-xs text-faint">
        A marshal-post camera sees the braking zone at an angle. The frame is flattened into a top-down map in real metres, then oil, water and debris are segmented and fused with the telemetry alerts.
      </p>
      {error && <p className="text-[12.5px] text-risk-crit">{error}</p>}
      {result?.camera_png_b64 && result.overhead_png_b64 && (
        <div className="grid grid-cols-[1.6fr_1fr] gap-3 max-md:grid-cols-1">
          <figure className="m-0">
            <Image
              unoptimized
              src={`data:image/png;base64,${result.camera_png_b64}`}
              width={result.camera_size_px[0]}
              height={result.camera_size_px[1]}
              alt="Camera frame with detected hazards outlined"
              className="h-auto w-full rounded-lg"
            />
            <figcaption className="mt-1 text-[11.5px] text-muted">Camera frame: white = homography quad, boxes projected back from the map</figcaption>
          </figure>
          <figure className="m-0">
            <Image
              unoptimized
              src={`data:image/png;base64,${result.overhead_png_b64}`}
              width={result.overhead_size_px[0]}
              height={result.overhead_size_px[1]}
              alt="Top-down view of the braking zone with segmentation boxes"
              className="h-auto w-full rounded-lg [image-rendering:pixelated]"
            />
            <figcaption className="mt-1 text-[11.5px] text-muted">Flattened top-down map with segmentation boxes</figcaption>
          </figure>
        </div>
      )}
      {result && (
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="text-left text-[11px] text-muted">
              <th className="py-1 font-medium">Hazard</th>
              <th className="py-1 text-right font-medium">Confidence</th>
              <th className="py-1 text-right font-medium">Track x, y</th>
              <th className="py-1 text-right font-medium">Area</th>
            </tr>
          </thead>
          <tbody className="num">
            {result.detections.map((d, i) => (
              <tr key={i} className="border-t border-line-soft">
                <td className={`py-1 ${HAZARD_TEXT[d.hazard_type] ?? ""}`}>{d.hazard_type.replace("_", " ")}</td>
                <td className="py-1 text-right">{d.confidence.toFixed(2)}</td>
                <td className="py-1 text-right">
                  {d.map_coordinates.x.toFixed(1)}, {d.map_coordinates.y.toFixed(1)} m
                </td>
                <td className="py-1 text-right">{d.area_m2.toFixed(1)} m²</td>
              </tr>
            ))}
            {result.detections.length === 0 && (
              <tr>
                <td colSpan={4} className="py-1 text-faint">
                  Nothing detected on the surface.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </section>
  );
}
