import type { Metadata } from "next";
import { FiaWorkspace } from "@/components/workspace/FiaWorkspace";

export const metadata: Metadata = { title: "FIA" };

export default function FiaPage() {
  return <FiaWorkspace />;
}
