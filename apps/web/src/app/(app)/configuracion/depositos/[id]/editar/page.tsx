import type { Metadata } from "next";
import { WarehouseForm } from "@/components/masters/settings";

export const metadata: Metadata = { title: "Editar depósito · Depósitos" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <WarehouseForm id={id} />;
}
