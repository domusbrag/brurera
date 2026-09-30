import type { Metadata } from "next";
import { SupplierList } from "@/components/masters/suppliers";

export const metadata: Metadata = { title: "Proveedores" };

export default function Page() {
  return <SupplierList />;
}
