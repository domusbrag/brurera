import type { Metadata } from "next";
import { RawMaterialList } from "@/components/masters/items";

export const metadata: Metadata = { title: "Materias primas" };

export default function Page() {
  return <RawMaterialList />;
}
