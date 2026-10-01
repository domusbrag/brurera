import type { Metadata } from "next";
import { SupplierForm } from "@/components/masters/suppliers";

export const metadata: Metadata = { title: "Editar proveedor · Proveedores" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SupplierForm id={id} />;
}
