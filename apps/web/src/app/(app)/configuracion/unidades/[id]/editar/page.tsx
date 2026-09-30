import type { Metadata } from "next";
import { UnitForm } from "@/components/masters/settings";

export const metadata: Metadata = { title: "Editar unidad · Unidades de medida" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <UnitForm id={id} />;
}
