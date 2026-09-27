import type { Metadata } from "next";
import { UnifiedTrackView } from "@/components/workspace/UnifiedTrackView";

export const metadata: Metadata = { title: "Race control & insurance" };

export default function CircuitPage() {
  return <UnifiedTrackView />;
}
