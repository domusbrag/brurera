import type { Metadata } from "next";
import { CustomerForm } from "@/components/masters/customers";

export const metadata: Metadata = { title: "Editar cliente · Clientes" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CustomerForm id={id} />;
}
