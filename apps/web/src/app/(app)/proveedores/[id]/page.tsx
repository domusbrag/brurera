import type { Metadata } from "next";
import { SupplierDetail } from "@/components/masters/suppliers";

export const metadata: Metadata = { title: "Proveedores" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SupplierDetail id={id} />;
}
