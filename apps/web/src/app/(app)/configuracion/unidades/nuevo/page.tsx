import type { Metadata } from "next";
import { UnitForm } from "@/components/masters/settings";

export const metadata: Metadata = { title: "Nueva unidad · Unidades de medida" };

export default function Page() {
  return <UnitForm />;
}
