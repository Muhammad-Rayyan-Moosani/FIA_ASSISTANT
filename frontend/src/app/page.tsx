import type { Metadata } from "next";
import { Landing } from "@/components/landing/Landing";

export const metadata: Metadata = { title: "Upload your circuit" };

export default function Home() {
  return <Landing />;
}
