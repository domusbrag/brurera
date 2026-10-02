import type { Metadata } from "next";
import { EditSale } from "@/components/sales/sale-form";

export const metadata: Metadata = { title: "Editar venta · Ventas" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EditSale id={id} />;
}
