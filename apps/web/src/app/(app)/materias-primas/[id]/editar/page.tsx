import type { Metadata } from "next";
import { RawMaterialForm } from "@/components/masters/items";

export const metadata: Metadata = { title: "Editar materia prima · Materias primas" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RawMaterialForm id={id} />;
}
