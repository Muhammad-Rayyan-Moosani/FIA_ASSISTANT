import { redirect } from "next/navigation";

/** Race control and insurance share one map now. */
export default function LegacyPage() {
  redirect("/circuit");
}
