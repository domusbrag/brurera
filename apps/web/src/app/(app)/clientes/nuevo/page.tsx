import type { Metadata } from "next";
import { CustomerForm } from "@/components/masters/customers";

export const metadata: Metadata = { title: "Nuevo cliente · Clientes" };

export default function Page() {
  return <CustomerForm />;
}
