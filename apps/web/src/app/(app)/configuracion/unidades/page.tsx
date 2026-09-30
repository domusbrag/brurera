import type { Metadata } from "next";
import { UnitList } from "@/components/masters/settings";

export const metadata: Metadata = { title: "Unidades de medida" };

export default function Page() {
  return <UnitList />;
}
