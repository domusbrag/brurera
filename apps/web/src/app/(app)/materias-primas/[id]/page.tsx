import type { Metadata } from "next";
import { RawMaterialDetail } from "@/components/masters/items";

export const metadata: Metadata = { title: "Materias primas" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RawMaterialDetail id={id} />;
}
