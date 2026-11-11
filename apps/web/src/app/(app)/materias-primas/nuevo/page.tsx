import type { Metadata } from "next";
import { RawMaterialForm } from "@/components/masters/items";

export const metadata: Metadata = { title: "Nueva materia prima · Materias primas" };

export default function Page() {
  return <RawMaterialForm />;
}
