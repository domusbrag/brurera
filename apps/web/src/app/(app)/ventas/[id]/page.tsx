import type { Metadata } from "next";
import { SaleDetail } from "@/components/sales/sale-pages";

export const metadata: Metadata = { title: "Venta · Ventas" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SaleDetail id={id} />;
}
