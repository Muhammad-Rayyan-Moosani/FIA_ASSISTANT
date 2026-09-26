import type { Metadata } from "next";
import { InsuranceWorkspace } from "@/components/workspace/InsuranceWorkspace";

export const metadata: Metadata = { title: "Insurance risk map" };

export default function InsurancePage() {
  return <InsuranceWorkspace />;
}
