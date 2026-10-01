import type { Metadata } from "next";
import { SupplierForm } from "@/components/masters/suppliers";

export const metadata: Metadata = { title: "Nuevo proveedor · Proveedores" };

export default function Page() {
  return <SupplierForm />;
}
