import type { Metadata } from "next";
import { CustomerDetail } from "@/components/masters/customers";

export const metadata: Metadata = { title: "Clientes" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CustomerDetail id={id} />;
}
